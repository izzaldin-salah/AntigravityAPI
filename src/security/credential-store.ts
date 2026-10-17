/**
 * STUB — owner: antigravity-deployment-agent (replace with the real
 * encrypted file/redis backends during the v1.1 dashboard wave).
 *
 * In-memory placeholder so every zone compiles from commit zero.
 * Frozen seam: docs/architecture-contract.md §15.
 */
import type {
  CredentialStore,
  CredentialStoreHealth,
  StoredAntigravityCredentials,
} from "../types/admin";
import type { CredentialStoreConfig } from "../types/config";

export interface CredentialStoreLogger {
  warn: (message: string) => void;
}

export function createCredentialStore(
  _config: CredentialStoreConfig,
  _logger?: CredentialStoreLogger,
): CredentialStore {
  let cached: StoredAntigravityCredentials | null = null;

  return {
    backend: "memory" as const,
    async load(): Promise<StoredAntigravityCredentials | null> {
      return cached;
    },
    async save(credentials: StoredAntigravityCredentials): Promise<void> {
      cached = { ...credentials };
    },
    async clear(): Promise<void> {
      cached = null;
    },
    async health(): Promise<CredentialStoreHealth> {
      return { ok: true, backend: "memory", detail: "STUB implementation" };
    },
  };
}
