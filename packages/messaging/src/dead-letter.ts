import { createHash } from "node:crypto";
import type { PublishInput, ReceivedMessage } from "./message-bus.js";

/** Why a message was dead-lettered. */
export type DeadLetterCause =
  | "retry_budget_exhausted"
  | "schema_invalid"
  | "unknown_version"
  | "handler_poison"
  | "missing_msg_id";

const CAUSES: readonly DeadLetterCause[] = [
  "retry_budget_exhausted",
  "schema_invalid",
  "unknown_version",
  "handler_poison",
  "missing_msg_id",
];

/** A dead-lettered message as `readDeadLetters` returns it. */
export interface DeadLetter {
  readonly consumer: string;
  /** The original subject, without any namespace the adapter adds. */
  readonly subject: string;
  readonly streamSeq: number;
  readonly deliveryCount: number;
  readonly error: { readonly cause: DeadLetterCause; readonly message: string };
  /** The original message data, unchanged (it may not even be JSON). */
  readonly envelope: string;
}

/**
 * The wire format of a DLQ copy: the metadata travels in these headers and the body is the
 * original data, unchanged. A wrapper around the body (a JSON envelope, say) would grow it, and a
 * message that only just fitted the broker's `max_payload` could then never be dead-lettered.
 */
export const DEAD_LETTER_HEADERS = {
  consumer: "TA-DLQ-Consumer",
  subject: "TA-DLQ-Subject",
  streamSeq: "TA-DLQ-Stream-Seq",
  deliveryCount: "TA-DLQ-Delivery-Count",
  cause: "TA-DLQ-Cause",
  reason: "TA-DLQ-Reason",
  /** `<n>/<total>`, only on a copy split into parts. */
  part: "TA-DLQ-Part",
  /** The part size in bytes the copy was split with, only on a split copy. */
  layout: "TA-DLQ-Layout",
  /** SHA-256 (hex) of the whole original, only on a split copy: checked when parts are joined. */
  digest: "TA-DLQ-Digest",
} as const;

// Room kept for the headers of each part of a split copy. The reason is capped below so every
// header together stays well inside it (the cap is in UTF-16 units: at most 3 bytes each).
const HEADER_RESERVE_BYTES = 8 * 1024;
const MAX_REASON_LENGTH = 1024;
const PART_SEPARATOR = ":part:";

/**
 * The publishes that make up the DLQ copy of `letter` under `dlqId`. One publish when the original
 * leaves room for the headers under `maxPayloadBytes` (or no limit is known); otherwise the
 * original is split, on character boundaries, into parts that each fit, published under
 * `<dlqId>:part:<layout>:<n>/<total>`, where the layout is the part size.
 *
 * The layout is in the id because the split offsets depend on the limit. With the same limit a
 * redelivery after a crash republishes the same ids and the broker's duplicate window drops every
 * part. With a changed limit the parts are cut elsewhere, and under layout-free ids a retry could
 * get a duplicate PubAck for an old part 1 and store a new part 2 beside it, joining bytes of two
 * layouts. A new layout therefore gets new ids and is stored whole; the reader joins parts per
 * layout and checks the whole original's digest.
 */
export function deadLetterCopies(
  letter: DeadLetter,
  dlqId: string,
  maxPayloadBytes: number | undefined,
): PublishInput[] {
  const subject = `ta.dlq.${letter.consumer}`;
  const headers = {
    [DEAD_LETTER_HEADERS.consumer]: letter.consumer,
    [DEAD_LETTER_HEADERS.subject]: letter.subject,
    [DEAD_LETTER_HEADERS.streamSeq]: String(letter.streamSeq),
    [DEAD_LETTER_HEADERS.deliveryCount]: String(letter.deliveryCount),
    [DEAD_LETTER_HEADERS.cause]: letter.error.cause,
    [DEAD_LETTER_HEADERS.reason]: headerSafe(letter.error.message),
  };
  const room = maxPayloadBytes === undefined ? 0 : maxPayloadBytes - HEADER_RESERVE_BYTES;
  // No known limit, or one smaller than the reserve (no real broker): a single copy, which such a
  // broker refuses if it is too large, so the message is naked, never termed.
  if (room <= 0 || Buffer.byteLength(letter.envelope) <= room) {
    return [{ subject, data: letter.envelope, msgId: dlqId, headers }];
  }
  const parts = splitByBytes(letter.envelope, room);
  const layout = String(room);
  const digest = sha256(letter.envelope);
  return parts.map((data, index) => {
    const part = `${index + 1}/${parts.length}`;
    return {
      subject,
      data,
      msgId: `${dlqId}${PART_SEPARATOR}${layout}:${part}`,
      headers: {
        ...headers,
        [DEAD_LETTER_HEADERS.part]: part,
        [DEAD_LETTER_HEADERS.layout]: layout,
        [DEAD_LETTER_HEADERS.digest]: digest,
      },
    };
  });
}

/**
 * The dead letters a set of DLQ copies (one consumer's `ta.dlq.<consumer>`) holds, in the order
 * their copies complete. The parts of a split copy are joined per layout and checked against the
 * original's digest. An incomplete layout is ignored when another layout of the same copy is
 * complete, or when the copy was also stored unsplit (a retry after a `max_payload` change stores a
 * whole new layout, or the whole original once it fits). Throws on a message
 * that is not a DLQ copy, on a joined copy whose digest does not match, and on a split copy with no
 * complete layout.
 */
export function readDeadLetters(copies: readonly ReceivedMessage[]): DeadLetter[] {
  const letters: DeadLetter[] = [];
  const pending = new Map<string, { base: string; total: number; parts: Map<number, string> }>();
  const completed = new Set<string>();
  for (const copy of copies) {
    const part = copy.headers?.[DEAD_LETTER_HEADERS.part];
    if (part === undefined) {
      // An unsplit copy is complete for its DLQ id: a retry after `max_payload` grew stores the
      // whole original under the bare id, beside any part a smaller limit left behind.
      completed.add(copy.msgId ?? "");
      letters.push(readLetter(copy, copy.data));
      continue;
    }
    const msgId = copy.msgId ?? "";
    const [index, total] = part.split("/").map(Number);
    if (index === undefined || total === undefined || !(index >= 1 && index <= total)) {
      throw new Error(`DLQ copy ${msgId} has an invalid ${DEAD_LETTER_HEADERS.part}: ${part}`);
    }
    const base = msgId.slice(0, msgId.lastIndexOf(PART_SEPARATOR));
    const layout = copy.headers?.[DEAD_LETTER_HEADERS.layout] ?? "";
    const groupKey = `${base}\u0000${layout}`;
    const group = pending.get(groupKey) ?? { base, total, parts: new Map<number, string>() };
    group.parts.set(index, copy.data);
    pending.set(groupKey, group);
    if (group.parts.size === group.total) {
      pending.delete(groupKey);
      completed.add(base);
      letters.push(readLetter(copy, joinParts(group, copy, layout)));
    }
  }
  const incomplete = [...pending.values()].find((group) => !completed.has(group.base));
  if (incomplete !== undefined) {
    throw new Error(`DLQ copy ${incomplete.base} is missing parts`);
  }
  return letters;
}

/** The parts of one layout joined in order, refused unless they hash to the original's digest. */
function joinParts(
  group: { base: string; total: number; parts: Map<number, string> },
  copy: ReceivedMessage,
  layout: string,
): string {
  const data = Array.from({ length: group.total }, (_, i) => group.parts.get(i + 1) ?? "").join("");
  if (copy.headers?.[DEAD_LETTER_HEADERS.digest] !== sha256(data)) {
    throw new Error(`DLQ copy ${group.base} (layout ${layout}) does not match its digest`);
  }
  return data;
}

function readLetter(copy: ReceivedMessage, envelope: string): DeadLetter {
  const header = (name: string): string => {
    const value = copy.headers?.[name];
    if (value === undefined) {
      throw new Error(`DLQ copy ${copy.msgId ?? "(no id)"} has no ${name} header`);
    }
    return value;
  };
  const cause = header(DEAD_LETTER_HEADERS.cause);
  const known = CAUSES.find((candidate) => candidate === cause);
  if (known === undefined) {
    throw new Error(`DLQ copy ${copy.msgId ?? "(no id)"} has an unknown cause: ${cause}`);
  }
  return {
    consumer: header(DEAD_LETTER_HEADERS.consumer),
    subject: header(DEAD_LETTER_HEADERS.subject),
    streamSeq: Number(header(DEAD_LETTER_HEADERS.streamSeq)),
    deliveryCount: Number(header(DEAD_LETTER_HEADERS.deliveryCount)),
    error: { cause: known, message: header(DEAD_LETTER_HEADERS.reason) },
    envelope,
  };
}

/** A header value: one line (NATS refuses CR and LF), capped so the headers stay bounded. */
function headerSafe(reason: string): string {
  return reason.replace(/[\r\n]+/g, " ").slice(0, MAX_REASON_LENGTH);
}

/** `data` cut into pieces of at most `maxBytes` UTF-8 bytes, never inside a character. */
function splitByBytes(data: string, maxBytes: number): string[] {
  const parts: string[] = [];
  let start = 0;
  let bytes = 0;
  for (let i = 0; i < data.length; ) {
    const codePoint = data.codePointAt(i) ?? 0;
    const size = codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
    if (bytes + size > maxBytes) {
      parts.push(data.slice(start, i));
      start = i;
      bytes = 0;
    }
    bytes += size;
    i += codePoint > 0xffff ? 2 : 1;
  }
  parts.push(data.slice(start));
  return parts;
}

function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}
