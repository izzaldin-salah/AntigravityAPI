import * as crypto from "node:crypto";

export class CredentialStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialStoreError";
  }
}

interface EncryptionEnvelope {
  v: 1;
  kdf: "scrypt";
  salt: string;
  iv: string;
  tag: string;
  data: string;
}

function deriveKey(rawKey: string, salt: Buffer): Buffer {
  const trimmed = rawKey.trim();
  try {
    if (/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) {
      const decoded = Buffer.from(trimmed, "base64");
      if (decoded.length === 32) {
        return decoded;
      }
    }
  } catch {
    // fallback to scrypt
  }
  return crypto.scryptSync(trimmed, salt, 32);
}

export function encryptEnvelope(
  credentials: object,
  encryptionKey: string,
): string {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(encryptionKey, salt);

  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(credentials), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  const envelope: EncryptionEnvelope = {
    v: 1,
    kdf: "scrypt",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: ciphertext.toString("base64"),
  };

  return JSON.stringify(envelope);
}

export function decryptEnvelope(
  rawContent: string,
  encryptionKey: string,
): unknown {
  let envelope: EncryptionEnvelope;
  try {
    const text = rawContent.trim();
    const jsonStr = text.startsWith("{")
      ? text
      : Buffer.from(text, "base64").toString("utf8");
    envelope = JSON.parse(jsonStr) as EncryptionEnvelope;
  } catch {
    throw new CredentialStoreError(
      "Corrupted credential envelope: invalid JSON format",
    );
  }

  if (
    envelope.v !== 1 ||
    !envelope.salt ||
    !envelope.iv ||
    !envelope.tag ||
    !envelope.data
  ) {
    throw new CredentialStoreError(
      "Corrupted credential envelope: missing required fields",
    );
  }

  try {
    const salt = Buffer.from(envelope.salt, "base64");
    const iv = Buffer.from(envelope.iv, "base64");
    const tag = Buffer.from(envelope.tag, "base64");
    const ciphertext = Buffer.from(envelope.data, "base64");

    const key = deriveKey(encryptionKey, salt);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    const parsed = JSON.parse(decrypted.toString("utf8")) as Record<
      string,
      unknown
    >;

    return parsed;
  } catch (err: unknown) {
    if (err instanceof CredentialStoreError) {
      throw err;
    }
    throw new CredentialStoreError(
      "Failed to decrypt credentials: wrong key or corrupted data",
    );
  }
}
