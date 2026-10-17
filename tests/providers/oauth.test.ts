import { describe, it, expect, vi } from "vitest";
import { createOAuthService, createPkcePair, maskEmail } from "../../src/providers/oauth";
import { ProviderError } from "../../src/types/provider";
import * as crypto from "node:crypto";

describe("OAuthService & PKCE", () => {
  it("creates PKCE pair with verifier >= 43 chars and S256 challenge", () => {
    const pkce = createPkcePair();
    expect(pkce.verifier).toBeDefined();
    expect(pkce.verifier.length).toBeGreaterThanOrEqual(43);
    expect(pkce.challenge).toBeDefined();

    // Verify S256 relationship: base64url(sha256(verifier)) === challenge
    const expectedChallenge = crypto
      .createHash("sha256")
      .update(pkce.verifier)
      .digest("base64url");
    expect(pkce.challenge).toBe(expectedChallenge);
  });

  it("masks email correctly for accountHint without leaking tokens", () => {
    expect(maskEmail("user@example.com")).toBe("u***@example.com");
    expect(maskEmail("john.doe@sub.domain.org")).toBe("j***@sub.domain.org");
    expect(maskEmail("invalid")).toBe("***");
    expect(maskEmail("")).toBe("***");
  });

  it("reports isConfigured only when clientId is present and non-empty", () => {
    const unconfigured = createOAuthService({ scopes: ["openid"] });
    expect(unconfigured.isConfigured()).toBe(false);

    const empty = createOAuthService({ clientId: "", scopes: ["openid"] });
    expect(empty.isConfigured()).toBe(false);

    const configured = createOAuthService({
      clientId: "test-client-id.apps.googleusercontent.com",
      scopes: ["openid"],
    });
    expect(configured.isConfigured()).toBe(true);
  });

  it("builds correct authorize URL with all required query params", () => {
    const oauth = createOAuthService({
      clientId: "my-client-id.apps.googleusercontent.com",
      scopes: ["openid", "email", "https://www.googleapis.com/auth/cloud-platform"],
    });

    const authorizeUrl = oauth.buildAuthorizeUrl({
      state: "state-token-12345",
      codeChallenge: "challenge-base64url-s256",
      redirectUri: "https://my-app.onrender.com/admin/oauth/callback",
    });

    const parsed = new URL(authorizeUrl);
    expect(parsed.origin).toBe("https://accounts.google.com");
    expect(parsed.pathname).toBe("/o/oauth2/v2/auth");
    expect(parsed.searchParams.get("client_id")).toBe("my-client-id.apps.googleusercontent.com");
    expect(parsed.searchParams.get("redirect_uri")).toBe("https://my-app.onrender.com/admin/oauth/callback");
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("scope")).toBe(
      "openid email https://www.googleapis.com/auth/cloud-platform",
    );
    expect(parsed.searchParams.get("state")).toBe("state-token-12345");
    expect(parsed.searchParams.get("code_challenge")).toBe("challenge-base64url-s256");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.get("access_type")).toBe("offline");
    expect(parsed.searchParams.get("prompt")).toBe("consent");
  });

  it("respects authEndpoint and tokenEndpoint overrides", () => {
    const oauth = createOAuthService({
      clientId: "custom-client",
      scopes: ["openid"],
      authEndpoint: "https://auth.custom.test/authorize",
      tokenEndpoint: "https://auth.custom.test/token",
    });

    const url = oauth.buildAuthorizeUrl({
      state: "state-1",
      codeChallenge: "chal-1",
      redirectUri: "https://callback.test",
    });
    expect(url.startsWith("https://auth.custom.test/authorize")).toBe(true);
  });

  it("exchanges authorization code successfully and decodes id_token accountHint", async () => {
    let capturedUrl = "";
    let capturedBody = "";
    let capturedHeaders: Record<string, string> = {};

    // Create a fake id_token with email in payload
    const fakePayload = Buffer.from(
      JSON.stringify({ email: "operator@company.com", sub: "123456" }),
    ).toString("base64url");
    const fakeIdToken = `header.${fakePayload}.signature`;

    const fakeFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = url.toString();
      capturedBody = (init?.body ?? "") as string;
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;

      return new Response(
        JSON.stringify({
          access_token: "mock-access-token-123",
          refresh_token: "mock-refresh-token-456",
          expires_in: 3600,
          id_token: fakeIdToken,
          project_id: "google-companion-project",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const oauth = createOAuthService({
      clientId: "client-id-abc",
      clientSecret: "client-secret-xyz",
      scopes: ["openid", "email"],
      fetch: fakeFetch,
    });

    const result = await oauth.exchangeCode({
      code: "auth-code-789",
      codeVerifier: "verifier-secret-pkce-xyz",
      redirectUri: "https://gateway.test/admin/oauth/callback",
    });

    expect(capturedUrl).toBe("https://oauth2.googleapis.com/token");
    expect(capturedHeaders["Content-Type"]).toBe("application/x-www-form-urlencoded");

    const params = new URLSearchParams(capturedBody);
    expect(params.get("grant_type")).toBe("authorization_code");
    expect(params.get("code")).toBe("auth-code-789");
    expect(params.get("code_verifier")).toBe("verifier-secret-pkce-xyz");
    expect(params.get("redirect_uri")).toBe("https://gateway.test/admin/oauth/callback");
    expect(params.get("client_id")).toBe("client-id-abc");
    expect(params.get("client_secret")).toBe("client-secret-xyz");

    expect(result.refreshToken).toBe("mock-refresh-token-456");
    expect(result.accessToken).toBe("mock-access-token-123");
    expect(result.expiresIn).toBe(3600);
    expect(result.projectId).toBe("google-companion-project");
    expect(result.accountHint).toBe("o***@company.com");
  });

  it("throws ProviderError unauthorized when exchangeCode response lacks refresh_token", async () => {
    const fakeFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          access_token: "mock-access-token-only",
          expires_in: 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const oauth = createOAuthService({
      clientId: "client-id",
      scopes: ["openid"],
      fetch: fakeFetch,
    });

    try {
      await oauth.exchangeCode({
        code: "code-without-refresh",
        codeVerifier: "verifier-1",
        redirectUri: "https://callback.test",
      });
      expect.unreachable("Should throw when refresh_token is missing");
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      const providerError = err as ProviderError;
      expect(providerError.payload.code).toBe("unauthorized");
      expect(providerError.payload.status).toBe(502);
      expect(providerError.message).toContain("Google only returns a refresh token on first consent");
    }
  });

  it("maps Google non-2xx error in exchangeCode to ProviderError unauthorized", async () => {
    const fakeFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: "invalid_grant",
          error_description: "Malformed auth code.",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const oauth = createOAuthService({
      clientId: "client-id",
      scopes: ["openid"],
      fetch: fakeFetch,
    });

    try {
      await oauth.exchangeCode({
        code: "bad-code",
        codeVerifier: "verifier-1",
        redirectUri: "https://callback.test",
      });
      expect.unreachable("Should throw ProviderError on non-2xx");
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      const providerError = err as ProviderError;
      expect(providerError.payload.code).toBe("unauthorized");
      expect(providerError.payload.status).toBe(502);
      expect(providerError.message).toContain("Malformed auth code.");
    }
  });

  it("testRefresh successfully validates refresh credentials and echoes refreshToken", async () => {
    let capturedBody = "";
    const fakeFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = (init?.body ?? "") as string;
      return new Response(
        JSON.stringify({
          access_token: "refreshed-access-token-999",
          expires_in: 3600,
          project_id: "companion-proj",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const oauth = createOAuthService({
      clientId: "default-client-id",
      clientSecret: "default-secret",
      scopes: ["openid"],
      fetch: fakeFetch,
    });

    const result = await oauth.testRefresh({
      refreshToken: "test-refresh-token-abc",
    });

    const params = new URLSearchParams(capturedBody);
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("refresh_token")).toBe("test-refresh-token-abc");
    expect(params.get("client_id")).toBe("default-client-id");
    expect(params.get("client_secret")).toBe("default-secret");

    expect(result.refreshToken).toBe("test-refresh-token-abc");
    expect(result.accessToken).toBe("refreshed-access-token-999");
    expect(result.expiresIn).toBe(3600);
    expect(result.projectId).toBe("companion-proj");
  });

  it("testRefresh failure maps to ProviderError unauthorized with invalid_grant wording", async () => {
    const fakeFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: "invalid_grant",
          error_description: "Token has been expired or revoked.",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const oauth = createOAuthService({
      clientId: "client-id",
      scopes: ["openid"],
      fetch: fakeFetch,
    });

    try {
      await oauth.testRefresh({
        refreshToken: "revoked-refresh-token",
      });
      expect.unreachable("Should throw on refresh rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      const providerError = err as ProviderError;
      expect(providerError.payload.code).toBe("unauthorized");
      expect(providerError.payload.status).toBe(502);
      expect(providerError.message).toContain("invalid_grant");
    }
  });
});
