import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearNotExecutable,
  isNotExecutable,
  notExecutablePath,
  NOT_EXECUTABLE_DIR,
  writeNotExecutable,
} from './notExecutable.ts';
import { OUT_DIR } from './score.ts';

const record = {
  task_id: 'task-1',
  website: 'example.com',
  reason: 'start site did not load',
  error: 'net::ERR_HTTP2_PROTOCOL_ERROR at https://example.com/',
  at: '2026-08-17T00:00:00.000Z',
};

describe('not-executable records', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pagehand-notexec-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('lives outside the trajectories tree handed to WebJudge', () => {
    const relative = path.relative(OUT_DIR, notExecutablePath('task-1'));
    expect(relative.startsWith('..')).toBe(true);
    expect(path.dirname(NOT_EXECUTABLE_DIR)).toBe(path.dirname(OUT_DIR));
  });

  it('writes one readable file per task and reports it for resume', () => {
    expect(isNotExecutable('task-1', dir)).toBe(false);

    const file = writeNotExecutable(record, dir);

    expect(path.dirname(file)).toBe(dir);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(record);
    expect(isNotExecutable('task-1', dir)).toBe(true);
    expect(isNotExecutable('task-2', dir)).toBe(false);
  });

  it('creates no task directory that WebJudge could mistake for a trajectory', () => {
    writeNotExecutable(record, dir);
    expect(fs.readdirSync(dir)).toEqual(['task-1.json']);
  });

  it('clears the record once the task runs, and is a no-op when there is none', () => {
    writeNotExecutable(record, dir);
    clearNotExecutable('task-1', dir);
    expect(isNotExecutable('task-1', dir)).toBe(false);
    expect(() => clearNotExecutable('task-1', dir)).not.toThrow();
  });
});
