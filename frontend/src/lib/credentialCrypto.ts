import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * AES-256-GCM credential encryption for integrations_integration.encrypted_credentials.
 *
 * Byte-compatible with serverless/supabase/functions/_shared/crypto.ts (the Edge Functions decrypt what
 * this writes): key = SHA-256(INTEGRATION_ENCRYPTION_KEY || SECRET_KEY), payload = 12-byte nonce ||
 * ciphertext || 16-byte GCM tag, stored as Postgres bytea hex (`\x...`).
 * The Vercel project and the Supabase function secrets must therefore hold the same key.
 */
function masterKey(): Buffer {
  const raw = process.env.INTEGRATION_ENCRYPTION_KEY || process.env.SECRET_KEY || "";
  if (!raw) throw new Error("Server misconfiguration: INTEGRATION_ENCRYPTION_KEY is not set");
  return createHash("sha256").update(raw, "utf8").digest();
}

export function isEncryptionConfigured(): boolean {
  return Boolean(process.env.INTEGRATION_ENCRYPTION_KEY || process.env.SECRET_KEY);
}

export function encryptCredentialsToPgHex(data: Record<string, unknown>): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), nonce);
  const body = Buffer.concat([cipher.update(JSON.stringify(data), "utf8"), cipher.final()]);
  return "\\x" + Buffer.concat([nonce, body, cipher.getAuthTag()]).toString("hex");
}

export function decryptCredentialsFromPgHex(value: string): Record<string, unknown> {
  const hex = value.startsWith("\\x") || value.startsWith("0x") ? value.slice(2) : value;
  const bytes = Buffer.from(hex, "hex");
  if (bytes.length <= 28) return {};
  const decipher = createDecipheriv("aes-256-gcm", masterKey(), bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(bytes.length - 16));
  const plain = Buffer.concat([decipher.update(bytes.subarray(12, bytes.length - 16)), decipher.final()]);
  return JSON.parse(plain.toString("utf8"));
}
