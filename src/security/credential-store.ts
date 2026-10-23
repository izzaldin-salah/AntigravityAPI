/**
 * Encrypted credential persistence for Antigravity OAuth tokens.
 * Owner: antigravity-deployment-agent.
 * Frozen contract: docs/architecture-contract.md §13.6, §15.
 *
 * Implements AES-256-GCM envelope encryption at rest across file and Redis backends.
 * Plaintext credentials never hit disk or Redis unencrypted.
 */
import { CredentialStoreError, encryptEnvelope, decryptEnvelope as decryptSecretEnvelope } from "./credential-crypto";
export { CredentialStoreError } from "./credential-crypto";
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

export interface CredentialStoreLogger {
  warn: (message: string) => void;
  error?: (message: string) => void;
  info?: (message: string) => void;
}

const REDIS_CREDENTIAL_KEY = "antigravity:credentials:v1";

function decryptEnvelope(raw: string, key: string): StoredAntigravityCredentials {
  const parsed = decryptSecretEnvelope(raw,key);
  if(!parsed || typeof parsed !== "object" || !("refreshToken" in parsed) || typeof parsed.refreshToken !== "string" || !parsed.refreshToken.trim()) {
    throw new CredentialStoreError("Invalid credentials payload: refreshToken is required");
  }
  return parsed as StoredAntigravityCredentials;
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
