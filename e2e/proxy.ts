/**
 * Chromium proxy flags for the E2E/benchmark browser.
 *
 * Kept in its own module — free of Playwright imports — so the generated
 * argument list is unit-testable without launching a browser.
 */

/** The loopback hosts that must always resolve direct, whatever the proxy is. */
const LOOPBACK_BYPASS = ['localhost', '127.0.0.1', '[::1]'];

/**
 * Chromium's `<-loopback>` is a *subtraction*: it cancels the implicit rule that
 * keeps loopback traffic off the proxy. Bypass rules are evaluated in order and
 * the first match wins, so it must never be able to shadow the explicit loopback
 * entries above — otherwise the fixture server on localhost is dialled through
 * the proxy and every fixture test fails with a connection error. We never emit
 * it ourselves; if an operator puts it in BENCH_PROXY_BYPASS it is preserved but
 * lands after the loopback rules, where it can only affect other hosts.
 */
export function proxyBypassList(extra: string | undefined): string[] {
  const configured = (extra ?? '')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean)
    .filter((host) => !LOOPBACK_BYPASS.includes(host));

  return [...LOOPBACK_BYPASS, ...configured];
}

/**
 * Opt-in egress proxy for benchmark runs against live sites (`BENCH_PROXY`,
 * e.g. `http://127.0.0.1:7890`). Off by default, so fixture E2E is unaffected;
 * loopback is always bypassed so the fixture server stays reachable when it
 * is on.
 *
 * `BENCH_PROXY_BYPASS` (comma-separated hosts) additionally routes those hosts
 * direct. Put the model API here: page traffic can saturate the proxy and a
 * mid-turn `network error` from the LLM endpoint kills the whole task, so the
 * model API must never share a contended egress with the pages under test.
 */
export function proxyArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  const proxy = env.BENCH_PROXY?.trim();
  if (!proxy) return [];

  return [
    `--proxy-server=${proxy}`,
    `--proxy-bypass-list=${proxyBypassList(env.BENCH_PROXY_BYPASS).join(',')}`,
  ];
}
