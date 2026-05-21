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
    // #21: shape allowlist beats a content blocklist. A regex over
    // JSON.stringify(e) checking `not.toMatch(/prompt|args|nodeId|params/)`
    // would slip past a future field named `arguments`, `payload`,
    // `details`, etc. Asserting on the exact key set forces every
    // new field to walk through both this test AND the types file,
    // making it impossible to land a PII surface without a review.
    const ALLOWED_KEYS = new Set([
      'kind',
      'toolName',
      'success',
      'durationMs',
      'timestamp',
      'sessionId',
    ]);
    for (const k of Object.keys(e)) {
      expect(ALLOWED_KEYS.has(k)).toBe(true);
    }
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

  it('drops events with an unknown kind (#21 defense-in-depth)', () => {
    // Type-system normally prevents this; cast through unknown so the
    // runtime allowlist is what we observe — protects against a future
    // caller-side type widening or external (e.g. devtools) injection.
    recordEvent({ kind: 'mystery_kind' as unknown as 'turn_start' });
    expect(readEvents()).toHaveLength(0);
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

  // #17: sessionId now comes from crypto.randomUUID (in any env that
  // exposes it — every browser + Node ≥ 14.17). Shape check is enough;
  // we don't want to lock the test to a specific format if the platform
  // hands us a longer id.
  it('sessionId uses crypto.randomUUID when available (#17)', () => {
    recordEvent({ kind: 'turn_start' });
    const sessionId = readEvents()[0].sessionId;
    const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    expect(sessionId).toMatch(uuidV4);
  });

  // #17: cross-tab killswitch propagation. Another tab toggles
  // localStorage[KILLSWITCH_KEY] → fires a `storage` event on this tab
  // → cachedDisabled invalidates → next `isTelemetryDisabled()` re-reads.
  it("'storage' event invalidates the killswitch cache (#17)", () => {
    // First call seeds the cache (and registers the listener lazily).
    expect(isTelemetryDisabled()).toBe(false);

    // Another tab writes the killswitch. Same-tab localStorage.setItem
    // does not fire the `storage` event by spec, so we simulate the
    // cross-tab signal explicitly: set the underlying storage and
    // dispatch the event manually.
    localStorage.setItem('basher.telemetry.disabled', 'true');
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'basher.telemetry.disabled',
        newValue: 'true',
        oldValue: null,
        storageArea: localStorage,
      }),
    );

    expect(isTelemetryDisabled()).toBe(true);
  });

  it("'storage' event for unrelated keys does NOT invalidate the cache (#17)", () => {
    // Seed: telemetry currently disabled. Cache is `true`.
    localStorage.setItem('basher.telemetry.disabled', 'true');
    __resetTelemetryCacheForTests();
    expect(isTelemetryDisabled()).toBe(true);

    // Another tab writes an unrelated key. Cache should NOT invalidate.
    // (If it did, the next isTelemetryDisabled() would still report
    // true because we left the underlying value set — but the contract
    // is "no invalidation work for unrelated keys," verified by
    // observing the cache directly via a second flip below.)
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'some.other.key',
        newValue: 'whatever',
        oldValue: null,
        storageArea: localStorage,
      }),
    );

    // Same-tab clear of the killswitch — does NOT fire `storage`, so
    // the cache must still report `true` from its prior seed. Proves
    // the unrelated-key event above didn't invalidate.
    localStorage.removeItem('basher.telemetry.disabled');
    expect(isTelemetryDisabled()).toBe(true);
  });
});
