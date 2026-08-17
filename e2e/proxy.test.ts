import { describe, expect, it } from 'vitest';
import { proxyArgs, proxyBypassList } from './proxy.ts';

function bypassOf(args: string[]): string[] {
  const flag = args.find((arg) => arg.startsWith('--proxy-bypass-list='));
  if (!flag) throw new Error(`No bypass flag in ${JSON.stringify(args)}`);
  return flag.slice('--proxy-bypass-list='.length).split(',');
}

describe('proxyArgs', () => {
  it('adds nothing without BENCH_PROXY, so fixture E2E is unaffected', () => {
    expect(proxyArgs({})).toEqual([]);
    expect(proxyArgs({ BENCH_PROXY: '   ', BENCH_PROXY_BYPASS: 'api.example.com' })).toEqual([]);
  });

  it('routes the browser through the proxy with loopback direct', () => {
    const args = proxyArgs({ BENCH_PROXY: 'http://127.0.0.1:7890' });
    expect(args[0]).toBe('--proxy-server=http://127.0.0.1:7890');
    expect(bypassOf(args)).toEqual(['localhost', '127.0.0.1', '[::1]']);
  });

  it('never emits Chromium’s <-loopback> subtraction of its own accord', () => {
    const args = proxyArgs({ BENCH_PROXY: 'http://127.0.0.1:7890' });
    expect(bypassOf(args)).not.toContain('<-loopback>');
  });

  it('keeps an operator-supplied <-loopback> after the loopback bypasses', () => {
    // First match wins in Chromium, so the subtraction must never come first —
    // ahead of them it would push the fixture server through the proxy.
    const bypass = proxyBypassList('<-loopback>,api.example.com');
    expect(bypass.indexOf('<-loopback>')).toBeGreaterThan(bypass.indexOf('localhost'));
    expect(bypass.indexOf('<-loopback>')).toBeGreaterThan(bypass.indexOf('127.0.0.1'));
    expect(bypass.indexOf('<-loopback>')).toBeGreaterThan(bypass.indexOf('[::1]'));
  });

  it('appends BENCH_PROXY_BYPASS hosts, trimmed, without duplicating loopback', () => {
    expect(proxyBypassList(' api.example.com , ,127.0.0.1, model.test ')).toEqual([
      'localhost',
      '127.0.0.1',
      '[::1]',
      'api.example.com',
      'model.test',
    ]);
  });
});
