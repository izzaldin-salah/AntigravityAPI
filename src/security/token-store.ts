/**
 * Token and credential store helper with file cache support.
 * Owner: antigravity-deployment-agent.
 * Frozen contract: docs/architecture-contract.md (§6, §9), src/types/config.ts.
 *
 * NOTE ON RENDER FREE EPHEMERAL FILESYSTEM:
 * Free web instances on Render use an ephemeral root filesystem. Any file written
 * to disk (including the cache file at ANTIGRAVITY_TOKEN_STORE_PATH) is lost
 * whenever the instance sleeps (after ~15 minutes of inactivity), restarts, or redeploys.
 * Therefore:
 * 1. Environment variables set in the Render dashboard (e.g. ANTIGRAVITY_REFRESH_TOKEN)
 *    are the SINGLE PERSISTENT SOURCE OF TRUTH.
 * 2. The token store file functions strictly as an opportunistic runtime cache for
 *    the active container lifecycle.
 * 3. File operations must be best-effort: failure to write or read disk cache must
 *    never crash the gateway or prevent it from serving requests.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { AntigravityCredentials } from "../types/config";

export interface StoredTokenData {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenType?: string;
  scope?: string;
  projectId?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

/**
 * Reads and parses cached tokens from the specified file path.
 * Returns null if the file does not exist, cannot be read, or contains invalid JSON.
 */
export async function loadTokenStore(
  filePath?: string,
): Promise<StoredTokenData | null> {
  if (!filePath || filePath.trim().length === 0) {
    return null;
  }

  try {
    const resolvedPath = path.resolve(filePath);
    const content = await fs.promises.readFile(resolvedPath, "utf-8");
    const parsed = JSON.parse(content) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as StoredTokenData;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Atomically writes token data to disk using a temporary file rename pattern.
 * Creates parent directories if they do not exist.
 * Returns true if the file was written successfully, false otherwise.
 */
export async function saveTokenStore(
  filePath: string,
  data: StoredTokenData,
): Promise<boolean> {
  if (!filePath || filePath.trim().length === 0) {
    return false;
  }

  const resolvedPath = path.resolve(filePath);
  const dir = path.dirname(resolvedPath);
  const tmpPath = path.join(
    dir,
    `.tmp.${path.basename(resolvedPath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`,
  );

  try {
    await fs.promises.mkdir(dir, { recursive: true });
    const payload = JSON.stringify(
      {
        ...data,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    );

    await fs.promises.writeFile(tmpPath, payload, {
      encoding: "utf-8",
      mode: 0o600, // Read/write by owner only
    });

    try {
      await fs.promises.rename(tmpPath, resolvedPath);
    } catch {
      // Fallback for Windows cross-device or locking edge-cases
      await fs.promises.copyFile(tmpPath, resolvedPath);
      await fs.promises.unlink(tmpPath).catch(() => undefined);
    }

    return true;
  } catch {
    // Best-effort cleanup of tmp file if it exists
    await fs.promises.unlink(tmpPath).catch(() => undefined);
    return false;
  }
}

/**
 * Resolves credentials following an environment-first strategy.
 * Configuration/env credentials take precedence over cached disk values.
 */
export function resolveCredentials(
  configCreds?: AntigravityCredentials,
  cachedStore?: StoredTokenData | null,
): AntigravityCredentials {
  return {
    accessToken: configCreds?.accessToken || cachedStore?.accessToken || undefined,
    refreshToken: configCreds?.refreshToken || cachedStore?.refreshToken || undefined,
    clientId: configCreds?.clientId,
    clientSecret: configCreds?.clientSecret,
    projectId: configCreds?.projectId || cachedStore?.projectId || undefined,
    endpoint: configCreds?.endpoint,
    tokenStorePath: configCreds?.tokenStorePath,
  };
}
