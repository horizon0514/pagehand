# Online-Mind2Web benchmark driver

> Status: **driver built and verified offline; no benchmark run has happened yet.**
> The full run needs three credentials (§1) and costs real money and hours (§5).

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
HF_TOKEN=hf_… npm run bench:om2w -- --fetch
HF_TOKEN=hf_… npm run bench:om2w -- --sample     # writes e2e/benchmark/sample.json

# the run itself
PAGEHAND_PROVIDER=deepseek PAGEHAND_MODEL=deepseek-v4-flash PAGEHAND_API_KEY=sk-… \
  npm run bench:om2w

npm run bench:om2w -- --tasks <task_id>          # one task
npm run bench:om2w -- --resume                   # skip tasks that already have a result.json
npm run bench:om2w -- --score                    # re-print the local heuristic over out/
```

Output per task, under `e2e/benchmark/out/<task_id>/` (gitignored):

```
result.json          # the v2 submission — validated before the run moves on
trajectory/0000.jpg  # one screenshot per step, captured before the action ran
raw_trace.json       # everything v2 has no room for: tokens, timings, bookkeeping calls
```

Knobs: `BENCH_SEED`, `BENCH_SPLIT` (default `8/14/8`, proportional to the
83/143/74 population), `BENCH_TASK_TIMEOUT_MS` (default 15 min),
`BENCH_ALLOW_SEARCH=1`, `BENCH_WORKERS` (default 1, see §5).

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
