import { tools } from '../../lib/tools';
import { sessionRegistry } from '../../lib/debugger-bridge/sessionRegistry';
import { agentTabTracker } from '../../lib/pages/agentTabTracker';
import { activateLedger } from '../../lib/ledger/activeLedger';
import { getSettings } from '../../lib/storage/settingsStore';
import { resolveElement } from '../../lib/snapshot/resolveElement';
import { runAgentTurn, type StopInfo } from '../../lib/llm/agentLoop';

/**
 * Benchmark recorder — E2E-only, and only reachable through window.__cdp.bench
 * in a VITE_E2E build (see sidepanel/main.tsx, which drops this whole subtree
 * from a normal build).
 *
 * It records one Online-Mind2Web trajectory per agent turn. Two channels feed
 * one record, joined on the SDK's toolCallId:
 *
 *   event stream (ordered by the SDK)        tool wrapper (runs at execute time)
 *     text-delta  -> pending thought           entry: url + screenshot, BEFORE the action
 *     tool-call   -> thought, name, args       exit:  SUCCESS | FAILED
 *     tool-result -> corroborates SUCCESS
 *     done        -> stop info
 *
 * Neither channel decides pairing — the id does — so a thought can never be
 * attached to the wrong action, which is the desync the v2 schema exists to
 * prevent.
 *
 * The wrapper patches `tools[name].execute` in place. That works because the AI
 * SDK looks the tool up by name at call time and `tool()` returns a plain
 * object with a writable `execute`; it is the only way to observe every call
 * (including the ones that throw) without changing product code under src/lib.
 */

export type BenchStatus = 'SUCCESS' | 'FAILED';

export interface BenchStep {
  /** Assigned when the call is first seen — the SDK runs a step's tool calls in parallel. */
  order: number;
  toolCallId: string;
  tool: string;
  args: unknown;
  /** Page URL at the moment the action started. */
  url: string | null;
  /** Where a navigation went, for v2's rule 8. Null for everything else. */
  destinationUrl: string | null;
  /** Base64 JPEG captured before the action ran. Null only if the placeholder also failed. */
  screenshot: string | null;
  screenshotPlaceholder: boolean;
  captureMs: number;
  /** Viewport centre of the target element, when the call named one. */
  coords: { x: number; y: number } | null;
  status: BenchStatus;
  error: string | null;
  thought: string | null;
}

export interface BenchRunOptions {
  task: string;
  taskId: string;
  timeoutMs?: number;
  /** Off by default: the benchmark instructs agents to work from the start site. */
  allowSearch?: boolean;
}

export interface BenchCapture {
  url: string | null;
  screenshot: string | null;
  screenshotPlaceholder: boolean;
  captureMs: number;
}

export interface BenchRunResult {
  steps: BenchStep[];
  /** Free text the agent ended on, or the summary it passed to control_task. */
  finalAnswer: string | null;
  /** True when the turn ended through control_task { type: 'complete' }. */
  completed: boolean;
  stop: StopInfo | null;
  error: string | null;
  timedOut: boolean;
  /** Post-turn capture, used for the synthesised TASK_COMPLETE step. */
  final: BenchCapture;
  provider: string;
  model: string;
  searchDisabled: boolean;
  startedAt: number;
  endedAt: number;
}

/** JPEG rather than PNG: ~7× smaller, accepted by the v2 filename pattern, and
 * WebJudge re-encodes to JPEG before it sends anything to the judge anyway. */
const SCREENSHOT_QUALITY = 75;
/** Page.captureScreenshot can stall mid-navigation; a stalled step must not eat the run. */
const CAPTURE_TIMEOUT_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 900_000;

const SEARCH_DISABLED_RESULT = {
  error: 'web_search is disabled for benchmark runs; work from the current site.',
};

type ToolExecute = (input: unknown, options: unknown) => Promise<unknown>;
type ToolRegistry = Record<string, { execute: ToolExecute }>;

const registry = tools as unknown as ToolRegistry;
const originals = new Map<string, ToolExecute>();

let steps: BenchStep[] = [];
let byId = new Map<string, BenchStep>();
let counter = 0;
let pendingThought = '';
let allowSearch = false;

function blankStep(toolCallId: string, name: string): BenchStep {
  return {
    order: -1,
    toolCallId,
    tool: name,
    args: undefined,
    url: null,
    destinationUrl: null,
    screenshot: null,
    screenshotPlaceholder: false,
    captureMs: 0,
    coords: null,
    status: 'SUCCESS',
    error: null,
    thought: null,
  };
}

/** Steps whose wrapper has already entered — see entryFor. */
let executed = new WeakSet<BenchStep>();

/**
 * The step for this call id, creating it if this is the first channel to arrive.
 *
 * `fromWrapper` covers the case where one id is reused across calls — the E2E
 * bridge's __cdp.call passes a constant toolCallId, and a recorder that merged
 * those would report one step where three actions happened. Real SDK ids are
 * unique, so on the agent path both channels always meet on the same entry.
 */
function entryFor(toolCallId: string, name: string, fromWrapper: boolean): BenchStep {
  const existing = byId.get(toolCallId);
  if (existing && !(fromWrapper && executed.has(existing))) {
    if (fromWrapper) executed.add(existing);
    return existing;
  }

  const step = blankStep(toolCallId, name);
  if (fromWrapper) executed.add(step);
  steps.push(step);
  if (!existing) byId.set(toolCallId, step);
  return step;
}

/** Order is assigned by whichever channel sees the call first, never at completion. */
function assignOrder(step: BenchStep): void {
  if (step.order === -1) step.order = counter++;
}

function takePendingThought(): string | null {
  const text = pendingThought.trim();
  pendingThought = '';
  return text.length > 0 ? text : null;
}

async function currentUrl(): Promise<string | null> {
  const session = sessionRegistry.getAttached();
  if (!session) return null;
  try {
    const tab = await chrome.tabs.get(session.getTabId());
    return tab.url ?? tab.pendingUrl ?? null;
  } catch {
    return null;
  }
}

/**
 * A visibly marked stand-in, so v2's "every referenced screenshot exists" rule
 * still holds when capture fails. Dropping the step instead would hide a real
 * action from the judge, which is worse than a marked blank.
 */
function placeholderImage(): string | null {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 720;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#3a3a3a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#ffffff';
    ctx.font = '32px sans-serif';
    ctx.fillText('SCREENSHOT CAPTURE FAILED', 60, 360);
    return canvas.toDataURL('image/jpeg', SCREENSHOT_QUALITY / 100).split(',')[1] ?? null;
  } catch {
    return null;
  }
}

export async function capture(): Promise<BenchCapture> {
  const started = Date.now();
  const url = await currentUrl();
  const session = sessionRegistry.getAttached();

  let data: string | null = null;
  if (session) {
    try {
      const shot = await Promise.race([
        session.send<{ data: string }>('Page.captureScreenshot', {
          format: 'jpeg',
          quality: SCREENSHOT_QUALITY,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('capture timed out')), CAPTURE_TIMEOUT_MS),
        ),
      ]);
      data = shot.data ?? null;
    } catch {
      data = null;
    }
  }

  const placeholder = data === null;
  return {
    url,
    screenshot: placeholder ? placeholderImage() : data,
    screenshotPlaceholder: placeholder,
    captureMs: Date.now() - started,
  };
}

/** Resolve the uid a call names to viewport coordinates — v2's `coords(x, y)` target. */
async function coordsFor(name: string, input: unknown): Promise<{ x: number; y: number } | null> {
  const session = sessionRegistry.getAttached();
  if (!session) return null;

  const args = (input ?? {}) as {
    uid?: unknown;
    elements?: Array<{ uid?: unknown }>;
  };
  const uid =
    typeof args.uid === 'string'
      ? args.uid
      : name === 'fill_form' && typeof args.elements?.[0]?.uid === 'string'
        ? (args.elements[0].uid as string)
        : null;
  if (!uid) return null;

  try {
    const resolved = await resolveElement(session, session.getTabId(), uid);
    return { x: Math.round(resolved.center.x), y: Math.round(resolved.center.y) };
  } catch {
    // A stale uid resolves to nothing — the action itself will fail and be
    // recorded as FAILED against the `page` target.
    return null;
  }
}

const NAVIGATION_TOOLS = new Set(['navigate_page', 'new_page']);

async function destinationFor(name: string, input: unknown): Promise<string | null> {
  if (!NAVIGATION_TOOLS.has(name)) return null;
  const args = (input ?? {}) as { type?: unknown; url?: unknown };
  if (typeof args.url === 'string' && (name === 'new_page' || (args.type ?? 'url') === 'url')) {
    return args.url;
  }
  // back / forward / reload: the destination is only knowable afterwards.
  return currentUrl();
}

function wrap(name: string, original: ToolExecute): ToolExecute {
  return async (input: unknown, options: unknown) => {
    const toolCallId =
      (options as { toolCallId?: unknown } | undefined)?.toolCallId != null
        ? String((options as { toolCallId: unknown }).toolCallId)
        : `bench-${counter}`;

    const step = entryFor(toolCallId, name, true);
    assignOrder(step);
    step.tool = name;
    step.args = input;

    if (name === 'web_search' && !allowSearch) {
      step.status = 'FAILED';
      step.error = SEARCH_DISABLED_RESULT.error;
      return SEARCH_DISABLED_RESULT;
    }

    const shot = await capture();
    step.url = shot.url;
    step.screenshot = shot.screenshot;
    step.screenshotPlaceholder = shot.screenshotPlaceholder;
    step.captureMs = shot.captureMs;
    step.coords = await coordsFor(name, input);

    try {
      const result = await original(input, options);
      step.status = 'SUCCESS';
      step.destinationUrl = await destinationFor(name, input);
      return result;
    } catch (err) {
      step.status = 'FAILED';
      step.error = err instanceof Error ? err.message : String(err);
      step.destinationUrl = await destinationFor(name, input);
      throw err;
    }
  };
}

/** Idempotent: installing twice must not wrap a wrapper. */
export function install(options: { allowSearch?: boolean } = {}): void {
  allowSearch = options.allowSearch ?? false;
  for (const name of Object.keys(registry)) {
    if (originals.has(name)) continue;
    const original = registry[name].execute;
    originals.set(name, original);
    registry[name].execute = wrap(name, original);
  }
}

/** Restore the shipped tool objects — for tests that run after a bench run. */
export function uninstall(): void {
  for (const [name, original] of originals) registry[name].execute = original;
  originals.clear();
}

export function reset(): void {
  steps = [];
  byId = new Map();
  executed = new WeakSet();
  counter = 0;
  pendingThought = '';
}

export function recorded(): BenchStep[] {
  return [...steps].sort((a, b) => a.order - b.order);
}

/**
 * Run one benchmark task on the attached tab and return its trajectory.
 *
 * The ledger activation is not optional: control_task is filtered out of the
 * tool list until a non-empty ledger exists, and update_task_ledger throws
 * without an active one — so without this the agent can never signal
 * completion the way the product intends.
 */
export async function run(options: BenchRunOptions): Promise<BenchRunResult> {
  reset();

  const settings = await getSettings();
  if (!settings) {
    throw new Error(
      'No Pagehand settings stored — seed chrome.storage.local["pagehand:settings"] before running a task.',
    );
  }
  if (settings.provider === 'hosted') {
    throw new Error(
      'Benchmark runs must be BYOK: the hosted path bills Pagehand and halves the step budget.',
    );
  }

  const session = sessionRegistry.getAttached();
  if (!session) {
    throw new Error('No attached tab — call __cdp.attach(tabId) on the task start page first.');
  }

  await activateLedger(`bench-${options.taskId}`);
  agentTabTracker.beginTurn(session.getTabId());
  install({ allowSearch: options.allowSearch });

  const startedAt = Date.now();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let stop: StopInfo | null = null;
  let error: string | null = null;
  let completed = false;
  let completeSummary: string | null = null;
  let lastTextBlock: string | null = null;

  try {
    for await (const event of runAgentTurn(settings, [], options.task, controller.signal)) {
      switch (event.type) {
        case 'text-delta':
          pendingThought += event.text;
          break;
        case 'tool-call': {
          const step = entryFor(event.toolCallId, event.name, false);
          assignOrder(step);
          step.tool = event.name;
          if (step.args === undefined) step.args = event.args;
          const thought = takePendingThought();
          if (thought) {
            step.thought = thought;
            lastTextBlock = thought;
          }
          if (event.name === 'control_task') {
            const args = (event.args ?? {}) as { type?: unknown; summary?: unknown };
            if (args.type === 'complete') {
              completed = true;
              completeSummary = typeof args.summary === 'string' ? args.summary : null;
            }
          }
          break;
        }
        case 'tool-error': {
          const step = byId.get(event.toolCallId);
          if (step) {
            step.status = 'FAILED';
            step.error ??= event.error;
          }
          break;
        }
        case 'done':
          stop = event.stop;
          break;
        case 'error':
          error = event.message;
          break;
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timer);
  }

  // Text the model emitted after its last tool call is the answer; a turn that
  // ended through control_task without prose falls back to its summary.
  const trailing = takePendingThought();
  const finalAnswer = trailing ?? completeSummary ?? lastTextBlock;

  const final = await capture();
  await agentTabTracker.cleanup();

  return {
    steps: recorded(),
    finalAnswer,
    completed,
    stop,
    error,
    timedOut,
    final,
    provider: settings.provider,
    model: settings.model,
    searchDisabled: !allowSearch,
    startedAt,
    endedAt: Date.now(),
  };
}

export const bench = { install, uninstall, reset, steps: recorded, capture, run };
