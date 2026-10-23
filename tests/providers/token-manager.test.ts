import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { TokenManager } from "../../src/providers/token-manager";
import { ProviderError } from "../../src/types/provider";
import { saveTokenStore } from "../../src/security/token-store";

describe("TokenManager", () => {
  it("does not restore stale credentials when an in-flight refresh finishes after disconnect",async()=>{
    let finish:(response:Response)=>void=()=>{};
    const fetcher=vi.fn(()=>new Promise<Response>(resolve=>{finish=resolve;}));
    const manager=new TokenManager({credentials:{refreshToken:"old-account"},fetch:fetcher});
    const refreshing=manager.refreshAccessToken();
    const rejection=expect(refreshing).rejects.toMatchObject({payload:{code:"aborted"}});
    await vi.waitFor(()=>expect(fetcher).toHaveBeenCalled());
    await manager.clearCredentials();
    finish(new Response(JSON.stringify({access_token:"STALE_TOKEN",expires_in:3600}),{status:200}));
    await rejection;expect((await manager.getStatus()).connected).toBe(false);
  });
  it("lets one refresh waiter cancel without cancelling another request",async()=>{
    let finish:(response:Response)=>void=()=>{};
    let networkSignal:AbortSignal|null|undefined;
    const fetcher=vi.fn((_url:unknown,init?:RequestInit)=>{networkSignal=init?.signal;return new Promise<Response>(resolve=>{finish=resolve;});});
    const manager=new TokenManager({credentials:{refreshToken:"shared"},fetch:fetcher});
    const caller=new AbortController();const first=manager.refreshAccessToken(caller.signal);
    const rejected=expect(first).rejects.toMatchObject({payload:{code:"aborted"}});
    const second=manager.refreshAccessToken();
    await vi.waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(1));
    caller.abort();await rejected;expect(networkSignal?.aborted).toBe(false);
    finish(new Response(JSON.stringify({access_token:"shared-token",expires_in:3600}),{status:200}));
    expect(await second).toBe("shared-token");
  });
  it("keeps keyless refresh in memory and preserves environment identity over cached identity",async()=>{
    const dir=await fs.promises.mkdtemp(path.join(os.tmpdir(),"manager-cache-"));const file=path.join(dir,"cache.json");
    try {
      const fetcher=vi.fn(async()=>new Response(JSON.stringify({access_token:"NEW_ACCESS",expires_in:3600}),{status:200}));
      const warn=vi.fn();const keyless=new TokenManager({credentials:{refreshToken:"ENV_REFRESH",tokenStorePath:file},fetch:fetcher,warn});
      expect(await keyless.refreshAccessToken()).toBe("NEW_ACCESS");expect(fs.existsSync(file)).toBe(false);expect(warn).toHaveBeenCalled();
      await saveTokenStore(file,{accessToken:"OLD_ACCOUNT_ACCESS",refreshToken:"OLD_ACCOUNT_REFRESH",expiresAt:Date.now()+3600000},{encryptionKey:"key"});
      const manager=new TokenManager({credentials:{refreshToken:"ENV_REFRESH",tokenStorePath:file},encryptionKey:"key",fetch:fetcher});
      expect(await manager.getAccessToken()).toBe("NEW_ACCESS");
    } finally {await fs.promises.rm(dir,{recursive:true,force:true});}
  });
  it("asserts token refresh request shape (URL, headers, body parameters)", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    let capturedHeaders: Record<string, string> = {};
    let capturedBody = "";

    const fakeFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = url.toString();
      capturedMethod = init?.method ?? "";
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      capturedBody = (init?.body ?? "") as string;

      return new Response(
        JSON.stringify({
          access_token: "fresh-access-token-123",
          expires_in: 3600,
          token_type: "Bearer",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const tokenManager = new TokenManager({
      credentials: {
        refreshToken: "secret-refresh-token-xyz",
        clientId: "my-client-id-abc",
        clientSecret: "my-client-secret-999",
        projectId: "test-project-1",
      },
      fetch: fakeFetch,
    });

    const token = await tokenManager.getAccessToken();
    expect(token).toBe("fresh-access-token-123");

    expect(capturedUrl).toBe("https://oauth2.googleapis.com/token");
    expect(capturedMethod).toBe("POST");
    expect(capturedHeaders["Content-Type"]).toBe("application/x-www-form-urlencoded");

    const params = new URLSearchParams(capturedBody);
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("refresh_token")).toBe("secret-refresh-token-xyz");
    expect(params.get("client_id")).toBe("my-client-id-abc");
    expect(params.get("client_secret")).toBe("my-client-secret-999");
  });

  it("never logs or includes secrets in errors on refresh failure", async () => {
    const secretRefreshToken = "ultra-secret-refresh-token-12345";
    const secretClientSecret = "super-confidential-client-secret-67890";

    const fakeFetch = vi.fn(async () => {
      return new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const tokenManager = new TokenManager({
      credentials: {
        refreshToken: secretRefreshToken,
        clientSecret: secretClientSecret,
      },
      fetch: fakeFetch,
    });

    try {
      await tokenManager.refreshAccessToken();
      expect.unreachable("Should have thrown ProviderError");
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      const providerError = err as ProviderError;
      expect(providerError.payload.code).toBe("unauthorized");
      expect(providerError.message).not.toContain(secretRefreshToken);
      expect(providerError.message).not.toContain(secretClientSecret);
    }
  });

  it("best-effort saves and loads tokens from tokenStorePath", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-tokens-"));
    const tokenStorePath = path.join(tempDir, "cached-token.json");

    const fakeFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          access_token: "disk-cached-token-abc",
          expires_in: 7200,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    // Manager 1: performs refresh and writes to disk
    const manager1 = new TokenManager({
      encryptionKey: "manager-cache-test-key",
      credentials: {
        refreshToken: "refresh-for-disk",
        projectId: "disk-project",
        tokenStorePath,
      },
      fetch: fakeFetch,
    });

    const token1 = await manager1.refreshAccessToken();
    expect(token1).toBe("disk-cached-token-abc");
    expect(fs.existsSync(tokenStorePath)).toBe(true);
    expect(fs.readFileSync(tokenStorePath,"utf8")).not.toContain("disk-cached-token-abc");

    // Manager 2: initialized without access token, should read cached token from disk
    const manager2 = new TokenManager({
      encryptionKey: "manager-cache-test-key",
      credentials: {
        tokenStorePath,
      },
      fetch: fakeFetch,
    });

    const token2 = await manager2.getAccessToken();
    expect(token2).toBe("disk-cached-token-abc");
    expect(manager2.getProjectId()).toBe("disk-project");

    // Clean up
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
