import { describe, expect, test } from "vitest";
import { buyerKey, createIdentityService, issueSessionCookieValue } from "./identity";

const secret = "s".repeat(32);
const cookiesWith = (value?: string) => ({
  get: (name: string) => (name === "ta_session" && value ? { value } : undefined),
});

describe("IdentityService.resolve", () => {
  const identity = createIdentityService({ sessionSecret: secret });

  test("resolves a validly signed cookie to the guest session it carries", async () => {
    const value = await issueSessionCookieValue(secret);
    const sessionId = value.split(".")[0];

    expect(await identity.resolve(cookiesWith(value))).toEqual({ kind: "guest", sessionId });
  });

  test("a cookie signed with another secret is never trusted", async () => {
    const forged = await issueSessionCookieValue("x".repeat(32));
    const forgedId = forged.split(".")[0];

    const principal = await identity.resolve(cookiesWith(forged));

    expect(principal.kind).toBe("guest");
    expect(principal.sessionId).not.toBe(forgedId);
  });

  test("a tampered session id is never trusted", async () => {
    const [, signature] = (await issueSessionCookieValue(secret)).split(".");
    const principal = await identity.resolve(cookiesWith(`${"0".repeat(32)}.${signature}`));

    expect(principal.sessionId).not.toBe("0".repeat(32));
  });

  test.each([undefined, "", "garbage", "a.b.c"])(
    "never throws for a guest with cookie %j",
    async (value) => {
      const principal = await identity.resolve(cookiesWith(value));

      expect(principal.kind).toBe("guest");
      expect(principal.sessionId).toMatch(/^[0-9a-f]{32}$/);
    },
  );
});

describe("buyerKey", () => {
  test("is the session id for a guest", () => {
    expect(buyerKey({ kind: "guest", sessionId: "abc" })).toBe("abc");
  });

  test("is the user id for a user", () => {
    expect(buyerKey({ kind: "user", sessionId: "abc", userId: "u1" })).toBe("u1");
  });
});
