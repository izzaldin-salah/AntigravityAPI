import { describe, expect, it } from "vitest";
import { createSessionStore } from "../../src/security/session-store";

describe("SessionStore (tests/security/session-store.test.ts)", () => {
  it("session lifecycle: create, get, destroy", async () => {
    const store = createSessionStore();
    const session = await store.create(60000);

    expect(session.id).toBeDefined();
    expect(typeof session.id).toBe("string");
    expect(session.id.length).toBeGreaterThan(20);
    expect(session.csrfToken).toBeDefined();
    expect(typeof session.csrfToken).toBe("string");
    expect(session.expiresAt).toBeGreaterThan(session.createdAt);

    // Retrieve
    const retrieved = await store.get(session.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.id).toBe(session.id);
    expect(retrieved?.csrfToken).toBe(session.csrfToken);

    // Destroy
    await store.destroy(session.id);
    expect(await store.get(session.id)).toBeNull();

    // Idempotent destroy
    await expect(store.destroy(session.id)).resolves.not.toThrow();
  });

  it("sliding expiry: get() extends expiresAt", async () => {
    const store = createSessionStore();
    const ttlMs = 10000;
    const session = await store.create(ttlMs);
    const initialExpiresAt = session.expiresAt;

    // Small delay
    await new Promise((resolve) => setTimeout(resolve, 50));

    const refreshed = await store.get(session.id);
    expect(refreshed).not.toBeNull();
    expect(refreshed!.expiresAt).toBeGreaterThan(initialExpiresAt);
  });

  it("TTL expiration: returns null when expired", async () => {
    const store = createSessionStore();
    // 1ms TTL so it expires immediately
    const session = await store.create(1);

    await new Promise((resolve) => setTimeout(resolve, 10));

    const retrieved = await store.get(session.id);
    expect(retrieved).toBeNull();
  });

  it("cap eviction: evicts soonest-expiring session when cap is reached", async () => {
    // Set maxSessions = 3
    const store = createSessionStore({ maxSessions: 3 });

    // s1 expires soonest (in 500ms)
    const s1 = await store.create(500);
    // s2 expires in 5000ms
    const s2 = await store.create(5000);
    // s3 expires in 10000ms
    const s3 = await store.create(10000);

    // Adding s4 should trigger eviction of s1 (the soonest expiring)
    const s4 = await store.create(20000);

    expect(await store.get(s1.id)).toBeNull();
    expect(await store.get(s2.id)).not.toBeNull();
    expect(await store.get(s3.id)).not.toBeNull();
    expect(await store.get(s4.id)).not.toBeNull();
  });
});
