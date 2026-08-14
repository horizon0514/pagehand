import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RawTrace } from './v2.ts';
import { loadSample, SAMPLE_PATH, type Sample } from './sample.ts';
import type { Tier } from './dataset.ts';

/**
 * The free, local, same-day signal — and NOT a success rate.
 *
 * It measures whether the agent believed it finished, which is exactly what a
 * confused agent also says. It will read high. Its value is as a smoke signal
 * while a run is in flight and as a denominator check on the official WebJudge
 * scoring afterwards; anything reported as "success" must come from WebJudge.
 */

export const OUT_DIR = path.join(import.meta.dirname, 'out');

export interface TaskScore {
  task_id: string;
  tier: Tier | null;
  /** Ended through control_task complete, or stopped with an answer, without hitting a limit. */
  self_reported_complete: boolean;
  hit_step_limit: boolean;
  timed_out: boolean;
  errored: boolean;
  steps: number;
  v2_steps: number;
  reference_length: number;
  /** Submitted steps per human reference step. */
  efficiency: number;
  failed_action_rate: number;
  placeholders: number;
  total_tokens: number | null;
  wall_clock_ms: number;
}

export interface RunScore {
  tasks: TaskScore[];
  counts: {
    tasks: number;
    self_reported_complete: number;
    hit_step_limit: number;
    timed_out: number;
    errored: number;
    placeholders: number;
  };
  by_tier: Record<string, { tasks: number; self_reported_complete: number }>;
  median_steps: number;
  mean_efficiency: number;
  total_tokens: number | null;
  wall_clock_ms: number;
  caveat: string;
}

const CAVEAT =
  'self_reported_complete is NOT a success rate. It counts turns the agent ended cleanly, not tasks ' +
  'it actually accomplished. Report success only from the official WebJudge run (o4-mini).';

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function tierIndex(sample: Sample | null): Map<string, Tier> {
  const index = new Map<string, Tier>();
  for (const entry of sample?.tasks ?? []) index.set(entry.task_id, entry.tier);
  return index;
}

export function scoreTrace(trace: RawTrace, tier: Tier | null): TaskScore {
  const executed = trace.steps.filter((step) => step.tool !== 'web_search');
  const failed = executed.filter((step) => step.status === 'FAILED').length;
  const stop = trace.stop;
  const clean = !trace.timed_out && trace.error === null && !(stop?.hitStepLimit ?? false);

  return {
    task_id: trace.task_id,
    tier,
    self_reported_complete:
      clean && (trace.completed || (stop?.finishReason === 'stop' && trace.v2_steps > 1)),
    hit_step_limit: stop?.hitStepLimit ?? false,
    timed_out: trace.timed_out,
    errored: trace.error !== null,
    steps: stop?.steps ?? 0,
    v2_steps: trace.v2_steps,
    reference_length: trace.reference_length,
    efficiency: trace.reference_length > 0 ? trace.v2_steps / trace.reference_length : 0,
    failed_action_rate: executed.length > 0 ? failed / executed.length : 0,
    placeholders: trace.placeholders,
    total_tokens: stop?.totalTokens ?? null,
    wall_clock_ms: trace.wall_clock_ms,
  };
}

export function scoreRun(outDir = OUT_DIR, sample: Sample | null = null): RunScore {
  const tiers = tierIndex(sample);
  const traces: RawTrace[] = [];

  for (const entry of fs.existsSync(outDir) ? fs.readdirSync(outDir, { withFileTypes: true }) : []) {
    if (!entry.isDirectory()) continue;
    const file = path.join(outDir, entry.name, 'raw_trace.json');
    if (fs.existsSync(file)) traces.push(JSON.parse(fs.readFileSync(file, 'utf8')) as RawTrace);
  }

  const tasks = traces
    .map((trace) => scoreTrace(trace, tiers.get(trace.task_id) ?? null))
    .sort((a, b) => (a.task_id < b.task_id ? -1 : 1));

  const by_tier: RunScore['by_tier'] = {};
  for (const task of tasks) {
    const key = task.tier ?? 'unknown';
    by_tier[key] ??= { tasks: 0, self_reported_complete: 0 };
    by_tier[key].tasks += 1;
    if (task.self_reported_complete) by_tier[key].self_reported_complete += 1;
  }

  const tokens = tasks.map((task) => task.total_tokens).filter((n): n is number => n !== null);

  return {
    tasks,
    counts: {
      tasks: tasks.length,
      self_reported_complete: tasks.filter((t) => t.self_reported_complete).length,
      hit_step_limit: tasks.filter((t) => t.hit_step_limit).length,
      timed_out: tasks.filter((t) => t.timed_out).length,
      errored: tasks.filter((t) => t.errored).length,
      placeholders: tasks.reduce((sum, t) => sum + t.placeholders, 0),
    },
    by_tier,
    median_steps: median(tasks.map((t) => t.v2_steps)),
    mean_efficiency: tasks.length > 0 ? tasks.reduce((sum, t) => sum + t.efficiency, 0) / tasks.length : 0,
    total_tokens: tokens.length > 0 ? tokens.reduce((sum, n) => sum + n, 0) : null,
    wall_clock_ms: tasks.reduce((sum, t) => sum + t.wall_clock_ms, 0),
    caveat: CAVEAT,
  };
}

export function formatRunScore(score: RunScore): string {
  const { counts } = score;
  const pct = (n: number) => (counts.tasks > 0 ? `${Math.round((n / counts.tasks) * 100)}%` : 'n/a');
  const lines = [
    `[bench] ${counts.tasks} task(s) scored locally`,
    `  self-reported complete : ${counts.self_reported_complete}/${counts.tasks} (${pct(counts.self_reported_complete)})`,
    `  hit step limit         : ${counts.hit_step_limit}`,
    `  timed out              : ${counts.timed_out}`,
    `  errored                : ${counts.errored}`,
    `  placeholder shots      : ${counts.placeholders}`,
    `  median v2 steps        : ${score.median_steps}`,
    `  steps / human reference: ${score.mean_efficiency.toFixed(2)}×`,
    `  total tokens           : ${score.total_tokens ?? 'n/a'}`,
    `  wall clock             : ${(score.wall_clock_ms / 60000).toFixed(1)} min`,
  ];
  for (const [tier, row] of Object.entries(score.by_tier)) {
    lines.push(`  ${tier.padEnd(23)}: ${row.self_reported_complete}/${row.tasks} self-reported complete`);
  }
  lines.push('', `  ${CAVEAT}`);
  return lines.join('\n');
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const sample = fs.existsSync(SAMPLE_PATH) ? loadSample() : null;
  const score = scoreRun(OUT_DIR, sample);
  console.log(formatRunScore(score));
  if (score.counts.tasks > 0) {
    fs.writeFileSync(path.join(OUT_DIR, 'score-summary.json'), `${JSON.stringify(score, null, 2)}\n`);
  }
}
