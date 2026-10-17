import { describe, expect, it } from "vitest";
import { generateCsrfToken, verifyCsrfToken } from "../../src/security/csrf";

describe("CSRF Protection (tests/security/csrf.test.ts)", () => {
  it("generateCsrfToken produces random tokens with expected entropy", () => {
    const token1 = generateCsrfToken();
    const token2 = generateCsrfToken();

    expect(typeof token1).toBe("string");
    expect(token1.length).toBeGreaterThan(30);
    expect(token1).not.toBe(token2);
  });

  it("verifyCsrfToken validates exact token match", () => {
    const token = generateCsrfToken();
    expect(verifyCsrfToken(token, token)).toBe(true);
  });

  it("verifyCsrfToken returns false on value mismatch without throwing", () => {
    const token1 = generateCsrfToken();
    const token2 = generateCsrfToken();
    expect(verifyCsrfToken(token1, token2)).toBe(false);
  });

  it("verifyCsrfToken handles length mismatch safely without throwing", () => {
    const token = generateCsrfToken();
    expect(verifyCsrfToken(token, "short")).toBe(false);
    expect(verifyCsrfToken(token, token + "-extra")).toBe(false);
    expect(verifyCsrfToken("short", token)).toBe(false);
  });

  it("verifyCsrfToken handles undefined / empty / non-string safely without throwing", () => {
    const token = generateCsrfToken();
    expect(verifyCsrfToken(token, undefined)).toBe(false);
    expect(verifyCsrfToken(token, "")).toBe(false);
    expect(verifyCsrfToken("", token)).toBe(false);
    expect(verifyCsrfToken(undefined as unknown as string, token)).toBe(false);
  });
});
