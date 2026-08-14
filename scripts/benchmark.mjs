#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Entry point for the Online-Mind2Web benchmark: `npm run bench:om2w`.
 *
 * Everything expensive happens in Playwright (e2e/benchmark/run.spec.ts); this
 * script exists to fail fast and legibly before any of it starts — a missing
 * token or an unbuilt extension should cost a second, not an hour.
 *
 *   npm run bench:om2w                      # all pinned tasks
 *   npm run bench:om2w -- --tasks abc123    # one task
 *   npm run bench:om2w -- --resume          # skip tasks that already have a result.json
 *   npm run bench:om2w -- --fetch           # refresh the gated dataset cache, then stop
 *   npm run bench:om2w -- --sample          # (re)generate and pin the 30-task sample, then stop
 *   npm run bench:om2w -- --score           # re-run the local heuristic over out/, then stop
 */

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const BENCH_DIR = path.join(ROOT, 'e2e', 'benchmark');
const DIST = path.join(ROOT, 'dist');

const NODE_MAJOR = Number(process.versions.node.split('.')[0]);

function parseArgs(argv) {
  const args = { tasks: [], resume: false, fetch: false, sample: false, score: false, build: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--resume') args.resume = true;
    else if (arg === '--fetch') args.fetch = true;
    else if (arg === '--sample') args.sample = true;
    else if (arg === '--score') args.score = true;
    else if (arg === '--build') args.build = true;
    else if (arg === '--no-build') args.build = false;
    else if (arg === '--tasks') args.tasks.push(...String(argv[++i] ?? '').split(','));
    else if (arg.startsWith('--tasks=')) args.tasks.push(...arg.slice('--tasks='.length).split(','));
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  args.tasks = args.tasks.map((id) => id.trim()).filter(Boolean);
  return args;
}

/** .env.local is where this repo keeps keys; mirror e2e/env.ts's parsing, dependency-free. */
function loadLocalEnv() {
  const file = path.join(ROOT, '.env.local');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && value && process.env[key] === undefined) process.env[key] = value;
  }
}

function runNodeTs(file, extraEnv = {}) {
  if (NODE_MAJOR < 22) {
    console.error(
      `Node ${process.versions.node} cannot run TypeScript directly. Use Node 22.18+ (or 23.6+) for ` +
        'the benchmark helper scripts.',
    );
    process.exit(1);
  }
  const result = spawnSync(process.execPath, ['--experimental-strip-types', file], {
    stdio: 'inherit',
    cwd: ROOT,
    env: { ...process.env, ...extraEnv },
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function ensureBuild(force) {
  const built = fs.existsSync(path.join(DIST, 'manifest.json'));
  if (built && !force) return;
  console.log(`[bench] building the E2E extension (${built ? 'forced' : 'no dist/manifest.json'})…`);
  const result = spawnSync('npm', ['run', 'build:e2e'], { stdio: 'inherit', cwd: ROOT });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const args = parseArgs(process.argv.slice(2));
loadLocalEnv();

if (args.fetch) {
  // loadDataset() itself explains how to get a token when HF_TOKEN is absent.
  runNodeTs(path.join(BENCH_DIR, 'dataset.ts'), { BENCH_REFRESH: '1' });
  process.exit(0);
}

if (args.sample) {
  runNodeTs(path.join(BENCH_DIR, 'sample.ts'));
  process.exit(0);
}

if (args.score) {
  runNodeTs(path.join(BENCH_DIR, 'score.ts'));
  process.exit(0);
}

if (!fs.existsSync(path.join(BENCH_DIR, 'sample.json'))) {
  console.error(
    'No pinned sample. Generate it once (needs HF_TOKEN) with:\n' +
      '  npm run bench:om2w -- --sample\n' +
      'and commit e2e/benchmark/sample.json so later runs use the same 30 tasks.',
  );
  process.exit(1);
}

if (!process.env.PAGEHAND_PROVIDER || !process.env.PAGEHAND_MODEL || !process.env.PAGEHAND_API_KEY) {
  console.error(
    'Set the agent under test before running:\n' +
      '  PAGEHAND_PROVIDER=deepseek PAGEHAND_MODEL=deepseek-v4-flash PAGEHAND_API_KEY=sk-… npm run bench:om2w\n' +
      '(PAGEHAND_BASE_URL is optional; PAGEHAND_PROVIDER=hosted is refused — the run must be BYOK.)',
  );
  process.exit(1);
}

ensureBuild(args.build === true);

const env = { ...process.env };
if (args.resume) env.BENCH_RESUME = '1';
if (args.tasks.length > 0) env.BENCH_TASKS = args.tasks.join(',');

console.log(
  `[bench] provider=${env.PAGEHAND_PROVIDER} model=${env.PAGEHAND_MODEL} ` +
    `search=${env.BENCH_ALLOW_SEARCH === '1' ? 'enabled' : 'disabled'} ` +
    `workers=${env.BENCH_WORKERS ?? 1}${args.resume ? ' resume' : ''}` +
    `${args.tasks.length > 0 ? ` tasks=${args.tasks.join(',')}` : ''}`,
);

const run = spawnSync(
  'npx',
  ['playwright', 'test', '--config', 'playwright.bench.config.ts'],
  { stdio: 'inherit', cwd: ROOT, env },
);

// Score whatever completed, even if some tasks failed — a partial run still has
// a failure taxonomy worth reading.
runNodeTs(path.join(BENCH_DIR, 'score.ts'));
process.exit(run.status ?? 1);
