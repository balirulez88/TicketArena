import { describe, expect, test } from "vitest";
import {
  parseAdminEnv,
  parseAdmissionEnv,
  parseDatabaseEnv,
  parseMetricsEnv,
  parseQueueEnv,
  parseServerEnv,
  parseSessionEnv,
} from "./env";

const validEnv = {
  DATABASE_URL: "postgresql://user:pass@db.example.com/ticketarena?sslmode=require",
  UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
  UPSTASH_REDIS_REST_TOKEN: "token",
  REDIS_URL: "rediss://default:secret@example.upstash.io:6379",
  SESSION_SECRET: "s".repeat(32),
  ADMISSION_SECRET: "a".repeat(32),
  ADMIN_PASSWORD: "correct horse battery",
};

describe("parseServerEnv", () => {
  test("accepts a complete, well-formed environment", () => {
    expect(parseServerEnv(validEnv).UPSTASH_REDIS_REST_TOKEN).toBe("token");
  });

  test("names the missing variable when configuration is incomplete", () => {
    const { UPSTASH_REDIS_REST_TOKEN: _omitted, ...incomplete } = validEnv;
    expect(() => parseServerEnv(incomplete)).toThrow(/UPSTASH_REDIS_REST_TOKEN/);
  });

  test("rejects a database URL that is not Postgres", () => {
    expect(() => parseServerEnv({ ...validEnv, DATABASE_URL: "mysql://db.example.com/x" })).toThrow(
      /DATABASE_URL/,
    );
  });

  test("names SESSION_SECRET when it is missing", () => {
    const { SESSION_SECRET: _omitted, ...incomplete } = validEnv;
    expect(() => parseServerEnv(incomplete)).toThrow(/SESSION_SECRET/);
  });

  test("names SESSION_SECRET when it is shorter than 32 bytes", () => {
    expect(() => parseServerEnv({ ...validEnv, SESSION_SECRET: "short" })).toThrow(
      /SESSION_SECRET/,
    );
  });
});

describe("parseServerEnv ADMISSION_SECRET", () => {
  test("names ADMISSION_SECRET when it is missing", () => {
    const { ADMISSION_SECRET: _omitted, ...incomplete } = validEnv;
    expect(() => parseServerEnv(incomplete)).toThrow(/ADMISSION_SECRET/);
  });

  test("names ADMISSION_SECRET when it is shorter than 32 bytes", () => {
    expect(() => parseServerEnv({ ...validEnv, ADMISSION_SECRET: "a".repeat(31) })).toThrow(
      /ADMISSION_SECRET/,
    );
  });

  test("counts bytes, not characters", () => {
    // 16 two-byte characters are 32 bytes.
    expect(parseServerEnv({ ...validEnv, ADMISSION_SECRET: "é".repeat(16) }).ADMISSION_SECRET).toBe(
      "é".repeat(16),
    );
  });
});

describe("parseAdmissionEnv", () => {
  test("returns the admission secret, ignoring unrelated variables", () => {
    expect(parseAdmissionEnv({ ADMISSION_SECRET: "a".repeat(32), REDIS_URL: "" })).toEqual({
      ADMISSION_SECRET: "a".repeat(32),
    });
  });

  test("names ADMISSION_SECRET when it is missing", () => {
    expect(() => parseAdmissionEnv({})).toThrow(/ADMISSION_SECRET/);
  });
});

describe("parseServerEnv ADMIN_PASSWORD", () => {
  test("names ADMIN_PASSWORD when it is missing", () => {
    const { ADMIN_PASSWORD: _omitted, ...incomplete } = validEnv;
    expect(() => parseServerEnv(incomplete)).toThrow(/ADMIN_PASSWORD/);
  });

  test("names ADMIN_PASSWORD when it is shorter than 12 characters", () => {
    expect(() => parseServerEnv({ ...validEnv, ADMIN_PASSWORD: "short" })).toThrow(
      /ADMIN_PASSWORD/,
    );
  });
});

describe("parseAdminEnv", () => {
  test("returns the admin password and session secret, ignoring unrelated variables", () => {
    expect(
      parseAdminEnv({
        ADMIN_PASSWORD: "correct horse battery",
        SESSION_SECRET: "s".repeat(32),
        REDIS_URL: "",
      }),
    ).toEqual({ ADMIN_PASSWORD: "correct horse battery", SESSION_SECRET: "s".repeat(32) });
  });

  test("names ADMIN_PASSWORD when it is missing", () => {
    expect(() => parseAdminEnv({ SESSION_SECRET: "s".repeat(32) })).toThrow(/ADMIN_PASSWORD/);
  });
});

describe("parseSessionEnv", () => {
  test("ignores unrelated missing or invalid variables", () => {
    expect(
      parseSessionEnv({ SESSION_SECRET: "s".repeat(32), UPSTASH_REDIS_REST_TOKEN: "" }),
    ).toEqual({ SESSION_SECRET: "s".repeat(32) });
  });

  test("names SESSION_SECRET when it is missing", () => {
    expect(() => parseSessionEnv({})).toThrow(/SESSION_SECRET/);
  });
});

describe("parseMetricsEnv", () => {
  const valid = {
    UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
    UPSTASH_REDIS_REST_TOKEN: "t",
  };

  test("accepts a valid URL and token and ignores unrelated variables", () => {
    expect(parseMetricsEnv({ ...valid, SESSION_SECRET: "short" })).toEqual(valid);
  });

  test("names UPSTASH_REDIS_REST_URL when it is missing", () => {
    expect(() => parseMetricsEnv({ UPSTASH_REDIS_REST_TOKEN: "t" })).toThrow(
      /UPSTASH_REDIS_REST_URL/,
    );
  });

  test("names UPSTASH_REDIS_REST_URL when it is not https", () => {
    expect(() =>
      parseMetricsEnv({ ...valid, UPSTASH_REDIS_REST_URL: "http://example.upstash.io" }),
    ).toThrow(/UPSTASH_REDIS_REST_URL/);
  });

  test("accepts plain http only for a local endpoint", () => {
    for (const url of ["http://localhost:8079", "http://127.0.0.1:8079", "http://[::1]:8079"]) {
      expect(
        parseMetricsEnv({ ...valid, UPSTASH_REDIS_REST_URL: url }).UPSTASH_REDIS_REST_URL,
      ).toBe(url);
    }
    expect(() =>
      parseMetricsEnv({ ...valid, UPSTASH_REDIS_REST_URL: "http://redis-http:80" }),
    ).toThrow(/UPSTASH_REDIS_REST_URL/);
  });

  test("names UPSTASH_REDIS_REST_URL when it is not a URL at all", () => {
    expect(() => parseMetricsEnv({ ...valid, UPSTASH_REDIS_REST_URL: "not a url" })).toThrow(
      /UPSTASH_REDIS_REST_URL/,
    );
  });

  test("names UPSTASH_REDIS_REST_TOKEN when it is empty", () => {
    expect(() => parseMetricsEnv({ ...valid, UPSTASH_REDIS_REST_TOKEN: "" })).toThrow(
      /UPSTASH_REDIS_REST_TOKEN/,
    );
  });
});

describe("parseQueueEnv", () => {
  test("accepts a redis or rediss URL and ignores unrelated variables", () => {
    expect(parseQueueEnv({ REDIS_URL: "redis://localhost:6379", SESSION_SECRET: "x" })).toEqual({
      REDIS_URL: "redis://localhost:6379",
    });
    expect(parseQueueEnv({ REDIS_URL: "rediss://example.upstash.io:6379" }).REDIS_URL).toBe(
      "rediss://example.upstash.io:6379",
    );
  });

  test("names REDIS_URL when it is missing or not a Redis URL", () => {
    expect(() => parseQueueEnv({})).toThrow(/REDIS_URL/);
    expect(() => parseQueueEnv({ REDIS_URL: "https://example.upstash.io" })).toThrow(/REDIS_URL/);
  });
});

describe("parseDatabaseEnv", () => {
  const url = "postgresql://user:pass@localhost:5432/ticketarena";

  test("defaults DATABASE_DRIVER to neon", () => {
    expect(parseDatabaseEnv({ DATABASE_URL: url })).toEqual({
      DATABASE_URL: url,
      DATABASE_DRIVER: "neon",
    });
  });

  test("accepts pg for a local Postgres", () => {
    expect(parseDatabaseEnv({ DATABASE_URL: url, DATABASE_DRIVER: "pg" }).DATABASE_DRIVER).toBe(
      "pg",
    );
  });

  test("names DATABASE_DRIVER when it is neither neon nor pg", () => {
    expect(() => parseDatabaseEnv({ DATABASE_URL: url, DATABASE_DRIVER: "PG" })).toThrow(
      /DATABASE_DRIVER/,
    );
  });
});
