#!/usr/bin/env node
/**
 * Generates ADMIN_PASSWORD_HASH for the account dashboard (coordinator-owned).
 *
 * Usage:
 *   node scripts/hash-admin-password.mjs "my password"
 *   node scripts/hash-admin-password.mjs            # interactive prompt
 *
 * Output format (frozen, architecture contract §14):
 *   scrypt$N$r$p$<saltB64>$<hashB64>
 *
 * The output contains no plaintext; set it as ADMIN_PASSWORD_HASH in your
 * environment (Render dashboard / .env for local runs). Never commit it.
 */
import { randomBytes, scryptSync } from "node:crypto";
import { createInterface } from "node:readline";

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;

async function readPassword() {
  const fromArgs = process.argv.slice(2).join(" ").trim();
  if (fromArgs.length > 0) return fromArgs;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => {
    rl.question(
      "Admin password (input is VISIBLE; prefer the quoted-argument form): ",
      resolve,
    );
  });
  rl.close();
  return String(answer).trim();
}

const password = await readPassword();
if (password.length === 0) {
  console.error("Empty password; aborting.");
  process.exit(1);
}

const salt = randomBytes(16);
const hash = scryptSync(password, salt, KEY_LENGTH, {
  N: SCRYPT_N,
  r: SCRYPT_R,
  p: SCRYPT_P,
  maxmem: 256 * SCRYPT_N * SCRYPT_R,
});

console.log(
  `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64")}$${hash.toString("base64")}`,
);
