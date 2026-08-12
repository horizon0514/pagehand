import type { RowSchema } from '../tools/tableScripts';

/**
 * The task ledger is the agent's durable memory: goal, plan, findings and
 * handoff notes live here instead of in the conversation, so they survive
 * context trimming, "continue" turns, and (later) fresh-context episodes.
 */

export type PlanItemStatus = 'pending' | 'in_progress' | 'done' | 'skipped';

export interface PlanItem {
  text: string;
  status: PlanItemStatus;
}

export interface Finding {
  /** Stable dedup key chosen by the model (account id, URL, …). */
  key: string;
  /** One-line human-readable summary. */
  summary: string;
  /** Direct quote or observed value that proves this result meets the goal. */
  evidence?: string;
  /** Why that evidence meets the task's criteria. */
  rationale?: string;
  /** Optional structured payload worth keeping verbatim. */
  data?: Record<string, unknown>;
  createdAt: number;
}

/**
 * How the findings were collected, when they came from extract_rows. Kept on
 * the ledger rather than in module state because it is what makes a run
 * repeatable, and the panel that offers to save it may well be reopened — a
 * side panel is torn down every time it closes.
 */
export interface LedgerExtraction {
  schema: RowSchema;
  /** The page the walk started on, so a re-run knows where to go. */
  url: string;
}

export interface TaskLedger {
  threadId: string;
  goal: string | null;
  plan: PlanItem[];
  findings: Finding[];
  /** Handoff notes, newest last. */
  notes: string[];
  extraction?: LedgerExtraction;
  updatedAt: number;
}

// Caps keep a runaway model from turning the ledger into a second context
// window — the digest injected each step must stay small.
export const MAX_PLAN_ITEMS = 30;
/**
 * Sized for extraction, not for research. A research task saves tens of
 * findings and 200 was ample; extract_rows saves one per table row, and a
 * ten-page list clears 200 without trying. Raising it costs nothing in context:
 * the digest spells out only the newest DIGEST_FINDINGS and counts the rest, so
 * this bounds storage and rendering — both cheap — rather than tokens per step.
 */
export const MAX_FINDINGS = 2_000;
export const MAX_NOTES = 10;
export const MAX_GOAL_CHARS = 500;
export const MAX_PLAN_TEXT_CHARS = 200;
export const MAX_FINDING_SUMMARY_CHARS = 300;
export const MAX_FINDING_EVIDENCE_CHARS = 500;
export const MAX_FINDING_RATIONALE_CHARS = 300;
export const MAX_FINDING_DATA_CHARS = 2_000;
export const MAX_NOTE_CHARS = 500;

export function makeEmptyLedger(threadId: string): TaskLedger {
  return {
    threadId,
    goal: null,
    plan: [],
    findings: [],
    notes: [],
    updatedAt: Date.now(),
  };
}

export function isLedgerEmpty(ledger: TaskLedger): boolean {
  return (
    ledger.goal == null &&
    ledger.plan.length === 0 &&
    ledger.findings.length === 0 &&
    ledger.notes.length === 0
  );
}
