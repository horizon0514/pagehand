# Online-Mind2Web benchmark driver

> Status: **driver exercised end to end on a 30-task sample run.** The knobs in
> §2 and the caveats in §5 come from that run. No leaderboard number exists: that
> needs all 300 tasks averaged over three runs.
> A run needs three credentials (§1) and costs real money and hours (§5).

Runs Pagehand's agent against a pinned 30-task sample of
[Online-Mind2Web](https://github.com/OSU-NLP-Group/Online-Mind2Web), records one
schema-v2 trajectory per task, and hands the result directly to the benchmark's
own WebJudge evaluator.

Nothing here touches product code. The recorder lives in `src/e2e/`, which is
imported only behind `import.meta.env.VITE_E2E === 'true'` (`src/sidepanel/main.tsx`)
and is absent from a normal build — verified by grepping `npm run build` output.

## 1. Prerequisites

| What | Why | Where |
|---|---|---|
| `HF_TOKEN` | the dataset is gated (`gated: "auto"` — access is auto-approved, but a token is still required, and there is no public mirror) | https://huggingface.co/settings/tokens |
| A model key | Pagehand is BYOK; the agent under test is whatever you configure | `PAGEHAND_*` below |
| An OpenAI-shaped key | WebJudge scoring, `o4-mini` (README is emphatic: GPT-4o is measurably worse) | §4 |

`.env.local` is read for all of these, same as the rest of the E2E suite.

## 2. Running it

```bash
# once: fetch the gated task list, then pin 30 tasks and commit the pin
HF_TOKEN=hf_… NODE_USE_ENV_PROXY=1 npm run bench:om2w -- --fetch
HF_TOKEN=hf_… NODE_USE_ENV_PROXY=1 npm run bench:om2w -- --sample     # writes e2e/benchmark/sample.json

# the run itself
PAGEHAND_PROVIDER=deepseek PAGEHAND_MODEL=deepseek-v4-flash PAGEHAND_API_KEY=sk-… \
  npm run bench:om2w

npm run bench:om2w -- --tasks <task_id>          # one task
npm run bench:om2w -- --resume                   # skip tasks with a result.json or a not-executable record
npm run bench:om2w -- --score                    # re-print the local heuristic over out/
```

Output per task, under `e2e/benchmark/out/<task_id>/` (gitignored):

```
result.json          # the v2 submission — validated before the run moves on
trajectory/0000.jpg  # one screenshot per step, captured before the action ran
raw_trace.json       # everything v2 has no room for: tokens, timings, bookkeeping calls
```

A start URL that fails to load is retried once and then recorded as
`e2e/benchmark/not-executable/<task_id>.json` plus a run-summary row, and the
task is skipped — an environment failure, kept out of the judged denominator
rather than crashing the task with no artefact. (A 403 bot wall is *not* this
case: it loads, so the agent runs and the result is judged. Read those apart from
agent failures.)

That record sits **beside** `out/`, never inside it: `out/` is handed to WebJudge
as `--trajectories_dir` and every subdirectory under it is scored as a judged
trajectory, so a task folder holding only the diagnostic would be counted as a
failure — the opposite of what recording it is for. `--resume` skips a task with
such a record, and the record is deleted the moment the same task's start site
does serve a page, so a site that was down yesterday is not skipped forever.

Knobs: `BENCH_SEED`, `BENCH_SPLIT` (default `8/14/8`, proportional to the
83/143/74 population), `BENCH_TASK_TIMEOUT_MS` (default 15 min),
`BENCH_ALLOW_SEARCH=1`, `BENCH_WORKERS` (default 1, see §5).

### Network

Two environment facts bit a real run and neither has an obvious error message:

| | |
|---|---|
| `NODE_USE_ENV_PROXY=1` | Node's `undici` `fetch` ignores `HTTP_PROXY`/`HTTPS_PROXY`, so `--fetch`/`--sample` fail with a bare `fetch failed` wherever huggingface.co needs a proxy. The token is fine; the message misleads. Node ≥24 |
| `BENCH_PROXY` / `BENCH_PROXY_BYPASS` | route the browser's page traffic through an egress proxy (`BENCH_PROXY=http://127.0.0.1:7890`). Off by default; loopback (`localhost`, `127.0.0.1`, `[::1]`) is always bypassed, so fixture E2E is unaffected — Chromium's `<-loopback>` subtraction is never emitted, and an operator-supplied one is ordered after those rules so it cannot shadow them. **Put the model API host in `BENCH_PROXY_BYPASS`** (e.g. `api.deepseek.com`): page traffic saturates the proxy, and a mid-turn network error from the LLM endpoint kills the whole task |

Live sites can be hard-blocked (403/503) from a given egress — measure
reachability before a run and report reachable-site results alongside the
headline, or the number describes the network as much as the agent.

## 3. How it works

`__cdp.bench.run()` (`src/e2e/bench/recorder.ts`) drives `runAgentTurn` directly
and records from two channels joined on the SDK's `toolCallId`: the event stream
supplies thoughts and ordering, a wrapper around each `tools[name].execute`
supplies the pre-action URL, screenshot and SUCCESS/FAILED status. Neither
channel decides pairing — the id does — so a thought cannot drift onto the wrong
action, which is the v1 desync v2 exists to prevent.

Two consequences worth knowing:

- **Failed actions are recorded, not lost.** A stale uid throws; the step still
  carries its own screenshot, URL and `FAILED`. (The upstream example trajectory
  is 4/14 `FAILED` — a recorder that only sees successes produces a flattering,
  non-comparable trace.)
- **The ledger is activated per task.** `control_task` is filtered out of the
  tool list until a non-empty ledger exists, so without this the agent can never
  signal completion the way the product intends.

`e2e/benchmark/v2.ts` maps one tool call to at most one v2 step (Grammar A
throughout); `validate.ts` enforces README §6's nine rules locally before
anything ships.

## 4. Scoring

The official evaluator reads our v2 output natively — no adapter:

```bash
OPENAI_BASE_URL=https://openrouter.ai/api/v1 \
python ./src/run.py --mode WebJudge_Online_Mind2Web_eval --model o4-mini \
  --trajectories_dir e2e/benchmark/out --api_key $OPENROUTER_API_KEY \
  --output_path e2e/benchmark/out_result --num_worker 1 --score_threshold 3
```

Three upstream-repo snags, all outside Pagehand and all hit with `o4-mini`:

- **`max_tokens` defaults to 512**, which a reasoning model spends on reasoning
  tokens: `judge_image` then gets truncated or empty text, every image scores 0
  through the `except` path, and the judgment silently degenerates to text-only.
  Raise it (≈4096) before trusting a score. Note also that the o-series rejects
  `max_tokens` in favour of `max_completion_tokens`, so the repo as published
  cannot run `o4-mini` against OpenAI directly.
- **macOS `spawn` can't pickle the client**: `parallel_eval` hands each worker an
  engine holding an `RLock`. Fine under Linux `fork`; set the start method (or
  run with `--num_worker 1`) on macOS.
- A `--model` containing a slash (`openai/o4-mini`) makes the output filename
  nest a directory — pre-create it to avoid `FileNotFoundError`.

`npm run bench:om2w -- --score` prints a **local heuristic** instead — completion
rate, step-limit rate, failed-action rate, steps against the human reference.
That is not a success rate and must never be reported as one: it measures whether
the agent believed it finished, which is exactly what a confused agent also says.

## 5. Known deviations and limits

| | |
|---|---|
| `web_search` disabled by default | the benchmark instructs agents to start from the given site; Pagehand's prompt pushes search hard, and leaving it on produces a non-comparable number. `BENCH_ALLOW_SEARCH=1` for a Pagehand-as-shipped run; the flag's state is recorded in the run summary either way |
| `evaluate_script` verb mapping is a heuristic | one script can read, scroll, click, or all three, and v2 has no verb for "ran a program". The verb is inferred from the source and the source goes in the description. The real fix is instrumenting the injected script |
| n=30 gives roughly ±17 percentage points | at p≈0.4 the 95% CI is ±0.175. This distinguishes "about 20%" from "about 70%"; it does not distinguish 45% from 55%. Never quote a decimal |
| The number is about one model, one day, one set of live sites | all four belong in the headline, not a footnote. Live sites also bring CAPTCHAs and consent walls — classify those separately from agent failure |
| Serial by default | one debugger attachment per profile, one fresh profile per task. Parallelism is probably available (the lock is per-profile) but is unverified, and three workers hammering the same live sites is its own problem |
| Cost | ~$6 for 30 tasks on a flash-class model, ~$60 on Sonnet-class, ±2×. Judge is ~$2–5. Wall clock 2.5–4 h serial. `stop.totalTokens` is recorded per task, so run 1 replaces these estimates with measurements |

## 6. What is verified

- The v2 writer and validator against upstream's own `example_v2.json`
  (`e2e/benchmark/v2.test.ts`, run by `npm test`), including a byte-for-byte
  grammar round trip over every action string in that document.
- The recorder against the local fixture page, with no API key
  (`e2e/benchRecorder.spec.ts`, run by `npm run test:e2e`): interception of every
  call including the ones that throw, occluded-tab capture, navigation
  destinations, `web_search` neutralisation, and a full
  run → write → validate chain against a model endpoint that isn't there.

Unverified until credentials exist: agent behaviour on live sites, the sample
selection against the real dataset, and WebJudge scoring.
