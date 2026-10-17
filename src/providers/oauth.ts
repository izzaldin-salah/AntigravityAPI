/**
 * STUB — owner: antigravity-provider-agent (replace with the real Google
 * OAuth 2.0 Authorization Code + PKCE implementation in the v1.1 wave).
 *
 * Implemented enough to typecheck and to report "not configured" from the
 * admin UI until the real implementation lands.
 * Frozen seam: docs/architecture-contract.md §15.
 */
import type { OAuthService, OAuthServiceOptions, OAuthTokenResult } from "../types/admin";
import { GOOGLE_OAUTH_AUTH_ENDPOINT, GOOGLE_OAUTH_TOKEN_ENDPOINT } from "../types/config";
import { ProviderError } from "../types/provider";

export function createOAuthService(options: OAuthServiceOptions): OAuthService {
  const authEndpoint = options.authEndpoint ?? GOOGLE_OAUTH_AUTH_ENDPOINT;
  const tokenEndpoint = options.tokenEndpoint ?? GOOGLE_OAUTH_TOKEN_ENDPOINT;

  const notImplemented = (): never => {
    throw new ProviderError({
      code: "not_implemented",
      message:
        "Browser OAuth connect is not implemented in this scaffold build (provider agent delivers it in the v1.1 wave).",
      status: 501,
    });
  };

  return {
    isConfigured(): boolean {
      return Boolean(options.clientId);
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
      return url.toString();
    },
    async exchangeCode(): Promise<OAuthTokenResult> {
      return notImplemented();
    },
    async testRefresh(): Promise<OAuthTokenResult> {
      void tokenEndpoint;
      return notImplemented();
    },
  };
}
