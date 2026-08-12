import {
  streamText,
  stepCountIs,
  hasToolCall,
  type ModelMessage,
  type LanguageModel,
  type ToolSet,
  type AssistantModelMessage,
  type ToolModelMessage,
} from 'ai';
import { tools, CONTROL_TASK_TOOL } from '../tools';
import { resolveModel } from './providers';
import { isHosted, Settings, type ProviderId } from '../storage/schema';
import { dropDanglingToolCalls, elideStaleSnapshots, sanitizeModelMessages } from './sanitizeMessages';
import { compactHistory } from './compactHistory';
import { composeLiveNote, stripLiveNotes } from './liveNote';
import { reflectionNote } from './reflection';
import { getActiveLedger } from '../ledger/activeLedger';
import { formatLedgerDigest } from '../ledger/digest';
import { isLedgerEmpty } from '../ledger/types';
import { DEFAULT_MAX_EPISODES, orchestrateAgentEvents, type AgentMode } from './orchestrator';

/** Assistant + tool messages produced by a single streamText call. */
export type TurnResponseMessage = AssistantModelMessage | ToolModelMessage;

export type AgentEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call'; toolCallId: string; name: string; args: unknown }
  | { type: 'tool-result'; toolCallId: string; name: string; result: unknown }
  | { type: 'tool-error'; toolCallId: string; name: string; error: string }
  | { type: 'done'; stop: StopInfo; responseMessages: TurnResponseMessage[] }
  | { type: 'error'; message: string };

/** Why the turn ended — without this there's no way to tell a model that chose
 * to stop from a step-limit cutoff, a truncated response, or a provider error. */
export interface StopInfo {
  finishReason: string;
  steps: number;
  hitStepLimit: boolean;
  totalTokens?: number;
  /** The user pressed stop — not a model or provider decision. */
  aborted?: boolean;
}

// The identity line is load-bearing: without it a model answers "who are you"
// from its own training data, and several models served through the
// openai-compatible path (DeepSeek among them) claim to be Claude or GPT.
const SYSTEM_PROMPT = `You are Pagehand, a browser copilot with tools to read and automate the current Chrome tab
via the Chrome DevTools Protocol. If asked who or what you are, say you are Pagehand, a Chrome extension
copilot — do not claim to be any particular model or vendor, and do not volunteer which model powers you.
Always call take_snapshot before clicking/filling elements you haven't
just seen, since uids only stay valid until the next snapshot. Prefer fill_form over multiple individual
fill calls. If a tool call fails because a uid is stale or an element isn't visible, take a fresh snapshot
and retry rather than guessing.

To READ a page — anything you collect or summarize rather than click — never use take_snapshot.
Reserve it for when you need uids to interact with elements. Two cheaper tools cover reading:

- evaluate_script, when structure identifies the data (selectors, attributes, counts, links, controls).
  Treat it as a program, not a one-liner: loop, scroll, await, filter, and return only the finished
  result in one call when that saves round trips.
- extract_content, when meaning identifies it (judgment over free text). It runs a sub-model over the
  page text and returns compact JSON; the raw page never enters your context.

They compose: use evaluate_script to get the page into the state you need, then extract_content once
over the rendered page when you need a judgment call.

For multi-step tasks you have a durable task ledger that survives even when older messages are trimmed
from this conversation. Start such tasks by calling update_task_ledger to set the goal (including the
success criterion) and a short step plan. Treat the plan as live work tracking, not a one-time outline:
when you begin a step, set_plan_status to in_progress; when you finish or abandon it, set done or skipped
before moving on — do not leave every step pending while you accumulate findings. Prefer set_plan_status
over replace_plan unless the steps themselves need to change. The moment you discover something the task
asked for, upsert it as a finding — results that exist only in prose are lost when the conversation is
trimmed. Before detours and at the end of each work chunk, add a note with where you left off.
The current ledger state is appended to the end of the conversation each step, marked as live task state;
treat it — not the conversation — as the source of truth for progress, and never re-collect a finding
already saved. Trivial single-step
requests don't need the ledger.

When saving findings, require direct evidence that meets the goal's criteria — do not stretch ambiguous
items to hit a count, and remove weak ones before completing. Put clear success criteria in the goal
up front when the task is open-ended or quantity-based.

For simple requests, answer directly and stop normally. For a ledger-backed task, when the whole goal is
met — measured against its success criterion — call control_task with type complete. If it is too large
for one context, call control_task with type start_episode and one bounded objective, but only after you
have initialized the ledger. If you get stuck, do not repeat the same action hoping for a different result:
change approach, and if a whole strategy is exhausted, say what's blocking you and stop.
To search the web, use the web_search tool rather than navigating to a search engine and reading the page.
Pass the information need in plain language — it plans several keyword queries from it, runs them at once,
and merges the rankings, so do not pre-chew it into keywords yourself. When the results miss, pass explicit
"queries" (a site: filter, an exact phrase, another language) rather than repeating the same need. Then
navigate_page to a promising result and extract_content to read it.`;

const EPISODE_PROMPT = `${SYSTEM_PROMPT}

## Fresh-context episode
Execute only the bounded objective in the user message. The task ledger is your only cross-episode memory:
update it with verified progress (including set_plan_status as steps advance) and read its current digest
before choosing actions. Do not start another episode and do not declare the whole task complete. End this
episode by calling control_task with type finish_episode, status done / partial / blocked, a concise
summary, and a handoff note for the root planner.`;

/**
 * A hard ceiling, not the normal way a turn ends. A healthy turn now stops when
 * the model yields a control_task action (see stopWhen below); this is the runaway
 * guard. It can be this high because compactHistory keeps a long run inside the
 * context window and reflection steers the model off dead ends — neither of
 * which existed when this was 40, the point at which long collection tasks used
 * to get cut off mid-work.
 */
export const MAX_STEPS = 100;

/**
 * The same guard, lowered for the path where we pay.
 *
 * On BYOK a runaway turn spends the user's own money against their own key, and
 * they can watch it happen. On the hosted path it spends ours, and the limits
 * multiply: the root loop can run `MAX_STEPS` and then dispatch episodes that
 * each run `MAX_STEPS` again. At 100 × 8 that is up to ~900 model calls from a
 * single user message — around $0.45 at measured flash-class rates (§3.2.1),
 * or a tenth of a month's allowance in one sentence.
 *
 * 60 × 5 puts the same worst case near 360 calls (~$0.18) while staying well
 * clear of the collection tasks that motivated raising this from 40 in the
 * first place — those settled around 50 steps, and an episode boundary now
 * exists for the ones that don't.
 *
 * This is a blast-radius limit, not the budget. The hard per-period ceiling in
 * PLAN-subscription §4.4 is what actually bounds spend; this only stops one
 * turn from eating a visible share of it.
 */
export const HOSTED_MAX_STEPS = 60;
export const HOSTED_MAX_EPISODES = 5;

export interface TurnLimits {
  maxSteps: number;
  maxEpisodes: number;
}

/**
 * Who pays decides how far a single turn may run. Split out from `runAgentTurn`
 * so the policy can be asserted without standing up a provider.
 */
export function turnLimits(provider: ProviderId): TurnLimits {
  return isHosted(provider)
    ? { maxSteps: HOSTED_MAX_STEPS, maxEpisodes: HOSTED_MAX_EPISODES }
    : { maxSteps: MAX_STEPS, maxEpisodes: DEFAULT_MAX_EPISODES };
}

export function buildMessages(history: ModelMessage[], userMessage: string): ModelMessage[] {
  return [...history, { role: 'user', content: userMessage }];
}

export interface AgentStreamOptions {
  toolset?: ToolSet;
  maxSteps?: number;
  /** Base system instructions; episode runs override the normal root prompt. */
  instructions?: string;
  /** Recomputed tool-name allowlist for each step. */
  activeTools?: () => string[];
  /** Abort the turn mid-flight (the composer's stop button). */
  abortSignal?: AbortSignal;
  /**
   * Called before every step; a non-null return is appended to the system
   * prompt for that step. Production feeds the task-ledger digest through
   * here so durable state reaches the model even after history trimming.
   */
  extraInstructions?: () => string | null;
}

/**
 * Aborting throws away the in-flight step, so the SDK rejects its result
 * promises when no step ever completed. Fall back instead of letting that
 * surface to the user as a failure — they asked for the stop.
 */
function tolerate<T>(promise: PromiseLike<T>, fallback: T): Promise<T> {
  return Promise.resolve(promise).then(
    (value) => value,
    () => fallback,
  );
}

/**
 * The ReAct loop itself, decoupled from settings and tool wiring so tests can
 * drive it with a mock model and mock tools (no browser, no API key).
 */
export async function* streamAgentEvents(
  model: LanguageModel,
  messages: ModelMessage[],
  {
    toolset = tools,
    maxSteps = MAX_STEPS,
    instructions = SYSTEM_PROMPT,
    activeTools,
    abortSignal,
    extraInstructions,
  }: AgentStreamOptions = {},
): AsyncGenerator<AgentEvent> {
  const stopped = () => abortSignal?.aborted === true;
  try {
    const result = streamText({
      model,
      // AI SDK v7 rejects `role: 'system'` entries inside `messages`
      // (allowSystemInMessages defaults to false) — the system prompt has to
      // come through this top-level option instead.
      instructions,
      messages,
      tools: toolset,
      // Two ways to stop: the model yields an explicit control action, or the
      // runaway guard trips. The control action is the intended path.
      stopWhen: [stepCountIs(maxSteps), hasToolCall(CONTROL_TASK_TOOL)],
      abortSignal,
      // Every step resends the whole turn so far. Snapshots are the one result
      // big enough to matter (up to ~12K tokens each) and the one that stops
      // being true — its uids die the moment a newer snapshot exists — so a
      // long turn otherwise carries several stale copies of the same page and
      // exhausts the context window long before the step limit. The override
      // carries forward, so each step elides only what the last one added.
      //
      // Everything that keeps a long turn alive converges here, rebuilt each
      // step: snapshot elision and context compaction on the messages, then the
      // ledger digest and any reflection note appended as a live note at the
      // end (see liveNote.ts for why the end and not the instructions).
      //
      // `instructions` is deliberately never rebuilt. It sits at the front of
      // the prompt, where every provider's prefix cache starts, so anything
      // volatile in it costs the whole cache on the step it changes.
      prepareStep: ({ messages: stepMessages, stepNumber, responseMessages }) => {
        const trimmed = compactHistory(elideStaleSnapshots(stripLiveNotes(stepMessages)));

        // Stall detection reads responseMessages, which compaction never
        // touches, so the real action sequence stays visible to it.
        const note = composeLiveNote([
          extraInstructions?.(),
          reflectionNote(stepNumber, responseMessages),
        ]);

        return {
          messages: note ? [...trimmed, note] : trimmed,
          ...(activeTools ? { activeTools: activeTools() } : {}),
        };
      },
    });

    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'text-delta':
          yield { type: 'text-delta', text: part.text };
          break;
        case 'tool-call':
          yield { type: 'tool-call', toolCallId: part.toolCallId, name: part.toolName, args: part.input };
          break;
        case 'tool-result':
          yield { type: 'tool-result', toolCallId: part.toolCallId, name: part.toolName, result: part.output };
          break;
        case 'tool-error':
          yield {
            type: 'tool-error',
            toolCallId: part.toolCallId,
            name: part.toolName,
            error: part.error instanceof Error ? part.error.message : String(part.error),
          };
          break;
        case 'error':
          yield { type: 'error', message: part.error instanceof Error ? part.error.message : String(part.error) };
          break;
        default:
          break;
      }
    }

    if (stopped()) {
      yield await abortedTurn(result, maxSteps);
      return;
    }

    const [finishReason, steps, usage, responseMessages] = await Promise.all([
      result.finishReason,
      result.steps,
      result.totalUsage,
      result.responseMessages,
    ]);
    yield {
      type: 'done',
      stop: {
        finishReason,
        steps: steps.length,
        hitStepLimit: steps.length >= maxSteps,
        totalTokens: usage?.totalTokens,
      },
      // Drop screenshot payloads before they become next-turn context.
      responseMessages: sanitizeModelMessages(responseMessages) as TurnResponseMessage[],
    };
  } catch (err) {
    // A stop tears down the model request, so the failure it raises is expected.
    if (stopped()) {
      yield {
        type: 'done',
        stop: { finishReason: 'abort', steps: 0, hitStepLimit: false, aborted: true },
        responseMessages: [STOP_NOTE],
      };
      return;
    }
    yield { type: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

/** Stands in for the reply the user cut off. Anthropic and OpenAI both expect an
 * assistant turn between two user messages, and this says why there isn't one. */
const STOP_NOTE: AssistantModelMessage = {
  role: 'assistant',
  content: '[Stopped by the user before I finished this turn.]',
};

/**
 * Keep whatever steps finished before the stop so the transcript the model sees
 * next turn matches what the user watched happen — minus any tool call whose
 * result never arrived, which providers reject.
 */
async function abortedTurn(
  result: ReturnType<typeof streamText>,
  maxSteps: number,
): Promise<Extract<AgentEvent, { type: 'done' }>> {
  const [steps, totalTokens, responseMessages] = await Promise.all([
    tolerate(Promise.resolve(result.steps).then((s) => s.length), 0),
    tolerate(Promise.resolve(result.totalUsage).then((u) => u?.totalTokens), undefined),
    tolerate(Promise.resolve(result.responseMessages).then((m) => m as TurnResponseMessage[]), []),
  ]);

  const kept = dropDanglingToolCalls(
    sanitizeModelMessages(responseMessages) as TurnResponseMessage[],
  );

  return {
    type: 'done',
    stop: {
      finishReason: 'abort',
      steps,
      hitStepLimit: steps >= maxSteps,
      totalTokens,
      aborted: true,
    },
    responseMessages: kept.some((m) => m.role === 'assistant') ? kept : [...kept, STOP_NOTE],
  };
}

/** Production entry point: resolve the configured provider, then run the loop. */
export async function* runAgentTurn(
  settings: Settings,
  history: ModelMessage[],
  userMessage: string,
  abortSignal?: AbortSignal,
): AsyncGenerator<AgentEvent> {
  let model: LanguageModel;
  try {
    model = resolveModel(settings);
  } catch (err) {
    yield { type: 'error', message: err instanceof Error ? err.message : String(err) };
    return;
  }
  const limits = turnLimits(settings.provider);
  const run = (messages: ModelMessage[], mode: AgentMode) =>
    streamAgentEvents(model, messages, {
      abortSignal,
      maxSteps: limits.maxSteps,
      instructions: mode === 'episode' ? EPISODE_PROMPT : SYSTEM_PROMPT,
      activeTools:
        mode === 'root'
          ? () => {
              const ledger = getActiveLedger();
              const names = Object.keys(tools);
              return ledger && !isLedgerEmpty(ledger)
                ? names
                : names.filter((name) => name !== CONTROL_TASK_TOOL);
            }
          : undefined,
      extraInstructions: () => {
        const ledger = getActiveLedger();
        return ledger ? formatLedgerDigest(ledger) : null;
      },
    });

  // Both limits move together: lowering the steps per episode while leaving the
  // episode count alone just redistributes the same total spend.
  yield* orchestrateAgentEvents(buildMessages(history, userMessage), run, limits.maxEpisodes);
}
