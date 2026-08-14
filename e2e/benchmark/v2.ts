import fs from 'node:fs';
import path from 'node:path';
import type { BenchRunResult, BenchStep } from '../../src/e2e/bench/recorder.ts';

/**
 * Pagehand trajectory -> Online-Mind2Web v2 submission.
 *
 * Grammar A throughout (README §4.1 requires one grammar per submission), and
 * one tool call maps to at most one v2 step — that keeps step, screenshot, url
 * and thought locked together, which is the whole reason v2 exists.
 *
 * The v2 document is closed (`additionalProperties: false` everywhere), so
 * anything Pagehand knows but v2 does not model — token counts, timings, the
 * bookkeeping tool calls — goes to a sibling raw_trace.json instead.
 */

export const SCHEMA_VERSION = 'online-mind2web-v2';

export type ActionStatus = 'SUCCESS' | 'FAILED';

export interface V2ActionStep {
  step: number;
  screenshot: string;
  url: string | null;
  action: string;
  action_status: ActionStatus | null;
  /** Required key; the value may be null but the key must never be omitted. */
  thought: string | null;
}

export interface V2Document {
  schema_version: typeof SCHEMA_VERSION;
  task: string;
  task_id: string;
  agent_final_answer: string | null;
  reference_length: number;
  action_history: V2ActionStep[];
}

export interface MappedAction {
  verb: string;
  /** `page`, `coords(x, y)`, or a selector. Null only for TASK_COMPLETE. */
  target: string | null;
  description: string;
  status: ActionStatus | null;
}

/**
 * Verbs the dictionary writes as `page -> VERB -> …`; every other verb is
 * written `VERB <target> -> …`. Both shapes appear in the upstream example and
 * in README §4.1, and which verb takes which shape is not negotiable — the
 * golden-fixture round trip in v2.test.ts pins it.
 */
export const PAGE_LEAD_VERBS = new Set(['NAVIGATE', 'GO_BACK', 'GO_FORWARD', 'REFRESH']);

export const KNOWN_VERBS = new Set([
  'NAVIGATE',
  'CLICK',
  'TYPE',
  'SCROLL',
  'HOVER',
  'WAIT',
  'PRESS_KEY',
  'SELECT',
  'GO_BACK',
  'GO_FORWARD',
  'REFRESH',
  'TASK_COMPLETE',
]);

/** Bookkeeping, not actions on the page. Kept in raw_trace.json only. */
export const EXCLUDED_TOOLS = new Set([
  'update_task_ledger',
  'control_task',
  'list_pages',
  'list_console_messages',
  'get_console_message',
  'list_network_requests',
  'get_network_request',
  'infer_row_schema',
  'extract_rows',
  // Disabled during benchmark runs; a call that got through is recorded raw.
  'web_search',
]);

const MAX_DESCRIPTION_CHARS = 220;

/**
 * A 1×1 PNG, used only when both the CDP capture and the in-page placeholder
 * failed. v2 rule 4 (every referenced screenshot exists) is absolute, and a
 * missing file would invalidate the whole submission over one bad frame.
 */
const FALLBACK_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** Descriptions are factual and single-line; the grammar's separators must not appear inside one. */
export function sanitizeDescription(text: string): string {
  const flat = text.replace(/\s+/g, ' ').replace(/->/g, '→').replace(/\|/g, '/').trim();
  return flat.length > MAX_DESCRIPTION_CHARS ? `${flat.slice(0, MAX_DESCRIPTION_CHARS - 1)}…` : flat;
}

export function formatAction(action: MappedAction): string {
  if (action.verb === 'TASK_COMPLETE') {
    return action.description ? `TASK_COMPLETE -> ANSWER: ${action.description}` : 'TASK_COMPLETE -> ANSWER:';
  }

  const suffix = action.status ? ` | ${action.status}` : '';
  const target = action.target ?? 'page';
  return PAGE_LEAD_VERBS.has(action.verb)
    ? `${target} -> ${action.verb} -> ${action.description}${suffix}`
    : `${action.verb} ${target} -> ${action.description}${suffix}`;
}

function coordsTarget(step: BenchStep): string {
  return step.coords ? `coords(${step.coords.x}, ${step.coords.y})` : 'page';
}

function quoted(value: unknown, max = 80): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `"${text.slice(0, max - 1)}…"` : `"${text}"`;
}

/**
 * evaluate_script has no v2 verb — one call can read, scroll, click, or all
 * three. The source is the only evidence available, so the verb is inferred
 * from it and the source itself goes in the description for a human reviewer.
 * This is approximate and belongs in the submission notes as a known limitation.
 */
export function verbForScript(source: string): string {
  if (/scrollBy|scrollTo|scrollIntoView|window\.scrollY/.test(source)) return 'SCROLL';
  if (/\.click\(/.test(source)) return 'CLICK';
  if (/\.value\s*=|InputEvent|dispatchEvent/.test(source)) return 'TYPE';
  return 'WAIT';
}

/** One recorded tool call -> one v2 action, or null when the call is bookkeeping. */
export function mapStep(step: BenchStep): MappedAction | null {
  if (EXCLUDED_TOOLS.has(step.tool)) return null;

  const args = (step.args ?? {}) as Record<string, unknown>;
  const status = step.status;
  const page = (verb: string, description: string): MappedAction => ({
    verb,
    target: 'page',
    description: sanitizeDescription(description),
    status,
  });
  const onElement = (verb: string, description: string): MappedAction => ({
    verb,
    target: coordsTarget(step),
    description: sanitizeDescription(description),
    status,
  });

  switch (step.tool) {
    case 'navigate_page': {
      const type = (args.type as string) ?? 'url';
      if (type === 'back') return page('GO_BACK', 'browser back to the previous page');
      if (type === 'forward') return page('GO_FORWARD', 'browser forward to the next page');
      if (type === 'reload') return page('REFRESH', 'reload the current page');
      // The destination belongs in the step's url field, never in the action string.
      return page('NAVIGATE', 'direct URL navigation to the recorded destination');
    }
    case 'new_page':
      return page('NAVIGATE', 'open the recorded destination in a new tab');
    case 'click':
      return onElement(
        'CLICK',
        args.dblClick === true
          ? `double-click the element at uid=${args.uid}`
          : `click the element at uid=${args.uid}`,
      );
    case 'hover':
      return onElement('HOVER', `hover over the element at uid=${args.uid}`);
    case 'fill':
      return onElement('TYPE', `fill the field at uid=${args.uid} with ${quoted(args.value)}`);
    case 'fill_form': {
      const elements = (args.elements as Array<{ uid?: unknown; value?: unknown }>) ?? [];
      const fields = elements
        .slice(0, 6)
        .map((el) => `uid=${el.uid}=${quoted(el.value, 40)}`)
        .join(', ');
      return onElement('TYPE', `fill ${elements.length} form fields: ${fields}`);
    }
    case 'type_text':
      return page(
        'TYPE',
        args.submitKey
          ? `type ${quoted(args.text)} into the focused element, then press ${args.submitKey}`
          : `type ${quoted(args.text)} into the focused element`,
      );
    case 'press_key':
      return page('PRESS_KEY', `press ${args.key}`);
    case 'wait_for': {
      const texts = ((args.text as string[]) ?? []).slice(0, 4).map((t) => quoted(t, 40)).join(', ');
      return page('WAIT', `wait for text to appear: ${texts}`);
    }
    // Observation steps. README §4.1 sanctions WAIT for exactly this, and their
    // screenshots are real evidence of what the agent was looking at.
    case 'take_snapshot':
      return page('WAIT', 'take an accessibility snapshot of the page');
    case 'extract_content':
      return page('WAIT', `read the page for: ${quoted(args.instruction)}`);
    case 'take_screenshot':
      return page('WAIT', 'take a screenshot of the page');
    case 'select_page':
      return page('WAIT', `rebind the agent to tab ${args.pageId}`);
    case 'close_page':
      return page('WAIT', `close tab ${args.pageId}`);
    case 'evaluate_script': {
      const source = String(args.function ?? '');
      return page(verbForScript(source), `evaluate_script: ${source.slice(0, 120)}`);
    }
    default:
      // A tool added after this table was written: record it honestly rather
      // than dropping a real action on the page.
      return page('WAIT', `${step.tool}: recorded without a v2 verb mapping`);
  }
}

/** v2 rule 8: a NAVIGATE step's url is the destination, not where it started. */
function urlForStep(step: BenchStep, verb: string): string | null {
  if (verb === 'NAVIGATE' || verb === 'GO_BACK' || verb === 'GO_FORWARD' || verb === 'REFRESH') {
    return step.destinationUrl ?? step.url;
  }
  return step.url;
}

export interface SubmissionInput {
  task: string;
  taskId: string;
  /** The HUMAN reference length from the dataset — never our step count. */
  referenceLength: number;
  result: BenchRunResult;
}

export interface SubmissionImage {
  filename: string;
  base64: string;
  placeholder: boolean;
}

export interface Submission {
  document: V2Document;
  images: SubmissionImage[];
  /** Steps whose screenshot is a stand-in rather than a real frame. */
  placeholders: number;
}

function terminalStep(input: SubmissionInput, index: number, lastThought: string | null): {
  step: V2ActionStep;
  image: SubmissionImage;
  answer: string | null;
} {
  const { result } = input;
  const answered = result.finalAnswer !== null && result.finalAnswer.trim().length > 0;
  const answer = answered ? result.finalAnswer!.trim() : null;

  const finishReason = result.stop?.finishReason ?? (result.timedOut ? 'timeout' : result.error ? 'error' : 'unknown');
  const thought = answered
    ? lastThought
    : `Run ended without an answer: ${finishReason}, steps=${result.stop?.steps ?? 0}, ` +
      `hitStepLimit=${result.stop?.hitStepLimit ?? false}`;

  const image = imageFor(index, result.final.screenshot, result.final.screenshotPlaceholder);
  return {
    step: {
      step: index,
      screenshot: image.filename,
      url: result.final.url,
      action: formatAction({
        verb: 'TASK_COMPLETE',
        target: null,
        description: answer ?? '',
        status: null,
      }),
      action_status: null,
      thought,
    },
    image,
    answer,
  };
}

function imageFor(index: number, base64: string | null, placeholder: boolean): SubmissionImage {
  const stem = String(index).padStart(4, '0');
  if (base64) return { filename: `${stem}.jpg`, base64, placeholder };
  // Both the capture and the in-page placeholder failed. PNG, because the
  // fallback is a literal we can guarantee decodes.
  return { filename: `${stem}.png`, base64: FALLBACK_PNG_BASE64, placeholder: true };
}

export function buildSubmission(input: SubmissionInput): Submission {
  const steps: V2ActionStep[] = [];
  const images: SubmissionImage[] = [];
  let lastThought: string | null = null;

  for (const recorded of input.result.steps) {
    const action = mapStep(recorded);
    if (!action) {
      if (recorded.thought) lastThought = recorded.thought;
      continue;
    }

    const index = steps.length;
    const image = imageFor(index, recorded.screenshot, recorded.screenshotPlaceholder);
    images.push(image);
    steps.push({
      step: index,
      screenshot: image.filename,
      url: urlForStep(recorded, action.verb),
      action: formatAction(action),
      action_status: action.status,
      thought: recorded.thought,
    });
    if (recorded.thought) lastThought = recorded.thought;
  }

  const terminal = terminalStep(input, steps.length, lastThought);
  steps.push(terminal.step);
  images.push(terminal.image);

  return {
    document: {
      schema_version: SCHEMA_VERSION,
      task: input.task,
      task_id: input.taskId,
      agent_final_answer: terminal.answer,
      reference_length: input.referenceLength,
      action_history: steps,
    },
    images,
    placeholders: images.filter((i) => i.placeholder).length,
  };
}

/** Writes the submission directory: result.json + trajectory/, plus the raw trace beside them. */
export function writeSubmission(dir: string, input: SubmissionInput): Submission {
  const submission = buildSubmission(input);
  const trajectory = path.join(dir, 'trajectory');

  fs.mkdirSync(trajectory, { recursive: true });
  for (const image of submission.images) {
    fs.writeFileSync(path.join(trajectory, image.filename), Buffer.from(image.base64, 'base64'));
  }

  // JSON.stringify drops undefined, which would silently violate rule 5 — the
  // writer only ever assigns explicit nulls, and this is where that matters.
  fs.writeFileSync(path.join(dir, 'result.json'), `${JSON.stringify(submission.document, null, 2)}\n`);

  fs.writeFileSync(
    path.join(dir, 'raw_trace.json'),
    `${JSON.stringify(rawTrace(input, submission), null, 2)}\n`,
  );

  return submission;
}

export interface RawTrace {
  task_id: string;
  task: string;
  provider: string;
  model: string;
  search_disabled: boolean;
  completed: boolean;
  timed_out: boolean;
  error: string | null;
  stop: BenchRunResult['stop'];
  started_at: number;
  ended_at: number;
  wall_clock_ms: number;
  reference_length: number;
  v2_steps: number;
  placeholders: number;
  /** Every recorded call, including the bookkeeping ones v2 has no verb for. */
  steps: Array<Omit<BenchStep, 'screenshot'>>;
}

export function rawTrace(input: SubmissionInput, submission: Submission): RawTrace {
  const { result } = input;
  return {
    task_id: input.taskId,
    task: input.task,
    provider: result.provider,
    model: result.model,
    search_disabled: result.searchDisabled,
    completed: result.completed,
    timed_out: result.timedOut,
    error: result.error,
    stop: result.stop,
    started_at: result.startedAt,
    ended_at: result.endedAt,
    wall_clock_ms: result.endedAt - result.startedAt,
    reference_length: input.referenceLength,
    v2_steps: submission.document.action_history.length,
    placeholders: submission.placeholders,
    // Images live in trajectory/; repeating megabytes of base64 here helps nobody.
    steps: result.steps.map(({ screenshot: _screenshot, ...rest }) => rest),
  };
}
