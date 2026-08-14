import fs from 'node:fs';
import path from 'node:path';
import { KNOWN_VERBS, PAGE_LEAD_VERBS, SCHEMA_VERSION, type ActionStatus, type V2Document } from './v2.ts';

/**
 * The v2 contract, enforced locally before anything leaves this machine.
 *
 * Two layers, both from the upstream spec: the JSON Schema's own constraints
 * (schema_v2.json, draft 2020-12, additionalProperties:false everywhere) and
 * README §6's nine rules that consumers enforce on top of it. A submission that
 * fails here would be rejected downstream, so it fails loudly here instead —
 * one bad run should not be discovered after 30 tasks and three hours.
 */

// Upstream writes this as ^[A-Za-z0-9_\-]+$; the escape is redundant in a JS class.
const TASK_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const SCREENSHOT_PATTERN = /^(\d{4}|\d+_full_screenshot_\d+)\.(png|jpg|jpeg|webp)$/;
const DOCUMENT_KEYS = new Set([
  'schema_version',
  'task',
  'task_id',
  'agent_final_answer',
  'reference_length',
  'action_history',
]);
const STEP_KEYS = new Set(['step', 'screenshot', 'url', 'action', 'action_status', 'thought']);

export interface ParsedAction {
  verb: string;
  /** `page`, `coords(x, y)`, or a selector. Null for TASK_COMPLETE. */
  target: string | null;
  description: string;
  status: ActionStatus | null;
}

/**
 * Grammar A, both of its shapes:
 *   `<target> -> <VERB> -> <description> | <STATUS>`  (NAVIGATE, GO_BACK, GO_FORWARD, REFRESH)
 *   `<VERB> <target> -> <description> | <STATUS>`     (everything else)
 *
 * The verb is matched against the dictionary rather than a generic pattern, so
 * a description containing an arrow cannot be mistaken for a second verb.
 */
export function parseAction(action: string): ParsedAction | null {
  const text = action.trim();

  if (text.startsWith('TASK_COMPLETE')) {
    const answer = text.replace(/^TASK_COMPLETE\s*->\s*ANSWER:\s*/, '');
    return {
      verb: 'TASK_COMPLETE',
      target: null,
      description: answer === text ? '' : answer,
      status: null,
    };
  }

  let body = text;
  let status: ActionStatus | null = null;
  const suffix = body.match(/\s\|\s(SUCCESS|FAILED)$/);
  if (suffix) {
    status = suffix[1] as ActionStatus;
    body = body.slice(0, body.length - suffix[0].length);
  }

  const pageLead = body.match(/^(.+?) -> ([A-Z_]+) -> (.*)$/);
  if (pageLead && PAGE_LEAD_VERBS.has(pageLead[2])) {
    return { verb: pageLead[2], target: pageLead[1], description: pageLead[3], status };
  }

  const verbLead = body.match(/^([A-Z_]+)(?:\s+(.+?))? -> (.*)$/);
  if (verbLead && KNOWN_VERBS.has(verbLead[1])) {
    return { verb: verbLead[1], target: verbLead[2] ?? null, description: verbLead[3], status };
  }

  return null;
}

/** Structural + rule errors, in the order they were found. Empty means valid. */
export function validateDocument(document: unknown, screenshots?: Set<string>): string[] {
  const errors: string[] = [];
  const fail = (message: string) => errors.push(message);

  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return ['result.json is not a JSON object'];
  }
  const doc = document as Record<string, unknown>;

  for (const key of Object.keys(doc)) {
    if (!DOCUMENT_KEYS.has(key)) fail(`unknown top-level key "${key}" (additionalProperties: false)`);
  }

  // Rule 1.
  if (doc.schema_version !== SCHEMA_VERSION) {
    fail(`schema_version must be "${SCHEMA_VERSION}", got ${JSON.stringify(doc.schema_version)}`);
  }
  if (typeof doc.task !== 'string' || doc.task.length === 0) fail('task must be a non-empty string');

  // Rule 2.
  if (typeof doc.task_id !== 'string' || !TASK_ID_PATTERN.test(doc.task_id)) {
    fail(`task_id must match ${TASK_ID_PATTERN} (bare id, no "tasks/" prefix)`);
  }
  if (doc.agent_final_answer !== null && typeof doc.agent_final_answer !== 'string') {
    fail('agent_final_answer must be a string or null');
  }

  // Rule 9 can only be asserted against the dataset; the schema constraint is
  // all this layer can see, so callers pass the dataset value in and compare.
  if (typeof doc.reference_length !== 'number' || !Number.isInteger(doc.reference_length) || doc.reference_length < 1) {
    fail('reference_length must be an integer >= 1 (the HUMAN reference length)');
  }

  if (!Array.isArray(doc.action_history) || doc.action_history.length < 1) {
    fail('action_history must be a non-empty array');
    return errors;
  }

  const history = doc.action_history as Array<Record<string, unknown>>;
  history.forEach((step, index) => {
    const at = `action_history[${index}]`;
    if (typeof step !== 'object' || step === null || Array.isArray(step)) {
      fail(`${at} is not an object`);
      return;
    }
    for (const key of Object.keys(step)) {
      if (!STEP_KEYS.has(key)) fail(`${at} has unknown key "${key}" (additionalProperties: false)`);
    }

    // Rule 3.
    if (step.step !== index) fail(`${at}.step is ${JSON.stringify(step.step)}, expected ${index}`);

    if (typeof step.screenshot !== 'string' || !SCREENSHOT_PATTERN.test(step.screenshot)) {
      fail(`${at}.screenshot ${JSON.stringify(step.screenshot)} does not match ${SCREENSHOT_PATTERN}`);
    } else if (screenshots && !screenshots.has(step.screenshot)) {
      // Rule 4.
      fail(`${at}.screenshot "${step.screenshot}" does not exist under trajectory/`);
    }

    if (typeof step.action !== 'string' || step.action.length === 0) {
      fail(`${at}.action must be a non-empty string`);
    }
    if (step.url !== undefined && step.url !== null && typeof step.url !== 'string') {
      fail(`${at}.url must be a string or null`);
    }

    // Rule 5 — the key must exist even when the value is null.
    if (!('thought' in step)) fail(`${at} is missing the required "thought" key`);
    else if (step.thought !== null && typeof step.thought !== 'string') {
      fail(`${at}.thought must be a string or null`);
    }

    const statusValue = step.action_status;
    if (statusValue !== undefined && statusValue !== null && statusValue !== 'SUCCESS' && statusValue !== 'FAILED') {
      fail(`${at}.action_status must be "SUCCESS", "FAILED" or null`);
    }

    if (typeof step.action === 'string') {
      const parsed = parseAction(step.action);
      if (!parsed) {
        fail(`${at}.action is not valid Grammar A: ${JSON.stringify(step.action)}`);
      } else if (statusValue != null && parsed.status !== statusValue) {
        // Rule 7.
        fail(`${at}.action_status "${String(statusValue)}" disagrees with the action suffix ${JSON.stringify(parsed.status)}`);
      }
    }
  });

  // Rule 6.
  const last = history[history.length - 1];
  const lastAction = typeof last?.action === 'string' ? last.action : '';
  if (!lastAction.startsWith('TASK_COMPLETE')) {
    fail(`the final step's action must start with TASK_COMPLETE, got ${JSON.stringify(lastAction)}`);
  } else if (typeof doc.agent_final_answer === 'string') {
    const answer = parseAction(lastAction)?.description ?? '';
    if (answer.replace(/\s+/g, ' ').trim() !== doc.agent_final_answer.replace(/\s+/g, ' ').trim()) {
      fail('agent_final_answer does not match the text after "TASK_COMPLETE -> ANSWER:"');
    }
  }

  return errors;
}

export interface ValidateOptions {
  /** Rule 9: the human reference length from the dataset, when it is known. */
  referenceLength?: number;
}

/** Validates a submission directory: result.json against trajectory/ on disk. */
export function validateSubmission(dir: string, options: ValidateOptions = {}): string[] {
  const resultPath = path.join(dir, 'result.json');
  if (!fs.existsSync(resultPath)) return [`${resultPath} does not exist`];

  let document: unknown;
  try {
    document = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  } catch (err) {
    return [`${resultPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`];
  }

  const trajectory = path.join(dir, 'trajectory');
  const files = fs.existsSync(trajectory) ? new Set(fs.readdirSync(trajectory)) : new Set<string>();
  const errors = validateDocument(document, files);

  // Rule 9, the half a lone document cannot check.
  const reference = (document as { reference_length?: unknown }).reference_length;
  if (options.referenceLength !== undefined && reference !== options.referenceLength) {
    errors.push(
      `reference_length is ${String(reference)} but the dataset says ${options.referenceLength} ` +
        '(it is the human reference length, never the submitted step count)',
    );
  }

  // Filenames must sort lexicographically into step order.
  const doc = document as Partial<V2Document>;
  if (Array.isArray(doc.action_history)) {
    const names = doc.action_history.map((step) => step.screenshot);
    const sorted = [...names].sort();
    if (names.join(' ') !== sorted.join(' ')) {
      errors.push('screenshot filenames do not sort lexicographically into step order');
    }
  }

  return errors;
}

/** Throws with every problem at once — a validator that reports one error per run is a slow loop. */
export function assertValidSubmission(dir: string, options: ValidateOptions = {}): void {
  const errors = validateSubmission(dir, options);
  if (errors.length > 0) {
    throw new Error(`Invalid v2 submission at ${dir}:\n  - ${errors.join('\n  - ')}`);
  }
}
