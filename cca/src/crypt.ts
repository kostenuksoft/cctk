import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from "node:crypto";

const KEYLEN = 32;
const SCRYPT = { N: 16384, r: 8, p: 1 } as const;

export interface Sealed {
  readonly cca: "export";
  readonly kdf: "scrypt";
  readonly salt: string;
  readonly iv: string;
  readonly tag: string;
  readonly data: string;
}

export function seal(plaintext: string, passphrase: string): Sealed {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, KEYLEN, SCRYPT);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    cca: "export",
    kdf: "scrypt",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: encrypted.toString("base64"),
  };
}

export function unseal(sealed: Sealed, passphrase: string): string {
  const key = scryptSync(passphrase, Buffer.from(sealed.salt, "base64"), KEYLEN, SCRYPT);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(sealed.data, "base64")), decipher.final()]).toString("utf8");
}

export function parseSealed(value: unknown): Sealed | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const entry = value as Record<string, unknown>;
  if (entry.cca !== "export" || entry.kdf !== "scrypt") {
    return undefined;
  }
  if (typeof entry.salt !== "string" || typeof entry.iv !== "string" || typeof entry.tag !== "string" || typeof entry.data !== "string") {
    return undefined;
  }
  return { cca: "export", kdf: "scrypt", salt: entry.salt, iv: entry.iv, tag: entry.tag, data: entry.data };
}
