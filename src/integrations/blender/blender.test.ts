import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserBlenderBridge } from './BrowserBlenderBridge';

const ORIGINAL_FETCH = globalThis.fetch;

describe('BrowserBlenderBridge', () => {
  let originalDev: unknown;

  beforeEach(() => {
    // happy-dom flags import.meta.env.DEV automatically. Force-set to true
    // for these tests; the production guard is exercised separately below.
    originalDev = import.meta.env.DEV;
    (import.meta.env as { DEV: boolean }).DEV = true;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = ORIGINAL_FETCH;
    (import.meta.env as { DEV: boolean }).DEV = originalDev as boolean;
  });

  it('reports companionConnected:false on a vite-mock response', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          source: 'vite-mock',
          companionConnected: false,
          assetsDir: null,
          lastUpdate: null,
        }),
        { status: 200 },
      ),
    ) as typeof fetch;

    const bridge = new BrowserBlenderBridge();
    bridge.start({ intervalMs: 100 });
    // First tick fires immediately, but we need the microtasks to flush.
    await vi.advanceTimersByTimeAsync(0);
    const state = bridge.current();
    expect(state?.companionConnected).toBe(false);
    expect(state?.source).toBe('vite-mock');
    bridge.stop();
  });

  it('subscribers receive live updates', async () => {
    let counter = 0;
    globalThis.fetch = vi.fn(async () => {
      counter++;
      return new Response(
        JSON.stringify({
          companionConnected: counter > 1,
          assetsDir: counter > 1 ? '/x/y' : null,
          lastUpdate: counter > 1 ? 12345 : null,
          source: 'companion',
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const bridge = new BrowserBlenderBridge();
    const seen: boolean[] = [];
    const unsub = bridge.subscribe((s) => seen.push(s.companionConnected));
    bridge.start({ intervalMs: 100 });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(0);

    expect(seen).toContain(true);
    unsub();
    bridge.stop();
  });

  it('handles fetch failure gracefully (companion not running)', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('connection refused');
    }) as typeof fetch;

    const bridge = new BrowserBlenderBridge();
    bridge.start({ intervalMs: 100 });
    await vi.advanceTimersByTimeAsync(0);
    expect(bridge.current()?.companionConnected).toBe(false);
    expect(bridge.current()?.source).toBe('unknown');
    bridge.stop();
  });

  it('start is idempotent', () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ companionConnected: false }), { status: 200 }),
    ) as typeof fetch;
    const bridge = new BrowserBlenderBridge();
    bridge.start({ intervalMs: 100 });
    bridge.start({ intervalMs: 50 }); // ignored
    bridge.stop();
  });

  it('does not poll when DEV is false (production guard)', () => {
    (import.meta.env as { DEV: boolean }).DEV = false;
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({}), { status: 200 }),
    ) as typeof fetch;
    globalThis.fetch = fetchSpy;
    const bridge = new BrowserBlenderBridge();
    bridge.start({ intervalMs: 50 });
    expect(fetchSpy).not.toHaveBeenCalled();
    bridge.stop();
  });
});
