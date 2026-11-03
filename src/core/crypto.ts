import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";
const IV_BYTES = 12;
const KEY_BYTES = 32;
const TAG_BYTES = 16;

/**
 * Decode and validate a base64 AES-256 key.
 * @param keyB64 - Base64 text that must decode to exactly 32 bytes.
 * @returns The raw 32-byte key.
 * @throws Error when the key is empty or not 32 bytes after decoding.
 */
function parseKey(keyB64: string): Buffer {
  const key = Buffer.from(keyB64, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(`Encryption key must be base64 of exactly ${KEY_BYTES} bytes`);
  }
  return key;
}

/**
 * Encrypt a secret with AES-256-GCM and a fresh random 12-byte IV.
 * @param plaintext - The secret to protect.
 * @param keyB64 - Base64 of the 32-byte key (PTT_ENCRYPT_KEY).
 * @returns `v1.<iv>.<tag>.<ciphertext>` with base64 parts.
 * @throws Error when the key is not 32 bytes.
 */
export function encryptSecret(plaintext: string, keyB64: string): string {
  const key = parseKey(keyB64);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(".");
}

/**
 * Decrypt a value produced by {@link encryptSecret}.
 * @param payload - The stored `v1.<iv>.<tag>.<ciphertext>` string.
 * @param keyB64 - Base64 of the 32-byte key (PTT_ENCRYPT_KEY).
 * @returns The original plaintext.
 * @throws Error when the format is wrong, the key is wrong or the data was tampered with.
 */
export function decryptSecret(payload: string, keyB64: string): string {
  const key = parseKey(keyB64);
  const parts = payload.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error("Unsupported encrypted secret format");
  }
  const iv = Buffer.from(parts[1]!, "base64");
  const tag = Buffer.from(parts[2]!, "base64");
  const ct = Buffer.from(parts[3]!, "base64");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES)
    throw new Error("Unsupported encrypted secret format");
  const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
