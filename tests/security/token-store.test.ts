import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadTokenStore,
  resolveCredentials,
  saveTokenStore,
} from "../../src/security/token-store";

describe("Token and Credential Store (tests/security/token-store.test.ts)", () => {
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
    const saved = await saveTokenStore(tokenFile, payload);
    expect(saved).toBe(true);

    // Verify file exists on disk
    const rawContent = await fs.promises.readFile(tokenFile, "utf-8");
    expect(rawContent).toContain("ya29.test-access-token");
    expect(rawContent).toContain("1//test-refresh-token");

    // Load tokens back
    const loaded = await loadTokenStore(tokenFile);
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
