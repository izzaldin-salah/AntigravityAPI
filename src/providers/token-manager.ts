import * as fs from "node:fs";
import * as path from "node:path";
import { ProviderError } from "../types/provider";
import type { AntigravityCredentials } from "../types/config";

const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const OAUTH_REFRESH_SKEW_MS = 60_000;

export interface TokenManagerOptions {
  credentials: AntigravityCredentials;
  fetch?: typeof fetch;
}

export class TokenManager {
  private accessToken?: string;
  private refreshToken?: string;
  private clientId?: string;
  private clientSecret?: string;
  private projectId?: string;
  private expiresAt?: number;
  private tokenStorePath?: string;
  private fetchImpl: typeof fetch;
  private refreshPromise?: Promise<string>;

  constructor(options: TokenManagerOptions) {
    this.accessToken = options.credentials.accessToken;
    this.refreshToken = options.credentials.refreshToken;
    this.clientId = options.credentials.clientId;
    this.clientSecret = options.credentials.clientSecret;
    this.projectId = options.credentials.projectId;
    this.tokenStorePath = options.credentials.tokenStorePath;
    this.fetchImpl = options.fetch ?? globalThis.fetch;

    this.tryLoadFromTokenStore();
  }

  getProjectId(): string | undefined {
    return this.projectId;
  }

  async getAccessToken(signal?: AbortSignal): Promise<string> {
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

  private async performRefresh(signal?: AbortSignal): Promise<string> {
    if (!this.refreshToken) {
      throw new ProviderError({
        code: "unauthorized",
        message: "No refresh token available for Antigravity OAuth.",
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
      response = await this.fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
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
        throw new ProviderError({
          code: "unauthorized",
          message: `OAuth token refresh rejected with status ${status}. Re-authentication required.`,
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

    // Persist to disk best-effort
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
