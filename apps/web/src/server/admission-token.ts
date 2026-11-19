import { jwtVerify, SignJWT } from "jose";
import type { CookieReader } from "./identity/identity";

/** One cookie per event, so admissions to two events never overwrite each other (spec story 11). */
export function admissionCookieName(eventId: string): string {
  return `ta_adm_${eventId}`;
}

/**
 * What an admission token asserts (ADR 0008): `sub` = session id, `eid` = event id, `jti` = the
 * admission id kept in the event's Redis admitted set, `exp` = admittedAt + 30 min (whole seconds).
 */
export interface AdmissionClaims {
  readonly sessionId: string;
  readonly eventId: string;
  readonly jti: string;
  readonly expiresAt: Date;
}

export interface AdmissionCookie {
  readonly name: string;
  readonly value: string;
  readonly expiresAt: Date;
}

/**
 * The admission token seam of the tRPC context: procedures and middleware never see the cookie or
 * the secret, only verified claims.
 */
export interface AdmissionTokens {
  /** Signs the admission and sets it as the event's cookie on the response. */
  issue(admission: AdmissionClaims): Promise<void>;
  /**
   * The claims of the request's token for the event when its signature (HS256) and `exp` are
   * valid; `undefined` otherwise. Says nothing about `sub`, `eid` or revocation: the caller checks
   * those against the principal, the input and the admitted set.
   */
  read(eventId: string): Promise<AdmissionClaims | undefined>;
}

export interface AdmissionTokensConfig {
  /** Resolved on first use, so requests that never touch admission need no secret. */
  readonly secret: () => string;
  readonly cookies: CookieReader;
  readonly setCookie: (cookie: AdmissionCookie) => void;
  readonly now: () => Date;
}

const encoder = new TextEncoder();

export function createAdmissionTokens(config: AdmissionTokensConfig): AdmissionTokens {
  const key = () => encoder.encode(config.secret());

  return {
    async issue(admission) {
      const value = await new SignJWT({ eid: admission.eventId })
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .setSubject(admission.sessionId)
        .setJti(admission.jti)
        // Fixed at admittedAt + 30 min, never renewed: re-issuing on later polls repeats it.
        .setExpirationTime(Math.floor(admission.expiresAt.getTime() / 1000))
        .sign(key());
      config.setCookie({
        name: admissionCookieName(admission.eventId),
        value,
        expiresAt: admission.expiresAt,
      });
    },

    async read(eventId) {
      const token = config.cookies.get(admissionCookieName(eventId))?.value;
      if (!token) {
        return undefined;
      }
      const secret = key();
      try {
        const { payload } = await jwtVerify(token, secret, {
          // Pinned, so a token can never pick its own algorithm (e.g. `none`).
          algorithms: ["HS256"],
          currentDate: config.now(),
          requiredClaims: ["sub", "jti", "exp"],
        });
        const { sub, jti, exp, eid } = payload;
        if (
          typeof sub !== "string" ||
          typeof jti !== "string" ||
          typeof exp !== "number" ||
          typeof eid !== "string"
        ) {
          return undefined;
        }
        return { sessionId: sub, eventId: eid, jti, expiresAt: new Date(exp * 1000) };
      } catch {
        // A malformed, forged or expired token is simply no admission.
        return undefined;
      }
    },
  };
}

/** `Set-Cookie` value for an admission cookie: httpOnly so page scripts can never read it. */
export function admissionSetCookie(cookie: AdmissionCookie): string {
  return [
    `${cookie.name}=${cookie.value}`,
    "Path=/",
    `Expires=${cookie.expiresAt.toUTCString()}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ].join("; ");
}
