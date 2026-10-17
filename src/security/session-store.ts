/**
 * In-memory session store for the Account Management Dashboard.
 * Owner: antigravity-deployment-agent.
 * Frozen seam: docs/architecture-contract.md §13, §15.
 *
 * Implements sliding expiry, bounded session cap with soonest-expiring eviction,
 * and crypto-secure session & CSRF tokens.
 */
import { randomBytes } from "node:crypto";
import type { SessionRecord, SessionStore } from "../types/admin";

interface SessionEntry {
  record: SessionRecord;
  ttlMs: number;
}

export interface SessionStoreOptions {
  maxSessions?: number;
}

export function createSessionStore(options?: SessionStoreOptions): SessionStore {
  const maxSessions = options?.maxSessions ?? 1000;
  const sessions = new Map<string, SessionEntry>();

  function pruneExpired(now: number): void {
    for (const [id, entry] of sessions.entries()) {
      if (entry.record.expiresAt <= now) {
        sessions.delete(id);
      }
    }
  }

  function evictSoonestExpiring(): void {
    let oldestId: string | null = null;
    let minExpiresAt = Infinity;

    for (const [id, entry] of sessions.entries()) {
      if (entry.record.expiresAt < minExpiresAt) {
        minExpiresAt = entry.record.expiresAt;
        oldestId = id;
      }
    }

    if (oldestId) {
      sessions.delete(oldestId);
    }
  }

  return {
    async create(ttlMs: number): Promise<SessionRecord> {
      const now = Date.now();

      // Lazy prune expired sessions first
      pruneExpired(now);

      // If at or above capacity, evict the soonest-expiring session
      while (sessions.size >= maxSessions && sessions.size > 0) {
        evictSoonestExpiring();
      }

      const record: SessionRecord = {
        id: randomBytes(32).toString("base64url"),
        csrfToken: randomBytes(32).toString("base64url"),
        createdAt: now,
        expiresAt: now + ttlMs,
      };

      sessions.set(record.id, {
        record: { ...record },
        ttlMs,
      });

      return { ...record };
    },

    async get(id: string): Promise<SessionRecord | null> {
      const entry = sessions.get(id);
      if (!entry) return null;

      const now = Date.now();
      if (entry.record.expiresAt <= now) {
        sessions.delete(id);
        return null;
      }

      // Sliding expiry: extend expiresAt = now + ttlMs
      entry.record.expiresAt = now + entry.ttlMs;
      return { ...entry.record };
    },

    async destroy(id: string): Promise<void> {
      sessions.delete(id);
    },
  };
}
