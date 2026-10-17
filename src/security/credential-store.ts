/**
 * Encrypted credential persistence for Antigravity OAuth tokens.
 * Owner: antigravity-deployment-agent.
 * Frozen contract: docs/architecture-contract.md §13.6, §15.
 *
 * Implements AES-256-GCM envelope encryption at rest across file and Redis backends.
 * Plaintext credentials never hit disk or Redis unencrypted.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  CredentialStore,
  CredentialStoreBackend,
  CredentialStoreHealth,
  StoredAntigravityCredentials,
} from "../types/admin";
import type { CredentialStoreConfig } from "../types/config";
import { RedisLite } from "./redis-lite";

export class CredentialStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialStoreError";
  }
}

export interface CredentialStoreLogger {
  warn: (message: string) => void;
  error?: (message: string) => void;
  info?: (message: string) => void;
}

const REDIS_CREDENTIAL_KEY = "antigravity:credentials:v1";

interface EncryptionEnvelope {
  v: 1;
  kdf: "scrypt";
  salt: string;
  iv: string;
  tag: string;
  data: string;
}

function deriveKey(rawKey: string, salt: Buffer): Buffer {
  const trimmed = rawKey.trim();
  try {
    if (/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) {
      const decoded = Buffer.from(trimmed, "base64");
      if (decoded.length === 32) {
        return decoded;
      }
    }
  } catch {
    // fallback to scrypt
  }
  return crypto.scryptSync(trimmed, salt, 32);
}

function encryptEnvelope(
  credentials: StoredAntigravityCredentials,
  encryptionKey: string,
): string {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(encryptionKey, salt);

  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(credentials), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  const envelope: EncryptionEnvelope = {
    v: 1,
    kdf: "scrypt",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: ciphertext.toString("base64"),
  };

  return JSON.stringify(envelope);
}

function decryptEnvelope(
  rawContent: string,
  encryptionKey: string,
): StoredAntigravityCredentials {
  let envelope: EncryptionEnvelope;
  try {
    const text = rawContent.trim();
    const jsonStr = text.startsWith("{")
      ? text
      : Buffer.from(text, "base64").toString("utf8");
    envelope = JSON.parse(jsonStr) as EncryptionEnvelope;
  } catch {
    throw new CredentialStoreError("Corrupted credential envelope: invalid JSON format");
  }

  if (
    envelope.v !== 1 ||
    !envelope.salt ||
    !envelope.iv ||
    !envelope.tag ||
    !envelope.data
  ) {
    throw new CredentialStoreError(
      "Corrupted credential envelope: missing required fields",
    );
  }

  try {
    const salt = Buffer.from(envelope.salt, "base64");
    const iv = Buffer.from(envelope.iv, "base64");
    const tag = Buffer.from(envelope.tag, "base64");
    const ciphertext = Buffer.from(envelope.data, "base64");

    const key = deriveKey(encryptionKey, salt);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const parsed = JSON.parse(decrypted.toString("utf8")) as Record<string, unknown>;

    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.refreshToken !== "string" ||
      !parsed.refreshToken.trim()
    ) {
      throw new CredentialStoreError(
        "Invalid credentials payload: refreshToken is required",
      );
    }

    return parsed as unknown as StoredAntigravityCredentials;
  } catch (err: unknown) {
    if (err instanceof CredentialStoreError) {
      throw err;
    }
    throw new CredentialStoreError(
      "Failed to decrypt credentials: wrong key or corrupted data",
    );
  }
}

export function createCredentialStore(
  config: CredentialStoreConfig,
  _logger?: CredentialStoreLogger,
): CredentialStore {
  const encryptionKey = config.encryptionKey?.trim();
  const filePath = config.filePath;
  const redisUrl = config.redisUrl?.trim();

  const resolvedBackend: CredentialStoreBackend =
    config.backend === "redis"
      ? "redis"
      : config.backend === "file"
        ? "file"
        : redisUrl
          ? "redis"
          : "file";

  let cached: StoredAntigravityCredentials | null = null;
  let redisClient: RedisLite | null = null;

  function getRedis(): RedisLite {
    if (!redisClient) {
      if (!redisUrl) {
        throw new CredentialStoreError("REDIS_URL is required for redis backend");
      }
      redisClient = new RedisLite(redisUrl);
    }
    return redisClient;
  }

  function assertKey(): string {
    if (!encryptionKey) {
      throw new CredentialStoreError(
        "CREDENTIAL_ENCRYPTION_KEY is required to persist credentials",
      );
    }
    return encryptionKey;
  }

  return {
    backend: resolvedBackend,

    async load(): Promise<StoredAntigravityCredentials | null> {
      const key = assertKey();

      if (resolvedBackend === "redis") {
        const client = getRedis();
        const raw = await client.get(REDIS_CREDENTIAL_KEY);
        if (!raw) {
          cached = null;
          return null;
        }
        const credentials = decryptEnvelope(raw, key);
        cached = credentials;
        return credentials;
      }

      // file backend
      try {
        const raw = await fs.readFile(filePath, "utf8");
        const credentials = decryptEnvelope(raw, key);
        cached = credentials;
        return credentials;
      } catch (err: unknown) {
        if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
          cached = null;
          return null;
        }
        if (err instanceof CredentialStoreError) {
          throw err;
        }
        throw new CredentialStoreError(
          `Failed to load credentials from file: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },

    async save(credentials: StoredAntigravityCredentials): Promise<void> {
      const key = assertKey();
      if (!credentials || typeof credentials.refreshToken !== "string" || !credentials.refreshToken.trim()) {
        throw new CredentialStoreError(
          "Invalid credentials payload: refreshToken is required",
        );
      }

      const envelopeText = encryptEnvelope(credentials, key);

      if (resolvedBackend === "redis") {
        const client = getRedis();
        await client.set(REDIS_CREDENTIAL_KEY, envelopeText);
        cached = { ...credentials };
        return;
      }

      // file backend
      const parentDir = path.dirname(filePath);
      await fs.mkdir(parentDir, { recursive: true });
      await fs.writeFile(filePath, envelopeText, "utf8");
      try {
        await fs.chmod(filePath, 0o600);
      } catch {
        // Best-effort chmod 0600 on Windows/unsupported filesystems
      }
      cached = { ...credentials };
    },

    async clear(): Promise<void> {
      cached = null;

      if (resolvedBackend === "redis") {
        if (redisUrl) {
          const client = getRedis();
          await client.del(REDIS_CREDENTIAL_KEY);
        }
        return;
      }

      // file backend
      try {
        await fs.unlink(filePath);
      } catch (err: unknown) {
        if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
          // already clear
          return;
        }
        // best effort on other errors
      }
    },

    async health(): Promise<CredentialStoreHealth> {
      if (!encryptionKey) {
        return {
          ok: false,
          backend: resolvedBackend,
          detail: "CREDENTIAL_ENCRYPTION_KEY is required to persist credentials",
        };
      }

      if (resolvedBackend === "redis") {
        if (!redisUrl) {
          return {
            ok: false,
            backend: "redis",
            detail: "REDIS_URL is required for redis backend",
          };
        }
        try {
          const probe = new RedisLite(redisUrl, {
            connectTimeoutMs: 2000,
            commandTimeoutMs: 2000,
          });
          await probe.ping();
          await probe.close();
          return { ok: true, backend: "redis" };
        } catch (err: unknown) {
          return {
            ok: false,
            backend: "redis",
            detail: err instanceof Error ? err.message : String(err),
          };
        }
      }

      // file backend
      try {
        const parentDir = path.dirname(filePath);
        await fs.mkdir(parentDir, { recursive: true });
        await fs.access(parentDir, fs.constants.R_OK | fs.constants.W_OK);
        return { ok: true, backend: "file" };
      } catch (err: unknown) {
        return {
          ok: false,
          backend: "file",
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}
