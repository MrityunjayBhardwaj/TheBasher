// Telemetry recorder tests — privacy posture, killswitch, allowlist.
//
// REF: P2.5.2 PLAN §5 Wave D step 9; vyapti V15.

import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetTelemetryCacheForTests,
  clearEvents,
  isTelemetryDisabled,
  readEvents,
  recordEvent,
} from './recorder';

// happy-dom in this version exposes a `localStorage` object that lacks
// the full Storage API surface (no `removeItem`). The recorder gracefully
// handles a missing localStorage via try/catch, but tests want to drive
// the killswitch through actual writes — install a small in-memory
// polyfill that satisfies the Storage interface contract.
function installLocalStoragePolyfill(): void {
  const store = new Map<string, string>();
  const polyfill: Storage = {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? (store.get(key) as string) : null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: polyfill,
    writable: true,
    configurable: true,
  });
}
installLocalStoragePolyfill();

beforeEach(() => {
  __resetTelemetryCacheForTests();
  clearEvents();
  localStorage.removeItem('basher.telemetry.disabled');
});

describe('telemetry recorder', () => {
  it('records allowlisted tool_call events with no PII', () => {
    recordEvent({ kind: 'tool_call', toolName: 'mutator.rotate', success: true, durationMs: 12 });
    const events = readEvents();
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.kind).toBe('tool_call');
    expect(e.toolName).toBe('mutator.rotate');
    expect(e.success).toBe(true);
    expect(e.durationMs).toBe(12);
    expect(typeof e.timestamp).toBe('number');
    expect(typeof e.sessionId).toBe('string');
    // Negative assertion: nothing in the event carries content.
    const json = JSON.stringify(e);
    expect(json).not.toMatch(/prompt|args|nodeId|params/);
  });

  it('drops events for non-allowlisted tool names (defense vs accidental leak)', () => {
    recordEvent({
      kind: 'tool_call',
      toolName: 'mutator.unregistered',
      success: true,
      durationMs: 5,
    });
    expect(readEvents()).toHaveLength(0);
  });

  it('killswitch via localStorage: recorder no-ops when disabled', () => {
    localStorage.setItem('basher.telemetry.disabled', 'true');
    __resetTelemetryCacheForTests();
    expect(isTelemetryDisabled()).toBe(true);
    recordEvent({ kind: 'tool_call', toolName: 'dag.exec', success: true });
    expect(readEvents()).toHaveLength(0);
  });

  it('readEvents returns [] when telemetry is disabled, even if events exist', () => {
    recordEvent({ kind: 'tool_call', toolName: 'dag.exec', success: true });
    expect(readEvents()).toHaveLength(1);
    localStorage.setItem('basher.telemetry.disabled', 'true');
    __resetTelemetryCacheForTests();
    expect(readEvents()).toHaveLength(0);
  });

  it('non-tool events bypass the allowlist (turn_start/end, diff_accept/reject)', () => {
    recordEvent({ kind: 'turn_start' });
    recordEvent({ kind: 'turn_end', durationMs: 1500 });
    recordEvent({ kind: 'diff_accept', success: true });
    recordEvent({ kind: 'diff_reject', success: false });
    expect(readEvents()).toHaveLength(4);
  });

  it('clearEvents removes the localStorage bucket', () => {
    recordEvent({ kind: 'turn_start' });
    expect(readEvents().length).toBeGreaterThan(0);
    clearEvents();
    expect(readEvents()).toHaveLength(0);
  });

  it('sessionId is stable across events in the same recorder lifetime', () => {
    recordEvent({ kind: 'turn_start' });
    recordEvent({ kind: 'turn_end', durationMs: 1 });
    const events = readEvents();
    expect(events).toHaveLength(2);
    expect(events[0].sessionId).toBe(events[1].sessionId);
  });
});
