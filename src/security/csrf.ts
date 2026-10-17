/**
 * CSRF token generation and timing-safe verification.
 * Owner: antigravity-deployment-agent.
 * Frozen seam: docs/architecture-contract.md §13, §15.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";

export function generateCsrfToken(): string {
  return randomBytes(32).toString("base64url");
}

export function verifyCsrfToken(
  expected: string,
  provided: string | undefined,
): boolean {
  if (!expected || typeof expected !== "string") return false;
  if (!provided || typeof provided !== "string") return false;

  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);
  if (expectedBuf.length !== providedBuf.length) return false;

  return timingSafeEqual(expectedBuf, providedBuf);
}
