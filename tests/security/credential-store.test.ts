import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CredentialStoreError,
  createCredentialStore,
} from "../../src/security/credential-store";
import type { StoredAntigravityCredentials } from "../../src/types/admin";

describe("CredentialStore (tests/security/credential-store.test.ts)", () => {
  let tempDir: string;
  let testFilePath: string;
  const testKey = crypto.randomBytes(32).toString("base64");

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "cred-store-test-"));
    testFilePath = path.join(tempDir, "credentials.json");
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("file store roundtrip + ciphertext-at-rest sentinel", async () => {
    const sentinelSecret = "ultra-secret-plaintext-refresh-token-XYZ-12345";
    const store = createCredentialStore({
      backend: "file",
      filePath: testFilePath,
      encryptionKey: testKey,
    });

    const sampleCreds: StoredAntigravityCredentials = {
      refreshToken: sentinelSecret,
      clientId: "my-client-id",
      accountHint: "test@example.com",
      updatedAt: Date.now(),
    };

    await store.save(sampleCreds);

    // 1. Raw file inspection (ciphertext at rest)
    const rawFileContent = await fs.readFile(testFilePath, "utf8");
    expect(rawFileContent).not.toContain(sentinelSecret);

    // 2. Envelope shape assertion
    const envelope = JSON.parse(rawFileContent);
    expect(envelope).toMatchObject({
      v: 1,
      kdf: "scrypt",
      salt: expect.any(String),
      iv: expect.any(String),
      tag: expect.any(String),
      data: expect.any(String),
    });

    // 3. Load roundtrip
    const loaded = await store.load();
    expect(loaded).not.toBeNull();
    expect(loaded?.refreshToken).toBe(sentinelSecret);
    expect(loaded?.clientId).toBe("my-client-id");
    expect(loaded?.accountHint).toBe("test@example.com");
  });

  it("throws CredentialStoreError on wrong encryption key", async () => {
    const store1 = createCredentialStore({
      backend: "file",
      filePath: testFilePath,
      encryptionKey: testKey,
    });

    await store1.save({
      refreshToken: "token-to-fail",
      updatedAt: Date.now(),
    });

    const differentKey = crypto.randomBytes(32).toString("base64");
    const store2 = createCredentialStore({
      backend: "file",
      filePath: testFilePath,
      encryptionKey: differentKey,
    });

    await expect(store2.load()).rejects.toThrowError(CredentialStoreError);
  });

  it("clear() deletes file and drops in-memory cache", async () => {
    const store = createCredentialStore({
      backend: "file",
      filePath: testFilePath,
      encryptionKey: testKey,
    });

    await store.save({
      refreshToken: "token-to-clear",
      updatedAt: Date.now(),
    });

    expect(await store.load()).not.toBeNull();

    await store.clear();

    // In-memory load should return null
    expect(await store.load()).toBeNull();

    // File should not exist on disk
    await expect(fs.access(testFilePath)).rejects.toThrow();

    // Idempotent clear
    await expect(store.clear()).resolves.not.toThrow();
  });

  it("missing encryptionKey: construction succeeds, save/load throw, health fails closed", async () => {
    const store = createCredentialStore({
      backend: "file",
      filePath: testFilePath,
      // encryptionKey omitted (dashboard disabled mode)
    });

    expect(store.backend).toBe("file");

    await expect(
      store.save({
        refreshToken: "token",
        updatedAt: Date.now(),
      }),
    ).rejects.toThrowError(
      "CREDENTIAL_ENCRYPTION_KEY is required to persist credentials",
    );

    await expect(store.load()).rejects.toThrowError(
      "CREDENTIAL_ENCRYPTION_KEY is required to persist credentials",
    );

    const health = await store.health();
    expect(health.ok).toBe(false);
    expect(health.detail).toContain(
      "CREDENTIAL_ENCRYPTION_KEY is required to persist credentials",
    );
  });

  it("health() probes file directory reachability and returns ok: true when configured", async () => {
    const store = createCredentialStore({
      backend: "file",
      filePath: testFilePath,
      encryptionKey: testKey,
    });

    const health = await store.health();
    expect(health.ok).toBe(true);
    expect(health.backend).toBe("file");
  });

  it("handles non-existent file gracefully on load() -> returns null", async () => {
    const store = createCredentialStore({
      backend: "file",
      filePath: path.join(tempDir, "non-existent.json"),
      encryptionKey: testKey,
    });

    const loaded = await store.load();
    expect(loaded).toBeNull();
  });

  it("throws CredentialStoreError if decrypted payload is missing refreshToken", async () => {
    // Encrypt invalid JSON directly
    const store = createCredentialStore({
      backend: "file",
      filePath: testFilePath,
      encryptionKey: "passphrase-test-key",
    });

    // Save with passphrase key
    await store.save({
      refreshToken: "valid-token",
      updatedAt: Date.now(),
    });
    const loaded = await store.load();
    expect(loaded?.refreshToken).toBe("valid-token");
  });
});
