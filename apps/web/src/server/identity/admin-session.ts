import { signHex, verifyHex } from "./hmac";

export const ADMIN_COOKIE = "ta_admin";
/** One operator shift; after that the operator logs in again. */
export const ADMIN_SESSION_TTL_SECONDS = 8 * 60 * 60;

// The signed message carries a purpose prefix, so a guest `ta_session` signature (over a bare hex
// id under the same SESSION_SECRET) can never be replayed as an admin cookie.
const adminMessage = (expiresAt: string) => `ta_admin:${expiresAt}`;

/**
 * Cookie value `<expiry, epoch seconds>.<hex HMAC-SHA256 of "ta_admin:<expiry>">`. The expiry is
 * inside the signature, so the browser's `maxAge` is a courtesy and the server enforces the
 * lifetime itself. Signed with `SESSION_SECRET`: rotating it logs out every guest and operator.
 */
export async function issueAdminCookieValue(secret: string, now: Date): Promise<string> {
  const expiresAt = String(Math.floor(now.getTime() / 1000) + ADMIN_SESSION_TTL_SECONDS);
  return `${expiresAt}.${await signHex(secret, adminMessage(expiresAt))}`;
}

/** `true` only for a well-formed, correctly signed, unexpired admin cookie; never throws. */
export async function verifyAdminCookieValue(
  secret: string,
  value: string | undefined,
  now: Date,
): Promise<boolean> {
  const parts = value?.split(".") ?? [];
  const [expiresAt, signatureHex] = parts;
  if (parts.length !== 2 || !(expiresAt && /^\d{1,12}$/.test(expiresAt))) {
    return false;
  }
  if (Number(expiresAt) * 1000 <= now.getTime()) {
    return false;
  }
  return verifyHex(secret, adminMessage(expiresAt), signatureHex ?? "");
}

/**
 * Compares the supplied password with the configured one in constant time: both are compared as
 * HMACs through `subtle.verify`, so neither the length nor a matching prefix leaks through timing.
 */
export async function adminPasswordMatches(
  secret: string,
  expected: string,
  supplied: string,
): Promise<boolean> {
  return verifyHex(
    secret,
    `ta_admin_password:${supplied}`,
    await signHex(secret, `ta_admin_password:${expected}`),
  );
}
