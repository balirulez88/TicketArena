import { type AdmissionTokens, createAdmissionTokens } from "../admission-token";

/**
 * Test-only: each session's cookies, kept across `createCaller` requests the way a browser keeps
 * them, so router tests obtain admission tokens through `queue.status` like a real buyer does.
 */
export function createBrowserCookies(admissionSecret: string) {
  const jars = new Map<string, Map<string, string>>();

  const jarOf = (sessionId: string): Map<string, string> => {
    const jar = jars.get(sessionId) ?? new Map<string, string>();
    jars.set(sessionId, jar);
    return jar;
  };

  return {
    /** The session's cookies by name; tests may copy or replace values to play an attacker. */
    jarOf,
    /** The context's admission seam for one request of the session at `now`. */
    admissionTokens(sessionId: string, now: Date): AdmissionTokens {
      const jar = jarOf(sessionId);
      return createAdmissionTokens({
        secret: () => admissionSecret,
        cookies: {
          get: (name) => {
            const value = jar.get(name);
            return value === undefined ? undefined : { value };
          },
        },
        setCookie: ({ name, value }) => jar.set(name, value),
        now: () => now,
      });
    },
  };
}
