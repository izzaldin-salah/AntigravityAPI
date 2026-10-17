/**
 * STUB — owner: antigravity-deployment-agent (harden during the v1.1
 * dashboard wave: sliding expiry, cleanup, cap, explicit tests).
 *
 * Minimal working in-memory session store so all zones compile from
 * commit zero. Frozen seam: docs/architecture-contract.md §15.
 */
import { randomBytes } from "node:crypto";
import type { SessionRecord, SessionStore } from "../types/admin";

export function createSessionStore(): SessionStore {
  const sessions = new Map<string, SessionRecord>();

  return {
    async create(ttlMs: number): Promise<SessionRecord> {
      const now = Date.now();
      const record: SessionRecord = {
        id: randomBytes(32).toString("base64url"),
        csrfToken: randomBytes(32).toString("base64url"),
        createdAt: now,
        expiresAt: now + ttlMs,
      };
      sessions.set(record.id, record);
      return record;
    },
    async get(id: string): Promise<SessionRecord | null> {
      const record = sessions.get(id);
      if (!record) return null;
      if (record.expiresAt <= Date.now()) {
        sessions.delete(id);
        return null;
      }
      return record;
    },
    async destroy(id: string): Promise<void> {
      sessions.delete(id);
    },
  };
}
