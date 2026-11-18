import { describe, expect, test } from "vitest";
import {
  ADMIN_SESSION_TTL_SECONDS,
  adminPasswordMatches,
  issueAdminCookieValue,
  verifyAdminCookieValue,
} from "./admin-session";
import { issueSessionCookieValue } from "./identity";

const secret = "s".repeat(32);
const NOW = new Date("2027-03-01T12:00:00.000Z");
const seconds = (n: number) => new Date(NOW.getTime() + n * 1000);

describe("admin cookie", () => {
  test("a freshly issued cookie verifies under the same secret", async () => {
    const value = await issueAdminCookieValue(secret, NOW);

    expect(await verifyAdminCookieValue(secret, value, NOW)).toBe(true);
  });

  test("is valid until its lifetime ends and not after", async () => {
    const value = await issueAdminCookieValue(secret, NOW);

    expect(
      await verifyAdminCookieValue(secret, value, seconds(ADMIN_SESSION_TTL_SECONDS - 1)),
    ).toBe(true);
    expect(await verifyAdminCookieValue(secret, value, seconds(ADMIN_SESSION_TTL_SECONDS))).toBe(
      false,
    );
  });

  test("a cookie signed with another secret is rejected", async () => {
    const forged = await issueAdminCookieValue("x".repeat(32), NOW);

    expect(await verifyAdminCookieValue(secret, forged, NOW)).toBe(false);
  });

  test("an extended expiry breaks the signature", async () => {
    const [, signature] = (await issueAdminCookieValue(secret, NOW)).split(".");
    const extended = `${Math.floor(NOW.getTime() / 1000) + 10 * ADMIN_SESSION_TTL_SECONDS}.${signature}`;

    expect(await verifyAdminCookieValue(secret, extended, NOW)).toBe(false);
  });

  test("a guest session cookie is never an admin cookie", async () => {
    const guest = await issueSessionCookieValue(secret);

    expect(await verifyAdminCookieValue(secret, guest, NOW)).toBe(false);
  });

  test.each([undefined, "", "garbage", "1.2.3", "abc.def"])(
    "rejects cookie value %j without throwing",
    async (value) => {
      expect(await verifyAdminCookieValue(secret, value, NOW)).toBe(false);
    },
  );
});

describe("adminPasswordMatches", () => {
  test("accepts the configured password", async () => {
    expect(
      await adminPasswordMatches(secret, "correct horse battery", "correct horse battery"),
    ).toBe(true);
  });

  test.each(["", "correct horse", "correct horse battery ", "Correct horse battery"])(
    "rejects %j",
    async (supplied) => {
      expect(await adminPasswordMatches(secret, "correct horse battery", supplied)).toBe(false);
    },
  );
});
