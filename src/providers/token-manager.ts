import * as fs from "node:fs";
import * as path from "node:path";
import type {
  AntigravityAccountStatus,
  CredentialStore,
  StoredAntigravityCredentials,
} from "../types/admin";
import type { AntigravityCredentials } from "../types/config";
import { GOOGLE_OAUTH_TOKEN_ENDPOINT } from "../types/config";
import { ProviderError } from "../types/provider";

const OAUTH_REFRESH_SKEW_MS = 60_000;

export interface TokenManagerOptions {
  credentials?: AntigravityCredentials;
  credentialStore?: CredentialStore;
  tokenEndpoint?: string;
  fetch?: typeof fetch;
}

export class TokenManager {
  private envCredentials?: AntigravityCredentials;
  private credentialStore?: CredentialStore;
  private tokenEndpoint: string;
  private fetchImpl: typeof fetch;

  private accessToken?: string;
  private refreshToken?: string;
  private clientId?: string;
  private clientSecret?: string;
  private projectId?: string;
  private accountHint?: string;
  private expiresAt?: number;
  private tokenStorePath?: string;

  private refreshPromise?: Promise<string>;
  private needsReconnect: boolean = false;
  private lastRefreshAt?: number;
  private lastError?: string;

  private isManuallyMutated: boolean = false;
  private memoryCleared: boolean = false;

  constructor(options: TokenManagerOptions = {}) {
    this.envCredentials = options.credentials;
    this.credentialStore = options.credentialStore;
    this.tokenEndpoint = options.tokenEndpoint ?? GOOGLE_OAUTH_TOKEN_ENDPOINT;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.tokenStorePath = options.credentials?.tokenStorePath;

    if (options.credentials) {
      this.accessToken = options.credentials.accessToken;
      this.refreshToken = options.credentials.refreshToken;
      this.clientId = options.credentials.clientId;
      this.clientSecret = options.credentials.clientSecret;
      this.projectId = options.credentials.projectId;
    }

    this.tryLoadFromTokenStore();
  }

  getProjectId(): string | undefined {
    return this.projectId;
  }

  isNeedsReconnect(): boolean {
    return this.needsReconnect;
  }

  async getAccessToken(signal?: AbortSignal): Promise<string> {
    await this.resolveCredentials();

    if (this.needsReconnect) {
      throw new ProviderError({
        code: "unauthorized",
        message:
          this.lastError ||
          "Antigravity credentials expired or revoked. Reconnect in the admin dashboard (/admin).",
        status: 401,
      });
    }

    if (!this.refreshToken && !this.accessToken) {
      throw new ProviderError({
        code: "unauthorized",
        message: "No Antigravity credentials configured. Connect your account in /admin.",
        status: 401,
      });
    }

    if (this.accessToken && !this.isTokenExpired()) {
      return this.accessToken;
    }

    return this.refreshAccessToken(signal);
  }

  isTokenExpired(): boolean {
    if (!this.accessToken) return true;
    if (this.expiresAt === undefined) return false;
    return Date.now() + OAUTH_REFRESH_SKEW_MS >= this.expiresAt;
  }

  async refreshAccessToken(signal?: AbortSignal): Promise<string> {
    // Single-flight in-progress refresh
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.performRefresh(signal).finally(() => {
      this.refreshPromise = undefined;
    });

    return this.refreshPromise;
  }

  async setCredentials(creds: {
    refreshToken: string;
    clientId?: string;
    clientSecret?: string;
    projectId?: string;
    accountHint?: string;
  }): Promise<void> {
    this.isManuallyMutated = true;
    this.memoryCleared = false;
    this.refreshToken = creds.refreshToken;
    this.clientId = creds.clientId;
    this.clientSecret = creds.clientSecret;
    this.projectId = creds.projectId;
    this.accountHint = creds.accountHint;
    this.accessToken = undefined;
    this.expiresAt = undefined;
    this.needsReconnect = false;
    this.lastError = undefined;

    if (this.credentialStore) {
      await this.credentialStore.save({
        refreshToken: creds.refreshToken,
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
        projectId: creds.projectId,
        accountHint: creds.accountHint,
        updatedAt: Date.now(),
      });
    }
  }

  async clearCredentials(): Promise<void> {
    this.isManuallyMutated = true;
    this.memoryCleared = true;
    this.refreshToken = undefined;
    this.accessToken = undefined;
    this.clientId = undefined;
    this.clientSecret = undefined;
    this.projectId = undefined;
    this.accountHint = undefined;
    this.expiresAt = undefined;
    this.needsReconnect = false;
    this.lastError = undefined;

    if (this.credentialStore) {
      await this.credentialStore.clear();
    }
  }

  async reloadFromStore(): Promise<void> {
    this.isManuallyMutated = true;
    this.memoryCleared = false;
    if (this.credentialStore) {
      const stored = await this.credentialStore.load();
      if (stored) {
        this.applyStoredCredentials(stored);
      } else {
        this.refreshToken = undefined;
        this.accessToken = undefined;
        this.clientId = undefined;
        this.clientSecret = undefined;
        this.projectId = undefined;
        this.accountHint = undefined;
      }
    }
  }

  async getStatus(): Promise<AntigravityAccountStatus> {
    await this.resolveCredentials();

    const connected = Boolean(
      (this.refreshToken && this.refreshToken.trim().length > 0) ||
      (this.accessToken && this.accessToken.trim().length > 0)
    );
    const hasRefreshToken = Boolean(this.refreshToken && this.refreshToken.trim().length > 0);

    let clientIdMasked: string | undefined;
    if (this.clientId && this.clientId.trim().length > 0) {
      const trimmed = this.clientId.trim();
      if (trimmed.length > 12) {
        clientIdMasked = `${trimmed.slice(0, 4)}***${trimmed.slice(-4)}`;
      } else {
        clientIdMasked = "***";
      }
    }

    return {
      providerMode: "antigravity",
      connected,
      hasRefreshToken,
      accessTokenExpiresAt: this.expiresAt,
      projectId: this.projectId,
      clientIdMasked,
      accountHint: this.accountHint,
      needsReconnect: this.needsReconnect,
      lastRefreshAt: this.lastRefreshAt,
      lastError: this.lastError,
    };
  }

  private hasEnvCredentials(): boolean {
    return Boolean(
      (this.envCredentials?.refreshToken && this.envCredentials.refreshToken.trim().length > 0) ||
      (this.envCredentials?.accessToken && this.envCredentials.accessToken.trim().length > 0)
    );
  }

  private async resolveCredentials(): Promise<void> {
    if (this.memoryCleared) {
      return;
    }

    // Priority 1: constructor env credentials if not manually mutated
    if (!this.isManuallyMutated && this.hasEnvCredentials()) {
      return;
    }

    // Priority 2: credentialStore.load()
    if (this.credentialStore) {
      try {
        const stored = await this.credentialStore.load();
        if (stored) {
          if (stored.refreshToken !== this.refreshToken) {
            this.applyStoredCredentials(stored);
          } else {
            this.clientId = stored.clientId;
            this.clientSecret = stored.clientSecret;
            this.projectId = stored.projectId;
            this.accountHint = stored.accountHint;
          }
        } else if (!this.hasEnvCredentials() || this.isManuallyMutated) {
          this.refreshToken = undefined;
          this.accessToken = undefined;
          this.clientId = undefined;
          this.clientSecret = undefined;
          this.projectId = undefined;
          this.accountHint = undefined;
        }
      } catch {
        // Best effort fallback
      }
    }
  }

  private applyStoredCredentials(stored: StoredAntigravityCredentials): void {
    if (this.refreshToken !== stored.refreshToken) {
      this.accessToken = undefined;
      this.expiresAt = undefined;
    }
    this.refreshToken = stored.refreshToken;
    this.clientId = stored.clientId;
    this.clientSecret = stored.clientSecret;
    this.projectId = stored.projectId;
    this.accountHint = stored.accountHint;
    this.needsReconnect = false;
    this.lastError = undefined;
  }

  private async performRefresh(signal?: AbortSignal): Promise<string> {
    await this.resolveCredentials();

    if (!this.refreshToken) {
      throw new ProviderError({
        code: "unauthorized",
        message: "No Antigravity credentials configured. Connect your account in /admin.",
        status: 401,
      });
    }

    const params = new URLSearchParams();
    params.set("grant_type", "refresh_token");
    params.set("refresh_token", this.refreshToken);
    if (this.clientId) {
      params.set("client_id", this.clientId);
    }
    if (this.clientSecret) {
      params.set("client_secret", this.clientSecret);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(this.tokenEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
        signal,
      });
    } catch (err) {
      if (signal?.aborted) {
        throw new ProviderError({
          code: "aborted",
          message: "Token refresh request was aborted.",
        });
      }
      throw new ProviderError({
        code: "upstream_error",
        message: `Network error during token refresh: ${err instanceof Error ? err.message : "unknown error"}`,
        status: 502,
      });
    }

    if (!response.ok) {
      const status = response.status;
      if (status === 400 || status === 401) {
        this.needsReconnect = true;
        this.lastError =
          "Antigravity credentials expired or revoked. Reconnect in the admin dashboard (/admin).";
        throw new ProviderError({
          code: "unauthorized",
          message: this.lastError,
          status: 401,
        });
      }
      throw new ProviderError({
        code: "upstream_error",
        message: `OAuth token endpoint returned status ${status}.`,
        status: 502,
      });
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new ProviderError({
        code: "upstream_error",
        message: "Invalid JSON response from OAuth token endpoint.",
        status: 502,
      });
    }

    if (!data || typeof data !== "object") {
      throw new ProviderError({
        code: "upstream_error",
        message: "Unexpected payload shape from OAuth token endpoint.",
        status: 502,
      });
    }

    const record = data as Record<string, unknown>;
    const newAccessToken = typeof record.access_token === "string" ? record.access_token : undefined;
    if (!newAccessToken) {
      throw new ProviderError({
        code: "upstream_error",
        message: "OAuth token response did not contain access_token.",
        status: 502,
      });
    }

    const expiresInSec = typeof record.expires_in === "number" ? record.expires_in : 3600;
    this.accessToken = newAccessToken;
    this.expiresAt = Date.now() + expiresInSec * 1000;
    this.needsReconnect = false;
    this.lastError = undefined;
    this.lastRefreshAt = Date.now();

    // Persist to disk best-effort if tokenStorePath is used
    this.trySaveToTokenStore();

    return this.accessToken;
  }

  private tryLoadFromTokenStore(): void {
    if (!this.tokenStorePath) return;

    try {
      const fullPath = path.resolve(this.tokenStorePath);
      if (fs.existsSync(fullPath)) {
        const raw = fs.readFileSync(fullPath, "utf-8");
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (typeof parsed.accessToken === "string" && !this.accessToken) {
          this.accessToken = parsed.accessToken;
        }
        if (typeof parsed.refreshToken === "string" && !this.refreshToken) {
          this.refreshToken = parsed.refreshToken;
        }
        if (typeof parsed.expiresAt === "number" && this.expiresAt === undefined) {
          this.expiresAt = parsed.expiresAt;
        }
        if (typeof parsed.projectId === "string" && !this.projectId) {
          this.projectId = parsed.projectId;
        }
      }
    } catch {
      // Best-effort; never throw
    }
  }

  private trySaveToTokenStore(): void {
    if (!this.tokenStorePath) return;

    try {
      const fullPath = path.resolve(this.tokenStorePath);
      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const payload = {
        accessToken: this.accessToken,
        refreshToken: this.refreshToken,
        expiresAt: this.expiresAt,
        projectId: this.projectId,
      };
      fs.writeFileSync(fullPath, JSON.stringify(payload, null, 2), "utf-8");
    } catch {
      // Best-effort; never throw
    }
  }
}
