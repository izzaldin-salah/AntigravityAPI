import { createHash, randomBytes } from "node:crypto";

export interface PendingOAuthState {
  sessionId: string;
  codeVerifier: string;
  createdAt: number;
}

export class OAuthStateManager {
  private readonly states = new Map<string, PendingOAuthState>();
  private readonly ttlMs: number;

  constructor(ttlMs: number = 10 * 60 * 1000) {
    this.ttlMs = ttlMs;
  }

  create(sessionId: string): {
    state: string;
    codeVerifier: string;
    codeChallenge: string;
  } {
    this.prune();
    const state = randomBytes(24).toString("base64url");
    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256")
      .update(codeVerifier)
      .digest("base64url");
    const now = Date.now();

    this.states.set(state, {
      sessionId,
      codeVerifier,
      createdAt: now,
    });

    return { state, codeVerifier, codeChallenge };
  }

  consume(
    state: string,
    sessionId: string,
  ): { codeVerifier: string } | null {
    this.prune();
    const entry = this.states.get(state);
    if (!entry) {
      return null;
    }

    // Single-use: delete immediately regardless of outcome
    this.states.delete(state);

    if (Date.now() - entry.createdAt > this.ttlMs) {
      return null;
    }

    if (entry.sessionId !== sessionId) {
      return null;
    }

    return { codeVerifier: entry.codeVerifier };
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.states.entries()) {
      if (now - entry.createdAt > this.ttlMs) {
        this.states.delete(key);
      }
    }
  }
}
