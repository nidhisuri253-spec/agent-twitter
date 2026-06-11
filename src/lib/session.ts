const COOKIE_NAME = "__session";
const MAX_AGE_S = 60 * 60 * 24 * 7; // 7 days

export type SessionPayload =
  | { sub: string; role: "agent"; iat: number }
  | { sub: null; role: "guest"; iat: number };

// ── Web Crypto helpers (work in both Edge and Node runtimes) ──────────────────

function toBase64url(data: Uint8Array | ArrayBuffer): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function fromBase64url(str: string): Uint8Array {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function hmacKey(): Promise<CryptoKey> {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not set");
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function verifySession(raw: string): Promise<SessionPayload | null> {
  try {
    const dot = raw.lastIndexOf(".");
    if (dot === -1) return null;
    const data = raw.slice(0, dot);
    const sig = raw.slice(dot + 1);
    const key = await hmacKey();
    const sigBytes = fromBase64url(sig);
    const dataBytes = new TextEncoder().encode(data);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      sigBytes.buffer.slice(sigBytes.byteOffset, sigBytes.byteOffset + sigBytes.byteLength) as ArrayBuffer,
      dataBytes.buffer.slice(dataBytes.byteOffset, dataBytes.byteOffset + dataBytes.byteLength) as ArrayBuffer
    );
    if (!valid) return null;
    const payload: SessionPayload = JSON.parse(
      new TextDecoder().decode(fromBase64url(data))
    );
    if (!payload.role || typeof payload.iat !== "number") return null;
    if (Date.now() - payload.iat > MAX_AGE_S * 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function getSessionFromCookieHeader(
  cookieHeader: string | null
): Promise<SessionPayload | null> {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(
    new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`)
  );
  if (!match) return null;
  return verifySession(match[1]);
}

async function sign(payload: SessionPayload): Promise<string> {
  const key = await hmacKey();
  const data = toBase64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return `${data}.${toBase64url(sig)}`;
}

function cookieFlags(): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `; HttpOnly${secure}; SameSite=Strict; Path=/; Max-Age=${MAX_AGE_S}`;
}

export async function makeSessionCookie(payload: SessionPayload): Promise<string> {
  const value = await sign(payload);
  return `${COOKIE_NAME}=${value}${cookieFlags()}`;
}

export function clearSessionCookie(): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${COOKIE_NAME}=; HttpOnly${secure}; SameSite=Strict; Path=/; Max-Age=0`;
}
