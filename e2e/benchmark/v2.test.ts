import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSubmission, formatAction, mapStep, verbForScript, writeSubmission, type V2Document } from './v2.ts';
import { parseAction, validateDocument, validateSubmission } from './validate.ts';
import type { BenchRunResult, BenchStep } from '../../src/e2e/bench/recorder.ts';

/**
 * example_v2.json is upstream's own known-good document, so it is the fixture
 * with teeth: a validator that rejects it is wrong, and a writer whose grammar
 * cannot reproduce it byte for byte is producing something else.
 */
const GOLDEN_PATH = path.join(import.meta.dirname, 'fixtures', 'example_v2.json');
const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8')) as V2Document;

/** A 1×1 JPEG stands in for a real capture; only the bytes' round trip matters here. */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x01, 0xff, 0xd9]).toString('base64');

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pagehand-bench-'));
}

function screenshotsOf(document: V2Document): Set<string> {
  return new Set(document.action_history.map((step) => step.screenshot));
}

function step(overrides: Partial<BenchStep> & { tool: string }): BenchStep {
  return {
    order: 0,
    toolCallId: 'call-0',
    args: {},
    url: 'https://example.org/',
    destinationUrl: null,
    screenshot: JPEG,
    screenshotPlaceholder: false,
    captureMs: 20,
    coords: null,
    status: 'SUCCESS',
    error: null,
    thought: null,
    ...overrides,
  };
}

function runResult(overrides: Partial<BenchRunResult> = {}): BenchRunResult {
  return {
    steps: [],
    finalAnswer: 'Done.',
    completed: true,
    stop: { finishReason: 'stop', steps: 4, hitStepLimit: false, totalTokens: 1234 },
    error: null,
    timedOut: false,
    final: { url: 'https://example.org/done', screenshot: JPEG, screenshotPlaceholder: false, captureMs: 18 },
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    searchDisabled: true,
    startedAt: 1_000,
    endedAt: 61_000,
    ...overrides,
  };
}

describe('the golden fixture', () => {
  it('validates against every rule the driver enforces', () => {
    expect(validateDocument(golden, screenshotsOf(golden))).toEqual([]);
  });

  it('round-trips through the driver’s own grammar, byte for byte', () => {
    // If our formatter and the upstream document disagree on a single space,
    // every action string we submit is subtly off-dictionary.
    for (const actionStep of golden.action_history) {
      const parsed = parseAction(actionStep.action);
      expect(parsed, actionStep.action).not.toBeNull();
      expect(formatAction(parsed!)).toBe(actionStep.action);
    }
  });

  it('exercises both Grammar A shapes, so the round trip proves something', () => {
    const verbs = golden.action_history.map((s) => parseAction(s.action)!.verb);
    expect(verbs).toContain('NAVIGATE'); // page -> VERB -> …
    expect(verbs).toContain('CLICK'); //    VERB target -> …
    expect(verbs.at(-1)).toBe('TASK_COMPLETE');
    expect(golden.action_history.filter((s) => s.action_status === 'FAILED').length).toBeGreaterThan(0);
  });
});

describe('validateDocument', () => {
  const mutate = (fn: (doc: V2Document) => void): string[] => {
    const doc = JSON.parse(JSON.stringify(golden)) as V2Document;
    fn(doc);
    return validateDocument(doc, screenshotsOf(golden));
  };

  it('rule 1: rejects a wrong schema_version', () => {
    expect(mutate((d) => ((d as { schema_version: string }).schema_version = 'online-mind2web-v1')).join()).toMatch(
      /schema_version/,
    );
  });

  it('rule 2: rejects a prefixed task_id', () => {
    expect(mutate((d) => (d.task_id = `tasks/${d.task_id}`)).join()).toMatch(/task_id/);
  });

  it('rule 3: rejects a gap in step numbering', () => {
    expect(mutate((d) => (d.action_history[3].step = 99)).join()).toMatch(/\.step is 99, expected 3/);
  });

  it('rule 4: rejects a screenshot with no file behind it', () => {
    const doc = JSON.parse(JSON.stringify(golden)) as V2Document;
    doc.action_history[2].screenshot = '0099.png';
    expect(validateDocument(doc, screenshotsOf(golden)).join()).toMatch(/does not exist under trajectory/);
  });

  it('rule 5: rejects an omitted thought key, and accepts a null one', () => {
    expect(
      mutate((d) => delete (d.action_history[1] as Partial<V2Document['action_history'][number]>).thought).join(),
    ).toMatch(/missing the required "thought" key/);
    expect(mutate((d) => (d.action_history[1].thought = null))).toEqual([]);
  });

  it('rule 6: requires a TASK_COMPLETE terminal step matching agent_final_answer', () => {
    expect(mutate((d) => (d.action_history.at(-1)!.action = 'WAIT page -> stop | SUCCESS')).join()).toMatch(
      /must start with TASK_COMPLETE/,
    );
    expect(mutate((d) => (d.agent_final_answer = 'something else entirely')).join()).toMatch(
      /agent_final_answer does not match/,
    );
  });

  it('rule 7: rejects an action_status that disagrees with the suffix', () => {
    expect(mutate((d) => (d.action_history[2].action_status = 'FAILED')).join()).toMatch(/disagrees with the action suffix/);
  });

  it('rejects extra keys, which the schema forbids everywhere', () => {
    expect(mutate((d) => ((d as unknown as Record<string, unknown>).notes = 'hi')).join()).toMatch(/unknown top-level key/);
    expect(
      mutate((d) => ((d.action_history[0] as unknown as Record<string, unknown>).tool = 'click')).join(),
    ).toMatch(/unknown key "tool"/);
  });

  it('rejects a document with no steps at all', () => {
    expect(mutate((d) => (d.action_history = [])).join()).toMatch(/non-empty array/);
  });
});

describe('the writer', () => {
  it('reproduces the golden document’s shape', () => {
    const submission = buildSubmission({
      task: 'Find the opening hours.',
      taskId: 'abc123',
      referenceLength: 7,
      result: runResult({
        steps: [
          step({ order: 0, tool: 'take_snapshot', thought: 'Look at the page first.' }),
          step({ order: 1, tool: 'click', args: { uid: '12' }, coords: { x: 902, y: 204 } }),
        ],
      }),
    });

    expect(Object.keys(submission.document)).toEqual(Object.keys(golden));
    for (const written of submission.document.action_history) {
      expect(Object.keys(written)).toEqual(Object.keys(golden.action_history[0]));
    }
    expect(validateDocument(submission.document, screenshotsOf(submission.document))).toEqual([]);
  });

  it('writes the §7 action strings', () => {
    const submission = buildSubmission({
      task: 'Find the opening hours.',
      taskId: 'abc123',
      referenceLength: 7,
      result: runResult({
        finalAnswer: 'They open at 09:00.',
        steps: [
          step({
            order: 0,
            tool: 'navigate_page',
            args: { type: 'url', url: 'https://example.org/hours' },
            destinationUrl: 'https://example.org/hours',
          }),
          step({ order: 1, tool: 'take_snapshot' }),
          step({ order: 2, tool: 'click', args: { uid: '7' }, coords: { x: 902, y: 204 } }),
          step({ order: 3, tool: 'fill', args: { uid: '9', value: 'unemployment' }, coords: { x: 507, y: 1085 } }),
          step({ order: 4, tool: 'click', args: { uid: '404' }, status: 'FAILED', error: 'Unknown uid' }),
        ],
      }),
    });

    expect(submission.document.action_history.map((s) => s.action)).toEqual([
      'page -> NAVIGATE -> direct URL navigation to the recorded destination | SUCCESS',
      'WAIT page -> take an accessibility snapshot of the page | SUCCESS',
      'CLICK coords(902, 204) -> click the element at uid=7 | SUCCESS',
      'TYPE coords(507, 1085) -> fill the field at uid=9 with "unemployment" | SUCCESS',
      // A stale uid resolves to no coordinates; the action is still recorded.
      'CLICK page -> click the element at uid=404 | FAILED',
      'TASK_COMPLETE -> ANSWER: They open at 09:00.',
    ]);
    expect(submission.document.action_history[4].action_status).toBe('FAILED');
    // Rule 8: a NAVIGATE step's url is where it went, not where it started.
    expect(submission.document.action_history[0].url).toBe('https://example.org/hours');
  });

  it('drops bookkeeping calls but keeps their thoughts', () => {
    const submission = buildSubmission({
      task: 'Collect the prices.',
      taskId: 'abc123',
      referenceLength: 5,
      result: runResult({
        finalAnswer: null,
        completed: false,
        stop: { finishReason: 'length', steps: 100, hitStepLimit: true },
        steps: [
          step({ order: 0, tool: 'update_task_ledger', thought: 'Record the plan.' }),
          step({ order: 1, tool: 'web_search', args: { query: 'prices' }, status: 'FAILED' }),
          step({ order: 2, tool: 'control_task', args: { type: 'complete', summary: 'done' } }),
        ],
      }),
    });

    // Only the synthesised terminal step survives.
    expect(submission.document.action_history).toHaveLength(1);
    expect(submission.document.agent_final_answer).toBeNull();
    expect(submission.document.action_history[0].action).toBe('TASK_COMPLETE -> ANSWER:');
    expect(submission.document.action_history[0].thought).toBe(
      'Run ended without an answer: length, steps=100, hitStepLimit=true',
    );
    expect(validateDocument(submission.document, screenshotsOf(submission.document))).toEqual([]);
  });

  it('maps evaluate_script by what the script actually does', () => {
    expect(verbForScript('() => window.scrollBy(0, 800)')).toBe('SCROLL');
    expect(verbForScript('() => document.querySelector("a").click()')).toBe('CLICK');
    expect(verbForScript('() => { input.value = "x"; }')).toBe('TYPE');
    expect(verbForScript('() => document.title')).toBe('WAIT');

    const action = mapStep(step({ tool: 'evaluate_script', args: { function: '() => window.scrollBy(0, 800)' } }));
    expect(action).toEqual({
      verb: 'SCROLL',
      target: 'page',
      description: 'evaluate_script: () => window.scrollBy(0, 800)',
      status: 'SUCCESS',
    });
  });

  it('keeps the grammar’s separators out of descriptions', () => {
    const action = mapStep(step({ tool: 'fill', args: { uid: '3', value: 'a | b -> c' }, coords: { x: 1, y: 2 } }));
    expect(action!.description).toBe('fill the field at uid=3 with "a / b → c"');
    expect(parseAction(formatAction(action!))!.status).toBe('SUCCESS');
  });
});

describe('writeSubmission', () => {
  it('writes a directory that passes validation on disk', () => {
    const dir = tmpDir();
    const submission = writeSubmission(dir, {
      task: 'Find the opening hours.',
      taskId: 'abc123',
      referenceLength: 7,
      result: runResult({
        steps: [step({ order: 0, tool: 'take_snapshot', thought: 'Look first.' })],
      }),
    });

    expect(validateSubmission(dir, { referenceLength: 7 })).toEqual([]);
    expect(fs.readdirSync(path.join(dir, 'trajectory')).sort()).toEqual(['0000.jpg', '0001.jpg']);
    expect(fs.readFileSync(path.join(dir, 'trajectory', '0000.jpg')).subarray(0, 2)).toEqual(
      Buffer.from([0xff, 0xd8]),
    );

    // Rule 9 is the one a lone document cannot check: the human reference length
    // is not our step count, and the driver asserts it against the dataset.
    expect(validateSubmission(dir, { referenceLength: 12 }).join()).toMatch(/reference_length is 7/);

    // The raw trace carries everything v2 has no room for, and none of it leaks
    // into result.json, where extra keys are forbidden.
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'raw_trace.json'), 'utf8'));
    expect(raw.total_tokens ?? raw.stop.totalTokens).toBe(1234);
    expect(raw.model).toBe('deepseek-v4-flash');
    expect(submission.placeholders).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('still writes a file when a capture failed, so rule 4 holds', () => {
    const dir = tmpDir();
    writeSubmission(dir, {
      task: 'Find the opening hours.',
      taskId: 'abc123',
      referenceLength: 7,
      result: runResult({
        steps: [
          step({ order: 0, tool: 'take_snapshot', screenshot: null, screenshotPlaceholder: true }),
        ],
      }),
    });

    expect(validateSubmission(dir, { referenceLength: 7 })).toEqual([]);
    const fallback = fs.readFileSync(path.join(dir, 'trajectory', '0000.png'));
    expect(fallback.subarray(1, 4).toString()).toBe('PNG');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
