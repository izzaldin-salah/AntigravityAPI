import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { AdminConfig } from "../types/config";

export function verifyPlaintextPassword(
  candidate: string,
  configured: string,
): boolean {
  if (!candidate || !configured) {
    return false;
  }
  const candidateDigest = createHash("sha256").update(candidate).digest();
  const configuredDigest = createHash("sha256").update(configured).digest();
  return timingSafeEqual(candidateDigest, configuredDigest);
}

export function verifyPasswordHash(
  candidate: string,
  hashString: string,
): boolean {
  try {
    const parts = hashString.split("$");
    // Format: scrypt$N$r$p$<saltB64>$<hashB64>
    if (parts.length !== 6 || parts[0] !== "scrypt") {
      return false;
    }
    const n = parseInt(parts[1], 10);
    const r = parseInt(parts[2], 10);
    const p = parseInt(parts[3], 10);
    const salt = Buffer.from(parts[4], "base64");
    const expectedHash = Buffer.from(parts[5], "base64");

    if (
      isNaN(n) ||
      isNaN(r) ||
      isNaN(p) ||
      salt.length === 0 ||
      expectedHash.length === 0
    ) {
      return false;
    }

    const derived = scryptSync(candidate, salt, expectedHash.length, {
      N: n,
      r,
      p,
      maxmem: 256 * n * r,
    });

    return timingSafeEqual(derived, expectedHash);
  } catch {
    return false;
  }
}

export function verifyAdminPassword(
  candidate: string,
  adminConfig: AdminConfig,
): boolean {
  if (adminConfig.passwordHash) {
    return verifyPasswordHash(candidate, adminConfig.passwordHash);
  }
  if (adminConfig.password) {
    return verifyPlaintextPassword(candidate, adminConfig.password);
  }
  return false;
}

export function parseCookie(
  cookieHeader: string | undefined,
  name: string,
): string | null {
  if (!cookieHeader) {
    return null;
  }
  const parts = cookieHeader.split(";");
  for (const part of parts) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) {
      return decodeURIComponent(v.join("="));
    }
  }
  return null;
}

export function buildSessionCookie(
  sessionId: string,
  ttlMs: number,
  isSecure: boolean,
): string {
  const maxAge = Math.floor(ttlMs / 1000);
  const parts = [
    `admin_session=${encodeURIComponent(sessionId)}`,
    `Max-Age=${maxAge}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (isSecure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

export function buildClearSessionCookie(isSecure: boolean): string {
  const parts = [
    "admin_session=",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (isSecure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}
