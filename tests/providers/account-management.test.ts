import { describe, it, expect, vi } from "vitest";
import { TokenManager } from "../../src/providers/token-manager";
import { AntigravityProvider } from "../../src/providers/antigravity";
import { MockProvider, createProviderFromConfig } from "../../src/providers";
import { ProviderError, type NormalizedChatRequest } from "../../src/types/provider";
import type { CredentialStore, StoredAntigravityCredentials } from "../../src/types/admin";
import type { ProviderConfig } from "../../src/types/config";

function createFakeStore(initial: StoredAntigravityCredentials | null = null): CredentialStore & {
  stored: StoredAntigravityCredentials | null;
} {
  return {
    backend: "memory",
    stored: initial,
    async load() {
      return this.stored ? { ...this.stored } : null;
    },
    async save(credentials: StoredAntigravityCredentials) {
      this.stored = { ...credentials };
    },
    async clear() {
      this.stored = null;
    },
    async health() {
      return { ok: true, backend: "memory" };
    },
  };
}

describe("Account Management & Credential Store Integration", () => {
  it("respects tokenEndpoint override in TokenManager during refresh", async () => {
    let capturedUrl = "";
    const fakeFetch = vi.fn(async (url: string | URL | Request) => {
      capturedUrl = url.toString();
      return new Response(
        JSON.stringify({
          access_token: "token-from-custom-endpoint",
          expires_in: 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const manager = new TokenManager({
      credentials: { refreshToken: "test-refresh-token" },
      tokenEndpoint: "https://auth-test.internal.net/v1/token",
      fetch: fakeFetch as unknown as typeof fetch,
    });

    const token = await manager.getAccessToken();
    expect(token).toBe("token-from-custom-endpoint");
    expect(capturedUrl).toBe("https://auth-test.internal.net/v1/token");
  });

  it("resolves credentials at request time from CredentialStore when env credentials are not configured", async () => {
    const fakeStore = createFakeStore({
      refreshToken: "store-refresh-token-xyz",
      clientId: "store-client-id-abc",
      projectId: "store-project-123",
      accountHint: "u***@domain.com",
      updatedAt: Date.now(),
    });

    const fakeFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          access_token: "access-token-from-store-refresh",
          expires_in: 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const manager = new TokenManager({
      credentialStore: fakeStore,
      fetch: fakeFetch as unknown as typeof fetch,
    });

    const token = await manager.getAccessToken();
    expect(token).toBe("access-token-from-store-refresh");
    expect(manager.getProjectId()).toBe("store-project-123");

    const status = await manager.getStatus();
    expect(status.connected).toBe(true);
    expect(status.hasRefreshToken).toBe(true);
    expect(status.projectId).toBe("store-project-123");
    expect(status.accountHint).toBe("u***@domain.com");
  });

  it("throws unauthorized pointing to /admin when no credentials configured", async () => {
    const manager = new TokenManager();
    await expect(manager.getAccessToken()).rejects.toMatchObject({
      payload: {
        code: "unauthorized",
        message: "No Antigravity credentials configured. Connect your account in /admin.",
      },
    });

    const status = await manager.getStatus();
    expect(status.connected).toBe(false);
    expect(status.hasRefreshToken).toBe(false);
  });

  it("picks up credential swap via CredentialStore without restart", async () => {
    const fakeStore = createFakeStore({
      refreshToken: "token-account-one",
      projectId: "project-one",
      accountHint: "a***@one.com",
      updatedAt: 1000,
    });

    const refreshedTokens: string[] = [];
    const fakeFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const params = new URLSearchParams((init?.body ?? "") as string);
      const rt = params.get("refresh_token") ?? "unknown";
      refreshedTokens.push(rt);

      return new Response(
        JSON.stringify({
          access_token: `access-for-${rt}`,
          expires_in: 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const manager = new TokenManager({
      credentialStore: fakeStore,
      fetch: fakeFetch as unknown as typeof fetch,
    });

    // First request: uses Account One
    const token1 = await manager.getAccessToken();
    expect(token1).toBe("access-for-token-account-one");
    expect(manager.getProjectId()).toBe("project-one");
    expect(refreshedTokens).toEqual(["token-account-one"]);

    // Dynamic credential swap in store without restarting
    fakeStore.stored = {
      refreshToken: "token-account-two",
      projectId: "project-two",
      accountHint: "b***@two.com",
      updatedAt: 2000,
    };

    // Second request: picks up Account Two on next request
    const token2 = await manager.getAccessToken();
    expect(token2).toBe("access-for-token-account-two");
    expect(manager.getProjectId()).toBe("project-two");
    expect(refreshedTokens).toEqual(["token-account-one", "token-account-two"]);

    const status = await manager.getStatus();
    expect(status.accountHint).toBe("b***@two.com");
    expect(status.projectId).toBe("project-two");
  });

  it("handles needsReconnect transitions both ways", async () => {
    let returnReject = true;
    const fakeFetch = vi.fn(async () => {
      if (returnReject) {
        return new Response(
          JSON.stringify({
            error: "invalid_grant",
            error_description: "Token revoked.",
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          access_token: "fresh-reconnected-token",
          expires_in: 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const fakeStore = createFakeStore({
      refreshToken: "bad-refresh-token",
      updatedAt: 100,
    });

    const manager = new TokenManager({
      credentialStore: fakeStore,
      fetch: fakeFetch as unknown as typeof fetch,
    });

    // Initial state: needsReconnect is false
    const initialStatus = await manager.getStatus();
    expect(initialStatus.needsReconnect).toBe(false);

    // Refresh fails: transition to needsReconnect = true
    await expect(manager.getAccessToken()).rejects.toThrowError(ProviderError);

    const errorStatus = await manager.getStatus();
    expect(errorStatus.needsReconnect).toBe(true);
    expect(errorStatus.lastError).toContain("Antigravity credentials expired or revoked. Reconnect in the admin dashboard (/admin).");

    // Subsequent getAccessToken fails fast without network call
    fakeFetch.mockClear();
    await expect(manager.getAccessToken()).rejects.toThrowError(ProviderError);
    expect(fakeFetch).not.toHaveBeenCalled();

    // Transition back to false via loading new credentials from store
    await manager.setCredentials({
      refreshToken: "new-good-refresh-token",
    });

    expect(manager.isNeedsReconnect()).toBe(false);
    const reconnectedStatus = await manager.getStatus();
    expect(reconnectedStatus.needsReconnect).toBe(false);
    expect(reconnectedStatus.lastError).toBeUndefined();

    // Now refresh succeeds
    returnReject = false;
    const freshToken = await manager.getAccessToken();
    expect(freshToken).toBe("fresh-reconnected-token");
    expect(manager.isNeedsReconnect()).toBe(false);
  });

  it("chat() on AntigravityProvider fails fast with ProviderError unauthorized when needsReconnect is true", async () => {
    const fakeFetch = vi.fn(async () => {
      return new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    });

    const provider = new AntigravityProvider(
      { refreshToken: "expired-refresh-token" },
      { fetch: fakeFetch as unknown as typeof fetch },
    );

    const request: NormalizedChatRequest = {
      model: "gemini-2.5-flash",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
      requestId: "fail-fast-req",
    };

    // First call triggers refresh failure and sets needsReconnect
    await expect(async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of provider.chat(request)) {
        // do nothing
      }
    }).rejects.toMatchObject({
      payload: {
        code: "unauthorized",
        message: expect.stringContaining("/admin"),
      },
    });

    // Check account status reflects needsReconnect
    const status = await provider.getAccountStatus();
    expect(status.needsReconnect).toBe(true);

    // Second call fails fast at the very beginning of chat()
    fakeFetch.mockClear();
    await expect(async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of provider.chat(request)) {
        // do nothing
      }
    }).rejects.toMatchObject({
      payload: {
        code: "unauthorized",
        message: "Antigravity credentials expired or revoked. Reconnect in the admin dashboard (/admin).",
      },
    });
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it("asserts sentinel secrets NEVER appear in any status JSON (leak prevention)", async () => {
    const SENTINEL_REFRESH_TOKEN = "SENTINEL_NEVER_LEAK_SECRET_REFRESH_98765";
    const SENTINEL_CLIENT_SECRET = "SENTINEL_SECRET_KEY_ABCD_1234";
    const LONG_CLIENT_ID = "long-client-id-123456789.apps.googleusercontent.com";

    const fakeStore = createFakeStore({
      refreshToken: SENTINEL_REFRESH_TOKEN,
      clientSecret: SENTINEL_CLIENT_SECRET,
      clientId: LONG_CLIENT_ID,
      projectId: "public-project-id",
      accountHint: "t***@company.com",
      updatedAt: 123456789,
    });

    const manager = new TokenManager({
      credentialStore: fakeStore,
    });

    const provider = new AntigravityProvider(
      {},
      { credentialStore: fakeStore },
    );

    const tokenManagerStatus = await manager.getStatus();
    const providerStatus = await provider.getAccountStatus();

    // Serialized status payloads
    const tmJson = JSON.stringify(tokenManagerStatus);
    const providerJson = JSON.stringify(providerStatus);

    // Assert sentinel refresh token never appears anywhere
    expect(tmJson).not.toContain(SENTINEL_REFRESH_TOKEN);
    expect(providerJson).not.toContain(SENTINEL_REFRESH_TOKEN);

    // Assert client secret never appears anywhere
    expect(tmJson).not.toContain(SENTINEL_CLIENT_SECRET);
    expect(providerJson).not.toContain(SENTINEL_CLIENT_SECRET);

    // Assert full client ID is masked (first 4 + *** + last 4)
    expect(tmJson).not.toContain(LONG_CLIENT_ID);
    expect(providerJson).not.toContain(LONG_CLIENT_ID);
    expect(tokenManagerStatus.clientIdMasked).toBe("long***.com");
    expect(providerStatus.clientIdMasked).toBe("long***.com");

    // Allowed public metadata should be present
    expect(tokenManagerStatus.projectId).toBe("public-project-id");
    expect(tokenManagerStatus.accountHint).toBe("t***@company.com");
    expect(tokenManagerStatus.connected).toBe(true);
    expect(tokenManagerStatus.hasRefreshToken).toBe(true);
  });

  it("createProviderFromConfig forwards credentialStore and tokenEndpoint to AntigravityProvider", async () => {
    const fakeStore = createFakeStore({
      refreshToken: "cfg-refresh-token",
      projectId: "cfg-project",
      updatedAt: 12345,
    });

    const config: ProviderConfig = {
      mode: "antigravity",
      credentials: {},
    };

    const provider = createProviderFromConfig(config, {
      credentialStore: fakeStore,
      tokenEndpoint: "https://auth-test.endpoint/token",
    }) as AntigravityProvider;

    expect(provider).toBeInstanceOf(AntigravityProvider);
    expect(provider.id).toBe("antigravity");

    const status = await provider.getAccountStatus();
    expect(status.connected).toBe(true);
    expect(status.projectId).toBe("cfg-project");

    // MockProvider ignores deps
    const mockConfig: ProviderConfig = { mode: "mock" };
    const mockProvider = createProviderFromConfig(mockConfig, {
      credentialStore: fakeStore,
      tokenEndpoint: "https://auth-test.endpoint/token",
    });
    expect(mockProvider).toBeInstanceOf(MockProvider);
  });

  it("supports runtime mutation via clearCredentials and setCredentials", async () => {
    const fakeStore = createFakeStore();
    const manager = new TokenManager({ credentialStore: fakeStore });

    // Initially no credentials
    let status = await manager.getStatus();
    expect(status.connected).toBe(false);

    // Set credentials at runtime
    await manager.setCredentials({
      refreshToken: "runtime-token-123",
      projectId: "runtime-proj",
      accountHint: "r***@runtime.com",
    });

    status = await manager.getStatus();
    expect(status.connected).toBe(true);
    expect(status.hasRefreshToken).toBe(true);
    expect(status.accountHint).toBe("r***@runtime.com");
    expect(fakeStore.stored?.refreshToken).toBe("runtime-token-123");

    // Clear credentials at runtime
    await manager.clearCredentials();
    status = await manager.getStatus();
    expect(status.connected).toBe(false);
    expect(status.hasRefreshToken).toBe(false);
    expect(fakeStore.stored).toBeNull();
  });
});
