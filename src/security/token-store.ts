/**
 * Encrypted opportunistic token cache. Uses the account store's AES-GCM format,
 * with a distinct payload discriminator. Never falls back to plaintext writes.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { AntigravityCredentials } from "../types/config";
import { encryptEnvelope, decryptEnvelope } from "./credential-crypto";

export interface StoredTokenData {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenType?: string;
  scope?: string;
  projectId?: string;
  updatedAt?: string;
}
export interface TokenStoreOptions {
  encryptionKey?: string;
  warn?: (message: string) => void;
}
const writes = new Map<string, Promise<unknown>>();
const CACHE_KIND = "antigravity-token-cache";
function warning(options: TokenStoreOptions, message: string) {
  try {
    options.warn?.(message);
  } catch {
    /* logging must not break optional cache */
  }
}
function validTokens(value: unknown): StoredTokenData {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid cache");
  const source = value as Record<string, unknown>;
  const data: Record<string, unknown> = {};
  for (const field of [
    "accessToken",
    "refreshToken",
    "tokenType",
    "scope",
    "projectId",
    "updatedAt",
  ]) {
    if (source[field] !== undefined) {
      if (typeof source[field] !== "string") throw Error("Invalid cache field");
      data[field] = source[field];
    }
  }
  if (source.expiresAt !== undefined) {
    if (
      typeof source.expiresAt !== "number" ||
      !Number.isFinite(source.expiresAt) ||
      source.expiresAt < 0
    )
      throw Error("Invalid expiry");
    data.expiresAt = source.expiresAt;
  }
  if (!data.accessToken && !data.refreshToken)
    throw Error("Cache contains no tokens");
  return data as StoredTokenData;
}
function decode(
  raw: string,
  key: string,
): { data: StoredTokenData; legacy: boolean } {
  const parsed: unknown = JSON.parse(raw);
  if (parsed && typeof parsed === "object" && "v" in parsed) {
    const payload = decryptEnvelope(raw, key);
    if (
      !payload ||
      typeof payload !== "object" ||
      !("kind" in payload) ||
      payload.kind !== CACHE_KIND ||
      !("tokens" in payload)
    )
      throw Error("Wrong cache kind");
    return { data: validTokens(payload.tokens), legacy: false };
  }
  return { data: validTokens(parsed), legacy: true };
}
async function readRaw(file: string): Promise<string | null> {
  try {
    if ((await fs.promises.stat(file)).size > 1024 * 1024)
      throw Error("Oversized token cache");
    return await fs.promises.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
async function serial<T>(file: string, work: () => Promise<T>): Promise<T> {
  const previous = writes.get(file) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(work);
  writes.set(file, next);
  try {
    return await next;
  } finally {
    if (writes.get(file) === next) writes.delete(file);
  }
}
async function atomicSave(
  file: string,
  data: StoredTokenData,
  key: string,
): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(
    path.dirname(file),
    ".token-cache-" + randomUUID() + ".tmp",
  );
  try {
    const payload = encryptEnvelope({ kind: CACHE_KIND, tokens: data }, key);
    await fs.promises.writeFile(temporary, payload, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    // Verify the persisted candidate BEFORE replacing the recoverable original.
    const verified = decode(await fs.promises.readFile(temporary, "utf8"), key);
    if (JSON.stringify(verified.data) !== JSON.stringify(data))
      throw Error("Cache verification failed");
    await fs.promises.rename(temporary, file);
  } finally {
    await fs.promises.unlink(temporary).catch(() => undefined);
  }
}
export async function loadTokenStore(
  filePath?: string,
  options: TokenStoreOptions = {},
): Promise<StoredTokenData | null> {
  if (!filePath?.trim()) return null;
  if (!options.encryptionKey?.trim()) {
    warning(
      options,
      "Token disk cache disabled: encryption key is not configured; using memory only.",
    );
    return null;
  }
  const file = path.resolve(filePath);
  return serial(file, async () => {
    try {
      const raw = await readRaw(file);
      if (raw === null) return null;
      const { data, legacy } = decode(raw, options.encryptionKey!);
      if (legacy) await atomicSave(file, data, options.encryptionKey!);
      return data;
    } catch {
      warning(
        options,
        "Token cache could not be loaded or migrated; existing data was preserved.",
      );
      return null;
    }
  });
}
export async function saveTokenStore(
  filePath: string,
  data: StoredTokenData,
  options: TokenStoreOptions = {},
): Promise<boolean> {
  if (!filePath?.trim()) return false;
  if (!options.encryptionKey?.trim()) {
    warning(
      options,
      "Token disk cache disabled: encryption key is not configured; using memory only.",
    );
    return false;
  }
  const file = path.resolve(filePath);
  return serial(file, async () => {
    try {
      const previous = await readRaw(file);
      // Do not overwrite a corrupted record, another store's record, or wrong-key data.
      if (previous !== null) decode(previous, options.encryptionKey!);
      const tokens = validTokens({
        ...data,
        updatedAt: new Date().toISOString(),
      });
      await atomicSave(file, tokens, options.encryptionKey!);
      return true;
    } catch {
      warning(
        options,
        "Token cache could not be saved; existing data was preserved.",
      );
      return false;
    }
  });
}
export async function clearTokenStore(
  filePath?: string,
  options: TokenStoreOptions = {},
): Promise<void> {
  if (!filePath?.trim()) return;
  const file = path.resolve(filePath);
  await serial(file, async () => {
    try {
      const raw = await readRaw(file);
      if (raw === null) return;
      decode(raw, options.encryptionKey ?? ""); // Never delete another store's record.
      await fs.promises.unlink(file);
    } catch {
      warning(
        options,
        "Token cache could not be cleared; existing data was preserved.",
      );
    }
  });
}
export function resolveCredentials(
  configCreds?: AntigravityCredentials,
  cachedStore?: StoredTokenData | null,
): AntigravityCredentials {
  return {
    accessToken:
      configCreds?.accessToken || cachedStore?.accessToken || undefined,
    refreshToken:
      configCreds?.refreshToken || cachedStore?.refreshToken || undefined,
    clientId: configCreds?.clientId,
    clientSecret: configCreds?.clientSecret,
    projectId: configCreds?.projectId || cachedStore?.projectId || undefined,
    endpoint: configCreds?.endpoint,
    tokenStorePath: configCreds?.tokenStorePath,
  };
}
