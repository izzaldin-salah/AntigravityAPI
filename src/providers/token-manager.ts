import { loadTokenStore, saveTokenStore, clearTokenStore, type TokenStoreOptions } from "../security/token-store";
import type {
  AntigravityAccountStatus,
  CredentialStore,
  StoredAntigravityCredentials,
} from "../types/admin";
import type { AntigravityCredentials } from "../types/config";
import { GOOGLE_OAUTH_TOKEN_ENDPOINT } from "../types/config";
import { ProviderError } from "../types/provider";
import { abortable, cancellationReason } from "../core/chat-deadline";

const OAUTH_REFRESH_SKEW_MS = 60_000;

export interface TokenManagerOptions {
  credentials?: AntigravityCredentials;
  credentialStore?: CredentialStore;
  tokenEndpoint?: string;
  fetch?: typeof fetch;
  encryptionKey?: string;
  warn?: (message:string)=>void;
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
  private cacheOptions: TokenStoreOptions;
  private cacheReady: Promise<void>;

  private refreshOperation?: {promise:Promise<string>;controller:AbortController;waiters:number;settled:boolean};
  private credentialGeneration=0;
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
    this.cacheOptions = {encryptionKey:options.encryptionKey,warn:options.warn};

    if (options.credentials) {
      this.accessToken = options.credentials.accessToken;
      this.refreshToken = options.credentials.refreshToken;
      this.clientId = options.credentials.clientId;
      this.clientSecret = options.credentials.clientSecret;
      this.projectId = options.credentials.projectId;
    }

    this.cacheReady = this.loadFromTokenCache();
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
    if(signal?.aborted) throw cancellationReason(signal);
    let operation=this.refreshOperation;
    if(!operation) {
      const controller=new AbortController();
      const current={controller,waiters:0,settled:false,promise:Promise.resolve("")};
      current.promise=this.performRefresh(controller.signal).finally(()=>{
        current.settled=true;
        if(this.refreshOperation===current) this.refreshOperation=undefined;
      });
      operation=current;this.refreshOperation=current;
    }
    operation.waiters++;
    try {
      const sharedSignal=signal?AbortSignal.any([signal,operation.controller.signal]):operation.controller.signal;
      return await abortable(operation.promise,sharedSignal);
    } finally {
      operation.waiters--;
      if(operation.waiters===0 && !operation.settled) {
        operation.controller.abort(new ProviderError({code:"aborted",message:"All refresh callers cancelled."}));
        if(this.refreshOperation===operation) this.refreshOperation=undefined;
      }
    }
  }

  private cancelRefresh():void {
    this.refreshOperation?.controller.abort(new ProviderError({code:"aborted",message:"Credentials changed."}));
    this.refreshOperation=undefined;
  }

  async setCredentials(creds: {
    refreshToken: string;
    clientId?: string;
    clientSecret?: string;
    projectId?: string;
    accountHint?: string;
  }): Promise<void> {
    this.credentialGeneration++;
    this.cancelRefresh();
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
    this.credentialGeneration++;
    this.cancelRefresh();
    await this.cacheReady;
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

    await clearTokenStore(this.tokenStorePath,this.cacheOptions);
    if (this.credentialStore) {
      await this.credentialStore.clear();
    }
  }

  async reloadFromStore(): Promise<void> {
    this.credentialGeneration++;
    this.cancelRefresh();
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
    await this.cacheReady;
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
    const generation=this.credentialGeneration;
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
    if(generation!==this.credentialGeneration || signal?.aborted) {
      throw new ProviderError({code:"aborted",message:"Credentials changed or refresh was cancelled."});
    }
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
    await this.saveToTokenCache();

    return this.accessToken;
  }

  private async loadFromTokenCache(): Promise<void> {
    const cached=await loadTokenStore(this.tokenStorePath,this.cacheOptions);
    if(!cached || this.isManuallyMutated || this.memoryCleared) return;
    // An account store is authoritative; an old opportunistic cache must never
    // resurrect a disconnected dashboard account or cross account identities.
    if(this.credentialStore && !this.hasEnvCredentials()) return;
    const sameIdentity=!this.envCredentials?.refreshToken || this.envCredentials.refreshToken===cached.refreshToken;
    if(!sameIdentity) return;
    this.accessToken ||= cached.accessToken;
    this.refreshToken ||= cached.refreshToken;
    this.projectId ||= cached.projectId;
    if(!this.envCredentials?.accessToken && this.expiresAt===undefined) this.expiresAt=cached.expiresAt;
  }

  private async saveToTokenCache(): Promise<void> {
    if(!this.tokenStorePath) return;
    // Dashboard-managed credentials already use the encrypted account store.
    if(this.credentialStore && !this.hasEnvCredentials()) return;
    await saveTokenStore(this.tokenStorePath,{
      accessToken:this.accessToken,refreshToken:this.refreshToken,
      expiresAt:this.expiresAt,projectId:this.projectId,
    },this.cacheOptions);
  }
}
