/**
 * Google OAuth 2.0 Authorization Code + PKCE implementation for Account Management.
 * Implements the frozen OAuthService interface (src/types/admin.ts).
 * Never logs or exposes tokens or secret values.
 */
import * as crypto from "node:crypto";
import type { OAuthService, OAuthServiceOptions, OAuthTokenResult } from "../types/admin";
import { GOOGLE_OAUTH_AUTH_ENDPOINT, GOOGLE_OAUTH_TOKEN_ENDPOINT } from "../types/config";
import { ProviderError } from "../types/provider";

/**
 * Creates a PKCE code_verifier and code_challenge pair using S256.
 * Verifier: 43+ chars base64url from 32 cryptographically random bytes.
 * Challenge: base64url(sha256(verifier)).
 */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/**
 * Masks an email address like `i***@domain.com`. NEVER returns tokens.
 */
export function maskEmail(email: string): string {
  const atIndex = email.indexOf("@");
  if (atIndex <= 0) {
    return "***";
  }
  const local = email.slice(0, atIndex);
  const domain = email.slice(atIndex + 1);
  return `${local[0]}***@${domain}`;
}

/**
 * Extracts and masks the email from the payload segment of a JWT id_token.
 * Decodes only the payload (base64url JSON); no signature verification needed over TLS.
 * NEVER returns any token or secret value.
 */
export function extractAccountHintFromIdToken(idToken: unknown): string | undefined {
  if (typeof idToken !== "string") {
    return undefined;
  }
  const parts = idToken.split(".");
  if (parts.length < 2) {
    return undefined;
  }
  try {
    const payloadJson = Buffer.from(parts[1], "base64url").toString("utf-8");
    const payload = JSON.parse(payloadJson) as Record<string, unknown>;
    if (typeof payload.email === "string" && payload.email.trim().length > 0) {
      return maskEmail(payload.email.trim());
    }
  } catch {
    // Decoding failure ignored; never throw
  }
  return undefined;
}

export function createOAuthService(options: OAuthServiceOptions): OAuthService {
  const authEndpoint = options.authEndpoint ?? GOOGLE_OAUTH_AUTH_ENDPOINT;
  const tokenEndpoint = options.tokenEndpoint ?? GOOGLE_OAUTH_TOKEN_ENDPOINT;
  const fetchImpl = options.fetch ?? globalThis.fetch;

  return {
    isConfigured(): boolean {
      return Boolean(options.clientId && options.clientId.trim().length > 0);
    },

    buildAuthorizeUrl({ state, codeChallenge, redirectUri }): string {
      const url = new URL(authEndpoint);
      url.searchParams.set("client_id", options.clientId ?? "");
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", options.scopes.join(" "));
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set("access_type", "offline");
      url.searchParams.set("prompt", "consent");
      return url.toString();
    },

    async exchangeCode({ code, codeVerifier, redirectUri }): Promise<OAuthTokenResult> {
      const params = new URLSearchParams();
      params.set("grant_type", "authorization_code");
      params.set("code", code);
      params.set("code_verifier", codeVerifier);
      params.set("redirect_uri", redirectUri);
      params.set("client_id", options.clientId ?? "");
      if (options.clientSecret) {
        params.set("client_secret", options.clientSecret);
      }

      let response: Response;
      try {
        response = await fetchImpl(tokenEndpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: params.toString(),
          signal: AbortSignal.timeout(15_000),
        });
      } catch (err) {
        throw new ProviderError({
          code: "unauthorized",
          message: `OAuth code exchange network request failed: ${err instanceof Error ? err.message : "network error"}`,
          status: 502,
        });
      }

      if (!response.ok) {
        let errorText = `status ${response.status}`;
        try {
          const errData = (await response.json()) as Record<string, unknown>;
          if (typeof errData.error_description === "string") {
            errorText = errData.error_description;
          } else if (typeof errData.error === "string") {
            errorText = errData.error;
          }
        } catch {
          // Fallback if not JSON
        }
        throw new ProviderError({
          code: "unauthorized",
          message: `Google OAuth code exchange failed: ${errorText}`,
          status: 502,
        });
      }

      let data: Record<string, unknown>;
      try {
        data = (await response.json()) as Record<string, unknown>;
      } catch {
        throw new ProviderError({
          code: "unauthorized",
          message: "Google OAuth response was not valid JSON.",
          status: 502,
        });
      }

      const refreshToken = typeof data.refresh_token === "string" ? data.refresh_token : undefined;
      if (!refreshToken) {
        throw new ProviderError({
          code: "unauthorized",
          message:
            "Google did not return a refresh token. Google only returns a refresh token on first consent. Revoke application access in Google account security settings and retry.",
          status: 502,
        });
      }

      return {
        refreshToken,
        accessToken: typeof data.access_token === "string" ? data.access_token : undefined,
        expiresIn: typeof data.expires_in === "number" ? data.expires_in : undefined,
        projectId: typeof data.project_id === "string" ? data.project_id : undefined,
        accountHint: extractAccountHintFromIdToken(data.id_token),
      };
    },

    async testRefresh({ refreshToken, clientId, clientSecret }): Promise<OAuthTokenResult> {
      const effectiveClientId = clientId ?? options.clientId;
      const effectiveClientSecret = clientSecret ?? options.clientSecret;

      const params = new URLSearchParams();
      params.set("grant_type", "refresh_token");
      params.set("refresh_token", refreshToken);
      if (effectiveClientId) {
        params.set("client_id", effectiveClientId);
      }
      if (effectiveClientSecret) {
        params.set("client_secret", effectiveClientSecret);
      }

      let response: Response;
      try {
        response = await fetchImpl(tokenEndpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: params.toString(),
          signal: AbortSignal.timeout(15_000),
        });
      } catch (err) {
        throw new ProviderError({
          code: "unauthorized",
          message: `OAuth token refresh test failed: ${err instanceof Error ? err.message : "network error"}`,
          status: 502,
        });
      }

      if (!response.ok) {
        let errorDetail = `status ${response.status}`;
        try {
          const errData = (await response.json()) as Record<string, unknown>;
          if (typeof errData.error_description === "string") {
            errorDetail = errData.error_description;
          } else if (typeof errData.error === "string") {
            errorDetail = errData.error;
          }
        } catch {
          // Fallback if not JSON
        }
        throw new ProviderError({
          code: "unauthorized",
          message: `Google OAuth refresh rejected (${response.status}): ${errorDetail}. The refresh token may be invalid, expired, or revoked (invalid_grant).`,
          status: 502,
        });
      }

      let data: Record<string, unknown>;
      try {
        data = (await response.json()) as Record<string, unknown>;
      } catch {
        throw new ProviderError({
          code: "unauthorized",
          message: "Google OAuth refresh response was not valid JSON.",
          status: 502,
        });
      }

      return {
        refreshToken,
        accessToken: typeof data.access_token === "string" ? data.access_token : undefined,
        expiresIn: typeof data.expires_in === "number" ? data.expires_in : undefined,
        projectId: typeof data.project_id === "string" ? data.project_id : undefined,
      };
    },
  };
}
