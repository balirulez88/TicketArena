// The debt view reuses scripts/ralph-debt.mjs, the module Ralph's selection and the host's
// importer use, instead of re-implementing its rules: a verdict on this page is the verdict
// `ralph-debt.mjs gate` would print for the same ref. The module is plain JavaScript without type
// declarations, so it is loaded as `unknown` and everything it returns is validated here.

import { z } from "zod";
import type { Ticket } from "./model";

const RALPH_DEBT = new URL("../../../scripts/ralph-debt.mjs", import.meta.url);

const entrySchema = z.object({
  id: z.string(),
  title: z.string(),
  fields: z.record(z.string(), z.string()),
});
const registerSchema = z.object({ entries: z.array(entrySchema) });
const verdictSchema = z.object({
  state: z.enum(["clear", "waiting", "needs-triage"]),
  reasons: z.array(z.string()),
});

export type DebtVerdict = z.infer<typeof verdictSchema>;

export interface DebtEntry {
  id: string;
  title: string;
  status: string;
  severity: string;
  risk: string;
  triage: string;
  target: string;
  blocks: string[];
}

export interface DebtReport {
  entries: DebtEntry[];
  /** Gate verdict per unfinished ticket number, exactly as `debtGate` computed it. */
  verdicts: Map<string, DebtVerdict>;
}

type Fn = (...args: unknown[]) => unknown;
interface RalphDebt {
  parseRegister: Fn;
  debtGate: Fn;
}

const isFn = (value: unknown): value is Fn => typeof value === "function";

let loaded: Promise<RalphDebt> | undefined;

function ralphDebt(): Promise<RalphDebt> {
  loaded ??= import(RALPH_DEBT.href).then((module: unknown) => {
    const exports = (module ?? {}) as Record<string, unknown>;
    const { parseRegister, debtGate } = exports;
    if (!(isFn(parseRegister) && isFn(debtGate))) {
      throw new Error(`${RALPH_DEBT.pathname} no longer exports parseRegister and debtGate`);
    }
    return { parseRegister, debtGate };
  });
  return loaded;
}

const field = (entry: z.infer<typeof entrySchema>, name: string, fallback: string): string =>
  entry.fields[name] ?? fallback;

/**
 * Parses the register and runs Ralph's debt gate over `tickets`. Throws with the module's own
 * message when the register is invalid; the caller reports that as unavailable.
 */
export async function evaluateDebt(registerText: string, tickets: Ticket[]): Promise<DebtReport> {
  const module = await ralphDebt();
  const register = module.parseRegister(registerText);
  const { entries } = registerSchema.parse(register);
  // debtGate needs only number, status and blockers: the shape ralph-debt's parseTicket returns.
  const gateInput = new Map(
    tickets.map((ticket) => [
      ticket.number,
      { number: ticket.number, status: ticket.status, blockedBy: ticket.blockedBy },
    ]),
  );
  const rawVerdicts = module.debtGate(register, gateInput);
  if (!(rawVerdicts instanceof Map)) {
    throw new Error("debtGate did not return a Map");
  }
  const verdicts = new Map<string, DebtVerdict>();
  for (const [number, verdict] of rawVerdicts) {
    verdicts.set(String(number), verdictSchema.parse(verdict));
  }
  return {
    entries: entries.map((entry) => ({
      id: entry.id,
      title: entry.title,
      status: field(entry, "Status", "unknown"),
      severity: field(entry, "Severity", "unknown"),
      risk: field(entry, "Risk", "UNTRIAGED"),
      triage: field(entry, "Triage", "pending"),
      target: field(entry, "Target", "none"),
      blocks: (field(entry, "Blocks", "none") === "none" ? "" : field(entry, "Blocks", ""))
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part !== ""),
    })),
    verdicts,
  };
}
