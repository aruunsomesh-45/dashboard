const REDACT_KEYS = new Set([
  "authorization",
  "password",
  "secret",
  "token",
  "access_token",
  "graph_token",
  "api_key",
  "api_secret",
  "shared_secret",
  "webhook_secret",
  "key_secret",
  "encrypted_credentials",
  "cookie",
  "apikey",
  "signature",
  "hmac",
  "credential",
]);

export function redactSensitiveData(obj: unknown): unknown {
  if (!obj || typeof obj !== "object") return obj;

  if (Array.isArray(obj)) {
    return obj.map(redactSensitiveData);
  }

  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
    const keyLower = key.toLowerCase();
    const isSensitive = Array.from(REDACT_KEYS).some((k) => keyLower.includes(k));

    if (isSensitive && typeof val === "string") {
      if (keyLower.includes("password")) {
        result[key] = "[REDACTED]";
      } else {
        result[key] = val.length > 8 ? `${val.substring(0, 4)}...[REDACTED]` : "[REDACTED]";
      }
    } else if (typeof val === "object" && val !== null) {
      result[key] = redactSensitiveData(val);
    } else {
      result[key] = val;
    }
  }
  return result;
}

export const logger = {
  info: (msg: string, meta?: unknown) => {
    console.log(JSON.stringify({ level: "INFO", message: msg, meta: redactSensitiveData(meta), timestamp: new Date().toISOString() }));
  },
  warn: (msg: string, meta?: unknown) => {
    console.warn(JSON.stringify({ level: "WARN", message: msg, meta: redactSensitiveData(meta), timestamp: new Date().toISOString() }));
  },
  error: (msg: string, meta?: unknown) => {
    console.error(JSON.stringify({ level: "ERROR", message: msg, meta: redactSensitiveData(meta), timestamp: new Date().toISOString() }));
  },
};
