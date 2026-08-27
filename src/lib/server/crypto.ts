import "server-only";
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/config";

const algorithm = "aes-256-gcm";

export type EncryptedSecret = {
  version: 1;
  iv: string;
  tag: string;
  ciphertext: string;
};

export function getServerSecretKey(): Buffer {
  const raw = env.TOKEN_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error("TOKEN_ENCRYPTION_KEY is required for server-side secret handling.");
  }

  const decoded = Buffer.from(raw, "base64");
  if (decoded.length === 32) return decoded;

  const utf8 = Buffer.from(raw, "utf8");
  if (utf8.length === 32) return utf8;

  throw new Error("TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes.");
}

export function encryptSecret(plaintext: string): string {
  const key = getServerSecretKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(algorithm, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const payload: EncryptedSecret = {
    version: 1,
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url")
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decryptSecret(serialized: string): string {
  const key = getServerSecretKey();
  const payload = JSON.parse(Buffer.from(serialized, "base64url").toString("utf8")) as EncryptedSecret;
  if (payload.version !== 1) {
    throw new Error("Unsupported encrypted secret version.");
  }

  const decipher = createDecipheriv(algorithm, key, Buffer.from(payload.iv, "base64url"));
  decipher.setAuthTag(Buffer.from(payload.tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(payload.ciphertext, "base64url")), decipher.final()]).toString("utf8");
}

export function signValue(value: string): string {
  const signature = createHmac("sha256", getServerSecretKey()).update(value).digest("base64url");
  return `${value}.${signature}`;
}

export function verifySignedValue(signed: string): string | null {
  const index = signed.lastIndexOf(".");
  if (index === -1) return null;
  const value = signed.slice(0, index);
  const expected = signValue(value).slice(index + 1);
  const actual = signed.slice(index + 1);
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  if (expectedBuffer.length !== actualBuffer.length) return null;
  return timingSafeEqual(expectedBuffer, actualBuffer) ? value : null;
}

export function sha256Base64Url(value: string): string {
  return createHmac("sha256", getServerSecretKey()).update(value).digest("base64url");
}
