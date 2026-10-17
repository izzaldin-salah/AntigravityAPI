/**
 * FROZEN SHARED CONTRACT — coordinator-owned (see docs/architecture-contract.md §13–§16).
 * Account-management dashboard types shared by the provider, API and deployment layers.
 * NEVER add token/secret values to any payload type here that is serialized to clients.
 */

/** Credentials as persisted by the CredentialStore (encrypted at rest by the store). */
export interface StoredAntigravityCredentials {
  refreshToken: string;
  clientId?: string;
  clientSecret?: string;
  projectId?: string;
  /** Human-readable hint (e.g. masked email) — NEVER a token. */
  accountHint?: string;
  /** Epoch ms when these credentials were last written. */
  updatedAt: number;
}

export type CredentialStoreBackend = "file" | "redis" | "memory";

export interface CredentialStoreHealth {
  ok: boolean;
  backend: CredentialStoreBackend;
  detail?: string;
}

export interface CredentialStore {
  readonly backend: CredentialStoreBackend;
  load(): Promise<StoredAntigravityCredentials | null>;
  save(credentials: StoredAntigravityCredentials): Promise<void>;
  clear(): Promise<void>;
  health(): Promise<CredentialStoreHealth>;
}

export interface SessionRecord {
  id: string;
  csrfToken: string;
  createdAt: number;
  expiresAt: number;
}

export interface SessionStore {
  create(ttlMs: number): Promise<SessionRecord>;
  /** Sliding expiry; `null` when unknown/expired. */
  get(id: string): Promise<SessionRecord | null>;
  destroy(id: string): Promise<void>;
}

/** Result of an OAuth code exchange or refresh test (server-side only). */
export interface OAuthTokenResult {
  refreshToken: string;
  accessToken?: string;
  expiresIn?: number;
  projectId?: string;
  /** Masked identity hint (never a token). */
  accountHint?: string;
}

export interface OAuthServiceOptions {
  clientId?: string;
  clientSecret?: string;
  scopes: string[];
  /** Test seam; defaults to the Google authorize endpoint. */
  authEndpoint?: string;
  /** Test seam; defaults to the Google token endpoint. */
  tokenEndpoint?: string;
  fetch?: typeof fetch;
}

export interface OAuthService {
  /** False when no client id is configured — UI shows setup instructions instead. */
  isConfigured(): boolean;
  buildAuthorizeUrl(input: {
    state: string;
    codeChallenge: string;
    redirectUri: string;
  }): string;
  exchangeCode(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<OAuthTokenResult>;
  /** Validates operator-supplied refresh credentials WITHOUT storing them. */
  testRefresh(input: {
    refreshToken: string;
    clientId?: string;
    clientSecret?: string;
  }): Promise<OAuthTokenResult>;
}

/**
 * Account/provider status for the dashboard. Field whitelist ONLY — enforced by tests:
 * a sentinel refresh/access token value must never appear in any serialized response.
 */
export interface AntigravityAccountStatus {
  providerMode: "antigravity";
  /** True when a refresh token or access token is available to the provider. */
  connected: boolean;
  hasRefreshToken: boolean;
  /** Epoch ms, only when known. */
  accessTokenExpiresAt?: number;
  projectId?: string;
  clientIdMasked?: string;
  accountHint?: string;
  /** Refresh rejected (invalid_grant/401) — operator must reconnect in the dashboard. */
  needsReconnect: boolean;
  lastRefreshAt?: number;
  /** Redacted message only. */
  lastError?: string;
}
