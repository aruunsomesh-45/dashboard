/**
 * AES-256-GCM Credential Encryption & Decryption (Web Crypto API)
 * 100% Bit-compatible with Django backend `backend/apps/integrations/crypto.py`.
 *
 * Format: 12-byte Nonce + Ciphertext (ending with 16-byte GCM authentication tag)
 * Master Key: SHA-256(INTEGRATION_ENCRYPTION_KEY || SECRET_KEY)
 *
 * There is deliberately NO hard-coded fallback key: a key committed to the repo would let
 * anyone decrypt stored credentials, and silently using it in production makes every
 * decrypt fail with a confusing "operation failed" error.
 */

async function getMasterKey(): Promise<CryptoKey> {
  const rawKey = Deno.env.get("INTEGRATION_ENCRYPTION_KEY") || Deno.env.get("SECRET_KEY") || "";
  if (!rawKey) {
    throw new Error("Server misconfiguration: INTEGRATION_ENCRYPTION_KEY is not set");
  }

  const keyBuffer = new TextEncoder().encode(rawKey);
  const hashBuffer = await crypto.subtle.digest("SHA-256", keyBuffer);

  return await crypto.subtle.importKey(
    "raw",
    hashBuffer,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
}

export function parseHexOrBytes(input: unknown): Uint8Array {
  if (input instanceof Uint8Array) {
    return input;
  }
  if (typeof input === "string") {
    let hex = input;
    if (hex.startsWith("\\x") || hex.startsWith("0x")) {
      hex = hex.slice(2);
    }
    if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
      throw new Error("Encrypted credentials are not valid hex");
    }
    const len = hex.length / 2;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }
  return new Uint8Array(0);
}

export function bytesToPostgresHex(bytes: Uint8Array): string {
  let hex = "\\x";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

export async function encryptCredentials(data: Record<string, unknown>): Promise<Uint8Array> {
  if (!data || Object.keys(data).length === 0) {
    return new Uint8Array(0);
  }
  const key = await getMasterKey();
  const nonce = crypto.getRandomValues(new Uint8Array(12)); // 96-bit nonce
  const encodedData = new TextEncoder().encode(JSON.stringify(data));

  const encryptedBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    key,
    encodedData
  );

  const result = new Uint8Array(12 + encryptedBuffer.byteLength);
  result.set(nonce, 0);
  result.set(new Uint8Array(encryptedBuffer), 12);
  return result;
}

export async function decryptCredentials(encryptedInput: unknown): Promise<Record<string, unknown>> {
  const bytes = parseHexOrBytes(encryptedInput);
  if (bytes.length <= 12) {
    return {};
  }

  const key = await getMasterKey();
  const nonce = bytes.slice(0, 12);
  const ciphertext = bytes.slice(12);

  try {
    const decryptedBuffer = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce },
      key,
      ciphertext
    );
    const jsonStr = new TextDecoder().decode(decryptedBuffer);
    return JSON.parse(jsonStr);
  } catch (err) {
    throw new Error(`Failed to decrypt credentials: ${(err as Error).message}`);
  }
}
