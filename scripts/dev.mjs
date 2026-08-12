// Starts both halves of local development: the extension's Vite build and the
// `cloud/` Next server it talks to.
//
// They are genuinely two processes — separate npm projects, separate ports —
// but needing two terminals to see one sign-in through is friction with nothing
// to teach. This keeps them tied together: one Ctrl-C stops both, and either
// one falling over takes the other down rather than leaving half a stack
// running and a developer wondering which half.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const cloud = path.join(root, 'cloud');
/** Where a dev build's HOSTED_BASE_URL points — see lib/storage/schema.ts. */
const CLOUD_URL = 'http://localhost:3000';

if (!fs.existsSync(path.join(cloud, 'node_modules'))) {
  console.error('cloud/ has no dependencies installed. Run:\n\n  cd cloud && npm install\n');
  process.exit(1);
}

/** @type {{ name: string, child: import('node:child_process').ChildProcess }[]} */
const running = [];
let stopping = false;

function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const { child } of running) {
    // Negative pid signals the whole group. `npm run` is a shell that spawns
    // vite/next underneath it, so signalling npm alone leaves the real server
    // alive and holding its port — which then makes the next `npm run dev`
    // start on a different one and quietly stop matching what dist/ points at.
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
  }
  // Long enough for the ports to be released before the shell prompt returns.
  // Deliberately not unref'd: this timer is the only thing keeping the loop
  // alive once both children are gone, and letting the process fall out on its
  // own would exit 0 and hide whichever failure started the shutdown.
  setTimeout(() => process.exit(code), 300);
}

/**
 * Whether something is already serving the local API.
 *
 * Next refuses to start a second dev server for the same directory, so without
 * this check running `npm run dev` while a `cd cloud && npm run dev` is already
 * open kills both halves and leaves you worse off than before. Adopting the
 * running one is what a person would do.
 */
async function cloudAlreadyRunning() {
  try {
    await fetch(`${CLOUD_URL}/`, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}

function start(name, cwd, script) {
  // detached: true puts the child in its own process group. That is what makes
  // the group-kill above possible, and it also means Ctrl-C reaches this
  // process alone — so shutdown happens here, in one place, in a known order.
  const child = spawn('npm', ['run', script], { cwd, stdio: 'inherit', detached: true });

  child.on('error', (err) => {
    console.error(`\n[${name}] could not start: ${err.message}`);
    stop(1);
  });
  child.on('exit', (code, signal) => {
    if (stopping) return;
    console.error(`\n[${name}] exited (${signal ?? code}) — stopping the other half.`);
    stop(code ?? 1);
  });

  running.push({ name, child });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => stop(0));
}

if (await cloudAlreadyRunning()) {
  console.log(`[cloud] already serving ${CLOUD_URL} — leaving it alone.\n`);
} else {
  start('cloud', cloud, 'dev');
}
start('extension', root, 'dev:ext');
