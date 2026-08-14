import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataset, tierOf, type DatasetTask, type Tier } from './dataset.ts';

/**
 * The pinned 30-task sample.
 *
 * Pinning matters more than it looks: the benchmark authors replace tasks
 * regularly, so two runs a month apart are only comparable if the ids are fixed
 * and the dataset sha they were drawn from is recorded. Selection is seeded and
 * deterministic, so the same seed against the same sha reproduces the file.
 *
 * The file holds ids and tiers only — the task text and start sites stay behind
 * the HuggingFace gate where they belong, and a run resolves them from the
 * cached dataset.
 */

export const SAMPLE_PATH = path.join(import.meta.dirname, 'sample.json');

/** Proportional to the 83/143/74 population, which is what makes the number comparable. */
export const DEFAULT_SPLIT: Record<Tier, number> = { easy: 8, medium: 14, hard: 8 };
export const DEFAULT_SEED = 20260813;

/** Each tier draws from its own stream, so changing one tier's size cannot reshuffle another. */
const TIER_SEED_OFFSET: Record<Tier, number> = { easy: 1, medium: 2, hard: 3 };

export interface SampleEntry {
  task_id: string;
  tier: Tier;
}

export interface Sample {
  dataset_sha: string | null;
  generated_at: string;
  seed: number;
  split: Record<Tier, number>;
  tasks: SampleEntry[];
}

/** Small, fast, and identical across machines — the property that matters here. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function parseSplit(raw: string | undefined): Record<Tier, number> {
  if (!raw) return DEFAULT_SPLIT;
  const parts = raw.split('/').map((part) => Number(part.trim()));
  if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n) || n < 0)) {
    throw new Error(`BENCH_SPLIT must look like "8/14/8" (easy/medium/hard), got "${raw}"`);
  }
  return { easy: parts[0], medium: parts[1], hard: parts[2] };
}

export interface SelectOptions {
  seed?: number;
  split?: Record<Tier, number>;
}

/**
 * Deterministic per-tier selection with at most one task per website — 30 tasks
 * spread over 136 sites should not spend three of them on the same domain.
 */
export function selectSample(tasks: DatasetTask[], options: SelectOptions = {}): SampleEntry[] {
  const seed = options.seed ?? DEFAULT_SEED;
  const split = options.split ?? DEFAULT_SPLIT;
  const usedWebsites = new Set<string>();
  const selected: SampleEntry[] = [];

  for (const tier of ['easy', 'medium', 'hard'] as Tier[]) {
    const wanted = split[tier];
    if (wanted === 0) continue;

    const pool = tasks
      .filter((task) => tierOf(task.reference_length) === tier)
      .sort((a, b) => (a.task_id < b.task_id ? -1 : a.task_id > b.task_id ? 1 : 0));
    const order = shuffled(pool, mulberry32(seed + TIER_SEED_OFFSET[tier]));

    const picked: DatasetTask[] = [];
    for (const task of order) {
      if (picked.length === wanted) break;
      if (usedWebsites.has(task.website)) continue;
      usedWebsites.add(task.website);
      picked.push(task);
    }
    if (picked.length < wanted) {
      throw new Error(
        `Only ${picked.length} of ${wanted} ${tier} tasks available under the one-per-website rule ` +
          `(${pool.length} in tier).`,
      );
    }

    // Stable output order regardless of the shuffle, so a diff of sample.json
    // shows which tasks changed rather than which order they were drawn in.
    picked.sort((a, b) => (a.task_id < b.task_id ? -1 : 1));
    for (const task of picked) selected.push({ task_id: task.task_id, tier });
  }

  return selected;
}

export function loadSample(file = SAMPLE_PATH): Sample {
  if (!fs.existsSync(file)) {
    throw new Error(
      `No sample at ${file}. Generate it once (needs HF_TOKEN) with:\n` +
        '  npm run bench:om2w -- --sample\n' +
        'then commit it, so every later run uses the same 30 tasks.',
    );
  }
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Sample;
}

/** Resolves pinned ids against the dataset, failing loudly on an id upstream dropped. */
export function resolveSample(sample: Sample, tasks: DatasetTask[]): Array<DatasetTask & { tier: Tier }> {
  const byId = new Map(tasks.map((task) => [task.task_id, task]));
  return sample.tasks.map((entry) => {
    const task = byId.get(entry.task_id);
    if (!task) {
      throw new Error(
        `Pinned task ${entry.task_id} is no longer in the dataset (sha ${sample.dataset_sha ?? 'unknown'}). ` +
          'The upstream task list has moved — regenerate the sample and say so in the write-up.',
      );
    }
    return { ...task, tier: entry.tier };
  });
}

export interface GenerateOptions extends SelectOptions {
  file?: string;
  refresh?: boolean;
}

export async function generateSample(options: GenerateOptions = {}): Promise<Sample> {
  const dataset = await loadDataset({ refresh: options.refresh });
  const sample: Sample = {
    dataset_sha: dataset.sha,
    generated_at: new Date().toISOString(),
    seed: options.seed ?? DEFAULT_SEED,
    split: options.split ?? DEFAULT_SPLIT,
    tasks: selectSample(dataset.tasks, options),
  };

  const file = options.file ?? SAMPLE_PATH;
  fs.writeFileSync(file, `${JSON.stringify(sample, null, 2)}\n`);
  return sample;
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    const sample = await generateSample({
      seed: process.env.BENCH_SEED ? Number(process.env.BENCH_SEED) : undefined,
      split: parseSplit(process.env.BENCH_SPLIT),
      refresh: process.env.BENCH_REFRESH === '1',
    });
    const counts = sample.tasks.reduce<Record<string, number>>((acc, task) => {
      acc[task.tier] = (acc[task.tier] ?? 0) + 1;
      return acc;
    }, {});
    console.log(
      `[bench] wrote ${SAMPLE_PATH}: ${sample.tasks.length} tasks ` +
        `(${Object.entries(counts).map(([tier, n]) => `${tier} ${n}`).join(', ')}), ` +
        `dataset sha ${sample.dataset_sha ?? 'unknown'}`,
    );
    console.log('[bench] commit this file — it is what makes two runs comparable.');
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
