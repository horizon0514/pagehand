import fs from 'node:fs';
import path from 'node:path';

/**
 * Start sites that never served a page.
 *
 * The diagnostic deliberately lives *outside* `out/`: that directory is handed
 * to WebJudge as `--trajectories_dir`, and every subdirectory under it is taken
 * to be a judged trajectory. A task folder holding only `not-executable.json`
 * would therefore be scored as a failed attempt — inflating the denominator the
 * record exists to keep it out of. One flat file per task beside `out/` keeps
 * the run resumable without ever entering the judged tree.
 */

export const NOT_EXECUTABLE_DIR = path.join(import.meta.dirname, 'not-executable');

export interface NotExecutableRecord {
  task_id: string;
  website: string;
  reason: string;
  error: string;
  at: string;
}

export function notExecutablePath(taskId: string, dir = NOT_EXECUTABLE_DIR): string {
  return path.join(dir, `${taskId}.json`);
}

/** True when a previous run already recorded this task's start site as dead. */
export function isNotExecutable(taskId: string, dir = NOT_EXECUTABLE_DIR): boolean {
  return fs.existsSync(notExecutablePath(taskId, dir));
}

export function writeNotExecutable(record: NotExecutableRecord, dir = NOT_EXECUTABLE_DIR): string {
  const file = notExecutablePath(record.task_id, dir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  return file;
}

/**
 * Drops a stale record once the same task actually runs, so a site that was
 * down yesterday is not skipped forever by `--resume`.
 */
export function clearNotExecutable(taskId: string, dir = NOT_EXECUTABLE_DIR): void {
  fs.rmSync(notExecutablePath(taskId, dir), { force: true });
}
