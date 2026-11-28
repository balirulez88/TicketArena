import { describe, expect, it } from "vitest";
import { type DeadLetter, deadLetterCopies, readDeadLetters } from "./dead-letter.js";
import type { PublishInput, ReceivedMessage } from "./message-bus.js";

const letter: DeadLetter = {
  consumer: "unit",
  subject: "ta.order.unit",
  streamSeq: 7,
  deliveryCount: 2,
  error: { cause: "handler_poison", message: "unknown_order" },
  envelope: `{"pad":"${"é".repeat(3_000)}${"x".repeat(9_000)}"}`,
};

/** A published copy as the broker would hand it back. */
function received(copy: PublishInput): ReceivedMessage {
  return {
    subject: copy.subject,
    data: copy.data,
    msgId: copy.msgId,
    ...(copy.headers === undefined ? {} : { headers: copy.headers }),
    streamSeq: 1,
    deliveryCount: 1,
    working: () => undefined,
    ack: () => undefined,
    nak: () => undefined,
    term: () => undefined,
  };
}

describe("split DLQ copies", () => {
  it("gives each layout its own part ids, so a changed max_payload never reuses an old part's id", () => {
    const narrow = deadLetterCopies(letter, "dlq:unit:x", 8 * 1024 + 9_000);
    const wide = deadLetterCopies(letter, "dlq:unit:x", 8 * 1024 + 12_000);

    expect(narrow).toHaveLength(2);
    expect(wide).toHaveLength(2);
    const narrowIds = new Set(narrow.map((copy) => copy.msgId));
    expect(wide.some((copy) => narrowIds.has(copy.msgId))).toBe(false);
  });

  it("reads the complete layout and ignores an incomplete older one of the same copy", () => {
    const [oldPart1] = deadLetterCopies(letter, "dlq:unit:x", 8 * 1024 + 9_000);
    const complete = deadLetterCopies(letter, "dlq:unit:x", 8 * 1024 + 12_000);
    if (oldPart1 === undefined) {
      throw new Error("no part 1");
    }

    expect(readDeadLetters([oldPart1, ...complete].map(received))).toEqual([letter]);
  });

  it("refuses parts from two layouts joined under one layout, by the digest", () => {
    const [part1] = deadLetterCopies(letter, "dlq:unit:x", 8 * 1024 + 9_000);
    const [, part2] = deadLetterCopies(letter, "dlq:unit:x", 8 * 1024 + 12_000);
    if (part1 === undefined || part2 === undefined) {
      throw new Error("missing part");
    }
    // Part 2 relabelled as the first layout's: what layout-free ids let the broker store.
    const mixed = { ...part2, headers: { ...part2.headers, ...pick(part1.headers) } };

    expect(() => readDeadLetters([part1, mixed].map(received))).toThrow(
      /does not match its digest/,
    );
  });

  it("reads the whole copy a retry stored unsplit after max_payload grew, ignoring the older part 1", () => {
    const [oldPart1] = deadLetterCopies(letter, "dlq:unit:x", 8 * 1024 + 9_000);
    const whole = deadLetterCopies(letter, "dlq:unit:x", 8 * 1024 * 1024);
    if (oldPart1 === undefined) {
      throw new Error("no part 1");
    }
    expect(whole).toHaveLength(1);

    const letters = readDeadLetters([oldPart1, ...whole].map(received));

    expect(letters).toEqual([letter]);
    expect(Buffer.from(letters[0]?.envelope ?? "").equals(Buffer.from(letter.envelope))).toBe(true);
  });

  it("still reports a split copy with no complete layout as missing parts", () => {
    const [part1] = deadLetterCopies(letter, "dlq:unit:x", 8 * 1024 + 9_000);
    if (part1 === undefined) {
      throw new Error("no part 1");
    }

    expect(() => readDeadLetters([received(part1)])).toThrow(/missing parts/);
  });
});

function pick(headers: PublishInput["headers"]): Record<string, string> {
  const layout = headers?.["TA-DLQ-Layout"];
  return layout === undefined ? {} : { "TA-DLQ-Layout": layout };
}
