import { signHex, toHex, verifyHex } from "./hmac";

export const SESSION_COOKIE = "ta_session";
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * A guest has no `userId` until phase-2 authentication. The booking core only ever sees a
 * Principal, never cookies, so adding users does not touch booking procedures (ADR 0012).
 */
export type Principal =
  | { readonly kind: "guest"; readonly sessionId: string }
  | { readonly kind: "user"; readonly sessionId: string; readonly userId: string };

export interface CookieReader {
  get(name: string): { readonly value: string } | undefined;
}

export interface IdentityService {
  resolve(cookies: CookieReader): Promise<Principal>;
}

export function buyerKey(principal: Principal): string {
  return principal.kind === "user" ? principal.userId : principal.sessionId;
}

function newSessionId(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(16)));
}

/** Cookie value `<128-bit hex id>.<hex HMAC-SHA256 of the id>`. */
export async function issueSessionCookieValue(secret: string): Promise<string> {
  const sessionId = newSessionId();
  return `${sessionId}.${await signHex(secret, sessionId)}`;
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
  if (!(sessionId && /^[0-9a-f]{32}$/.test(sessionId))) {
    return undefined;
  }
  return (await verifyHex(secret, sessionId, signatureHex ?? "")) ? sessionId : undefined;
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
