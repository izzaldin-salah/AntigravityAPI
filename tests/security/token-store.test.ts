import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  loadTokenStore,
  resolveCredentials,
  saveTokenStore,
} from "../../src/security/token-store";

describe("Token and Credential Store (tests/security/token-store.test.ts)", () => {
  const options={encryptionKey:"cache-test-key"};
  it("migrates only valid legacy data and preserves originals on migration failure",async()=>{
    const dir=await fs.promises.mkdtemp(path.join(os.tmpdir(),"ag-migrate-"));
    const file=path.join(dir,"cache.json");
    try {
      const legacy=JSON.stringify({accessToken:"CACHE_ACCESS_SENTINEL",refreshToken:"CACHE_REFRESH_SENTINEL",expiresAt:123});
      await fs.promises.writeFile(file,legacy);
      const rename=vi.spyOn(fs.promises,"rename").mockRejectedValueOnce(new Error("locked"));
      const warn=vi.fn();
      expect(await loadTokenStore(file,{...options,warn})).toBeNull();
      rename.mockRestore();
      expect(await fs.promises.readFile(file,"utf8")).toBe(legacy);
      expect(warn).toHaveBeenCalled();
      expect(await loadTokenStore(file,options)).toMatchObject({accessToken:"CACHE_ACCESS_SENTINEL"});
      const raw=await fs.promises.readFile(file,"utf8");expect(raw).not.toContain("CACHE_ACCESS_SENTINEL");expect(raw).not.toContain("CACHE_REFRESH_SENTINEL");
      expect(await loadTokenStore(file,{encryptionKey:"wrong"})).toBeNull();
      expect(await fs.promises.readFile(file,"utf8")).toBe(raw);
      await fs.promises.writeFile(file,JSON.stringify({refreshToken:123}));
      expect(await loadTokenStore(file,options)).toBeNull();
    } finally {vi.restoreAllMocks();await fs.promises.rm(dir,{recursive:true,force:true});}
  });
  it("uses memory-only behavior without a key and serializes concurrent encrypted saves",async()=>{
    const dir=await fs.promises.mkdtemp(path.join(os.tmpdir(),"ag-keyless-"));const file=path.join(dir,"cache.json");
    try {
      const warn=vi.fn();expect(await saveTokenStore(file,{accessToken:"SECRET"},{warn})).toBe(false);
      expect(fs.existsSync(file)).toBe(false);expect(warn).toHaveBeenCalled();
      await Promise.all([1,2,3].map(n=>saveTokenStore(file,{accessToken:`TOKEN_${n}`},options)));
      expect(await loadTokenStore(file,options)).toMatchObject({accessToken:"TOKEN_3"});
      const raw=await fs.promises.readFile(file,"utf8");const parsed=JSON.parse(raw);parsed.tag=Buffer.alloc(16).toString("base64");
      await fs.promises.writeFile(file,JSON.stringify(parsed));
      expect(await loadTokenStore(file,options)).toBeNull();
      expect(await saveTokenStore(file,{accessToken:"REPLACEMENT"},options)).toBe(false);
    } finally {await fs.promises.rm(dir,{recursive:true,force:true});}
  });
  it("token store save+load roundtrip in os.tmpdir with no leakage", async () => {
    const tmpDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "ag-token-test-"),
    );
    const tokenFile = path.join(tmpDir, "subfolder", "antigravity-token.json");

    const payload = {
      accessToken: "ya29.test-access-token",
      refreshToken: "1//test-refresh-token",
      expiresAt: Date.now() + 3600000,
      tokenType: "Bearer",
      scope: "https://www.googleapis.com/auth/cloud-platform",
    };

    // Save tokens atomically
    const saved = await saveTokenStore(tokenFile, payload, options);
    expect(saved).toBe(true);

    // Verify file exists on disk
    const rawContent = await fs.promises.readFile(tokenFile, "utf-8");
    expect(rawContent).not.toContain("ya29.test-access-token");
    expect(rawContent).not.toContain("1//test-refresh-token");

    // Load tokens back
    const loaded = await loadTokenStore(tokenFile, options);
    expect(loaded).toBeDefined();
    expect(loaded?.accessToken).toBe(payload.accessToken);
    expect(loaded?.refreshToken).toBe(payload.refreshToken);
    expect(loaded?.expiresAt).toBe(payload.expiresAt);
    expect(loaded?.tokenType).toBe(payload.tokenType);

    // Cleanup
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it("loadTokenStore gracefully handles missing files, empty paths, or invalid JSON", async () => {
    expect(await loadTokenStore(undefined)).toBeNull();
    expect(await loadTokenStore("")).toBeNull();
    expect(await loadTokenStore("/non/existent/path/token.json")).toBeNull();

    const tmpDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "ag-token-invalid-"),
    );
    const invalidFile = path.join(tmpDir, "corrupt.json");
    await fs.promises.writeFile(invalidFile, "{ not valid json ...", "utf-8");

    const loaded = await loadTokenStore(invalidFile);
    expect(loaded).toBeNull();

    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it("resolveCredentials prioritizes environment credentials over cached disk tokens", () => {
    const envCreds = {
      refreshToken: "env-refresh-token",
      clientId: "env-client-id",
    };

    const cachedStore = {
      accessToken: "cached-access-token",
      refreshToken: "cached-refresh-token-older",
      projectId: "cached-project-id",
    };

    const resolved = resolveCredentials(envCreds, cachedStore);

    // Refresh token taken from envCreds (env first)
    expect(resolved.refreshToken).toBe("env-refresh-token");
    // Access token fallback to cached
    expect(resolved.accessToken).toBe("cached-access-token");
    // Client ID from env
    expect(resolved.clientId).toBe("env-client-id");
    // Project ID fallback to cached
    expect(resolved.projectId).toBe("cached-project-id");
  });
});
