import { loadLedger, saveLedger } from './ledgerStore';
import {
  makeEmptyLedger,
  MAX_FINDING_DATA_CHARS,
  MAX_FINDING_EVIDENCE_CHARS,
  MAX_FINDING_RATIONALE_CHARS,
  MAX_FINDING_SUMMARY_CHARS,
  MAX_FINDINGS,
  MAX_GOAL_CHARS,
  MAX_NOTE_CHARS,
  MAX_NOTES,
  MAX_PLAN_ITEMS,
  MAX_PLAN_TEXT_CHARS,
  type Finding,
  type LedgerExtraction,
  type PlanItem,
  type TaskLedger,
} from './types';

/**
 * The ledger of the thread currently shown in the side panel. Ledger tools run
 * deep in the tool layer with no access to UI state, so — like the bound-tab
 * binding in tools/context.ts — the active thread is module state, set by the
 * panel when a thread is opened and re-asserted before each turn.
 */
let active: TaskLedger | null = null;

const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Subscribe to active-ledger changes (UI). Returns an unsubscribe function. */
export function subscribeLedger(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getActiveLedger(): TaskLedger | null {
  return active;
}

/** Load (or create) the ledger for a thread and make it the active one. */
export async function activateLedger(threadId: string): Promise<TaskLedger> {
  active = (await loadLedger(threadId)) ?? makeEmptyLedger(threadId);
  notify();
  return active;
}

/** Test helper. */
export function resetActiveLedger(): void {
  active = null;
  notify();
}

function requireActive(): TaskLedger {
  if (!active) {
    throw new Error('No active task ledger — the side panel has not opened a thread yet.');
  }
  return active;
}

async function commit(next: TaskLedger): Promise<TaskLedger> {
  active = { ...next, updatedAt: Date.now() };
  await saveLedger(active);
  notify();
  return active;
}

function clamp(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

export type LedgerMutation =
  | { type: 'set_goal'; goal: string }
  | { type: 'replace_plan'; plan: Array<{ text: string; status?: PlanItem['status'] }> }
  | {
      type: 'set_plan_status';
      /** 1-based index matching the digest numbering (`1. [pending] …`). */
      step: number;
      status: PlanItem['status'];
    }
  | {
      type: 'upsert_finding';
      finding: {
        key: string;
        summary: string;
        evidence?: string;
        rationale?: string;
        data?: Record<string, unknown>;
      };
    }
  | { type: 'remove_finding'; key: string; reason: string }
  | { type: 'add_note'; text: string }
  // Not reachable from update_task_ledger — ledgerTools declares the model's
  // mutation union separately, and this one is written by extract_rows.
  | { type: 'set_extraction'; extraction: LedgerExtraction };

/**
 * Apply a heterogeneous batch atomically. The model gets one stable task-state
 * interface while this module keeps the ledger's typed invariants private.
 */
export async function applyLedgerMutations(mutations: LedgerMutation[]): Promise<TaskLedger> {
  let next = requireActive();

  for (const mutation of mutations) {
    switch (mutation.type) {
      case 'set_goal':
        next = { ...next, goal: clamp(mutation.goal, MAX_GOAL_CHARS) };
        break;
      case 'replace_plan':
        next = {
          ...next,
          plan: mutation.plan.slice(0, MAX_PLAN_ITEMS).map((item) => ({
            text: clamp(item.text, MAX_PLAN_TEXT_CHARS),
            status: item.status ?? 'pending',
          })),
        };
        break;
      case 'set_plan_status': {
        const index = mutation.step - 1;
        if (!Number.isInteger(mutation.step) || index < 0 || index >= next.plan.length) {
          throw new Error(
            `Plan step ${mutation.step} is out of range (plan has ${next.plan.length} step(s); use 1-based indexes).`,
          );
        }
        next = {
          ...next,
          plan: next.plan.map((item, i) => {
            if (i === index) return { ...item, status: mutation.status };
            // At most one in-progress step — starting a new one clears the old marker.
            if (mutation.status === 'in_progress' && item.status === 'in_progress') {
              return { ...item, status: 'pending' };
            }
            return item;
          }),
        };
        break;
      }
      case 'upsert_finding': {
        const input = mutation.finding;
        const key = clamp(input.key, 200);
        const existing = next.findings.find((finding) => finding.key === key);
        if (!existing && next.findings.length >= MAX_FINDINGS) {
          throw new Error(`Findings limit reached (${MAX_FINDINGS}) — the task result set is full.`);
        }
        const data =
          input.data !== undefined && JSON.stringify(input.data).length <= MAX_FINDING_DATA_CHARS
            ? input.data
            : undefined;
        const finding: Finding = {
          key,
          summary: clamp(input.summary, MAX_FINDING_SUMMARY_CHARS),
          ...(input.evidence !== undefined
            ? { evidence: clamp(input.evidence, MAX_FINDING_EVIDENCE_CHARS) }
            : {}),
          ...(input.rationale !== undefined
            ? { rationale: clamp(input.rationale, MAX_FINDING_RATIONALE_CHARS) }
            : {}),
          ...(data !== undefined ? { data } : {}),
          createdAt: existing?.createdAt ?? Date.now(),
        };
        next = {
          ...next,
          findings: [...next.findings.filter((item) => item.key !== key), finding],
        };
        break;
      }
      case 'remove_finding':
        next = {
          ...next,
          findings: next.findings.filter((finding) => finding.key !== clamp(mutation.key, 200)),
        };
        break;
      case 'add_note':
        next = {
          ...next,
          notes: [...next.notes, clamp(mutation.text, MAX_NOTE_CHARS)].slice(-MAX_NOTES),
        };
        break;
      case 'set_extraction':
        next = { ...next, extraction: mutation.extraction };
        break;
    }
  }

  return commit(next);
}
