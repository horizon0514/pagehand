import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The Online-Mind2Web task list.
 *
 * The dataset is gated (`gated: "auto"` on HuggingFace — access is
 * auto-approved, but a token is still required and there is no public mirror),
 * so an absent HF_TOKEN is a hard stop with instructions rather than a
 * mysterious 401. Once fetched it is cached, because the task list changes
 * rarely and the run should not depend on the network at task 17 of 30.
 */

export const DATASET_REPO = 'osunlp/Online-Mind2Web';
const DATASET_FILE = 'Online_Mind2Web.json';
const DATASET_URL = `https://huggingface.co/datasets/${DATASET_REPO}/resolve/main/${DATASET_FILE}`;
const DATASET_API = `https://huggingface.co/api/datasets/${DATASET_REPO}`;

export const CACHE_DIR = path.join(import.meta.dirname, '.cache');
const CACHE_FILE = path.join(CACHE_DIR, DATASET_FILE);
const META_FILE = path.join(CACHE_DIR, 'dataset-meta.json');

export type Tier = 'easy' | 'medium' | 'hard';

export interface DatasetTask {
  task_id: string;
  confirmed_task: string;
  website: string;
  reference_length: number;
}

export interface Dataset {
  tasks: DatasetTask[];
  /** Upstream commit sha, so drift between two runs is visible instead of silent. */
  sha: string | null;
  source: 'cache' | 'huggingface';
}

const MISSING_TOKEN = [
  `The ${DATASET_REPO} dataset is gated on HuggingFace and no cached copy exists.`,
  '',
  '  1. Request access (auto-approved): https://huggingface.co/datasets/osunlp/Online-Mind2Web',
  '  2. Create a read token:            https://huggingface.co/settings/tokens',
  '  3. Set HF_TOKEN=hf_… in your environment or in .env.local',
  '',
  'Then re-run. The task list is cached under e2e/benchmark/.cache/ afterwards.',
].join('\n');

/**
 * The paper's stratification, derived here rather than read from a `level`
 * field — the field is not guaranteed to exist and the rule is published.
 */
export function tierOf(referenceLength: number): Tier {
  if (referenceLength <= 5) return 'easy';
  if (referenceLength <= 10) return 'medium';
  return 'hard';
}

/** Fails loudly if the upstream shape moved: a silent rename would poison every run. */
export function assertDatasetShape(raw: unknown): DatasetTask[] {
  if (!Array.isArray(raw)) {
    throw new Error(`${DATASET_FILE} is not a JSON array — the upstream shape has changed.`);
  }
  const tasks = raw.map((entry, index) => {
    const record = entry as Record<string, unknown>;
    const missing = ['task_id', 'confirmed_task', 'website', 'reference_length'].filter(
      (key) => record?.[key] === undefined || record?.[key] === null,
    );
    if (missing.length > 0) {
      throw new Error(
        `${DATASET_FILE}[${index}] is missing ${missing.join(', ')} — the upstream shape has changed. ` +
          `Keys present: ${Object.keys(record ?? {}).join(', ')}`,
      );
    }
    const referenceLength = Number(record.reference_length);
    if (!Number.isInteger(referenceLength) || referenceLength < 1) {
      throw new Error(`${DATASET_FILE}[${index}].reference_length is not a positive integer`);
    }
    return {
      task_id: String(record.task_id),
      confirmed_task: String(record.confirmed_task),
      website: String(record.website),
      reference_length: referenceLength,
    };
  });

  if (tasks.length === 0) throw new Error(`${DATASET_FILE} contains no tasks.`);
  return tasks;
}

async function fetchSha(token: string): Promise<string | null> {
  try {
    const response = await fetch(DATASET_API, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) return null;
    const body = (await response.json()) as { sha?: unknown };
    return typeof body.sha === 'string' ? body.sha : null;
  } catch {
    return null;
  }
}

export interface LoadOptions {
  /** Ignore the cache and re-fetch (also refreshes the recorded sha). */
  refresh?: boolean;
  token?: string;
}

export async function loadDataset(options: LoadOptions = {}): Promise<Dataset> {
  const token = (options.token ?? process.env.HF_TOKEN ?? '').trim();

  if (!options.refresh && fs.existsSync(CACHE_FILE)) {
    const tasks = assertDatasetShape(JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')));
    const meta = fs.existsSync(META_FILE)
      ? (JSON.parse(fs.readFileSync(META_FILE, 'utf8')) as { sha?: string | null })
      : {};
    return { tasks, sha: meta.sha ?? null, source: 'cache' };
  }

  if (!token) throw new Error(MISSING_TOKEN);

  const response = await fetch(DATASET_URL, { headers: { Authorization: `Bearer ${token}` } });
  if (response.status === 401 || response.status === 403) {
    throw new Error(
      `HuggingFace refused the token (HTTP ${response.status}). Request access to ` +
        `https://huggingface.co/datasets/${DATASET_REPO} with the account that owns HF_TOKEN.`,
    );
  }
  if (!response.ok) {
    throw new Error(`Failed to fetch ${DATASET_URL}: HTTP ${response.status} ${response.statusText}`);
  }

  const body = await response.text();
  const tasks = assertDatasetShape(JSON.parse(body));
  const sha = await fetchSha(token);

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(CACHE_FILE, body);
  fs.writeFileSync(
    META_FILE,
    `${JSON.stringify({ sha, fetchedAt: new Date().toISOString(), tasks: tasks.length }, null, 2)}\n`,
  );

  return { tasks, sha, source: 'huggingface' };
}

/**
 * The cached copy, without touching the network.
 *
 * Playwright collects spec files synchronously, and a driver that fetched a
 * gated dataset while enumerating tests would fail 30 tasks at once for a
 * network blip. scripts/benchmark.mjs primes the cache before the run instead.
 */
export function loadDatasetSync(): Dataset {
  if (!fs.existsSync(CACHE_FILE)) {
    if (!(process.env.HF_TOKEN ?? '').trim()) throw new Error(MISSING_TOKEN);
    throw new Error(
      `No cached dataset at ${CACHE_FILE}. Fetch it once with:\n  npm run bench:om2w -- --fetch`,
    );
  }
  const tasks = assertDatasetShape(JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')));
  const meta = fs.existsSync(META_FILE)
    ? (JSON.parse(fs.readFileSync(META_FILE, 'utf8')) as { sha?: string | null })
    : {};
  return { tasks, sha: meta.sha ?? null, source: 'cache' };
}

export function tierCounts(tasks: DatasetTask[]): Record<Tier, number> {
  const counts: Record<Tier, number> = { easy: 0, medium: 0, hard: 0 };
  for (const task of tasks) counts[tierOf(task.reference_length)] += 1;
  return counts;
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

// `npm run bench:om2w -- --fetch`: prime the cache and report what came back,
// without touching the pinned sample.
if (invokedDirectly) {
  try {
    const dataset = await loadDataset({ refresh: process.env.BENCH_REFRESH !== '0' });
    const counts = tierCounts(dataset.tasks);
    console.log(
      `[bench] ${dataset.tasks.length} tasks from ${dataset.source} ` +
        `(easy ${counts.easy}, medium ${counts.medium}, hard ${counts.hard}), ` +
        `sha ${dataset.sha ?? 'unknown'} -> ${CACHE_FILE}`,
    );
  } catch (err) {
    // These messages are instructions; a stack trace on top of them helps nobody.
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
