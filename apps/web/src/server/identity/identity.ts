export const SESSION_COOKIE = "ta_session";
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * `userId` is absent until phase-2 authentication. The booking core only ever sees a Principal,
 * never cookies, so adding users does not touch booking procedures (ADR 0012).
 */
export interface Principal {
  readonly kind: "guest" | "user";
  readonly sessionId: string;
  readonly userId?: string;
}

export interface CookieReader {
  get(name: string): { readonly value: string } | undefined;
}

export interface IdentityService {
  resolve(cookies: CookieReader): Promise<Principal>;
}

export function buyerKey(principal: Principal): string {
  return principal.userId ?? principal.sessionId;
}

const encoder = new TextEncoder();

// Web Crypto (not node:crypto) so the same code runs in the proxy and in route handlers.
function importKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^(?:[0-9a-f]{2})+$/.test(hex)) {
    return undefined;
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function newSessionId(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(16)));
}

/** Cookie value `<128-bit hex id>.<hex HMAC-SHA256 of the id>`. */
export async function issueSessionCookieValue(secret: string): Promise<string> {
  const sessionId = newSessionId();
  const signature = await crypto.subtle.sign(
    "HMAC",
    await importKey(secret, "sign"),
    encoder.encode(sessionId),
  );
  return `${sessionId}.${toHex(new Uint8Array(signature))}`;
}

export async function verifySessionCookieValue(
  secret: string,
  value: string,
): Promise<string | undefined> {
  const parts = value.split(".");
  if (parts.length !== 2) {
    return undefined;
  }
  const [sessionId, signatureHex] = parts;
  const signature = fromHex(signatureHex ?? "");
  if (!(sessionId && /^[0-9a-f]{32}$/.test(sessionId) && signature)) {
    return undefined;
  }
  // subtle.verify compares in constant time.
  const valid = await crypto.subtle.verify(
    "HMAC",
    await importKey(secret, "verify"),
    signature,
    encoder.encode(sessionId),
  );
  return valid ? sessionId : undefined;
}

export function createIdentityService(config: { readonly sessionSecret: string }): IdentityService {
  return {
    async resolve(cookies) {
      const value = cookies.get(SESSION_COOKIE)?.value;
      const verified = value
        ? await verifySessionCookieValue(config.sessionSecret, value)
        : undefined;
      // A guest never fails to resolve. Without a trusted cookie the id is ephemeral; the proxy
      // persists a fresh one on the response.
      return { kind: "guest", sessionId: verified ?? newSessionId() };
    },
  };
}
