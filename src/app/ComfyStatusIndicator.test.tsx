// ComfyStatusIndicator — unit tests for the pure helpers (probeOnce +
// bootReadState). The React shell is exercised by Playwright e2e —
// this project has no React Testing Library and W2 acceptance gate #15
// forbids new external deps, so we test the state machine directly.
//
// REF: docs/UI-SPEC.md §5.10, §11 #12 (D-UX-13).

import { describe, expect, it, vi } from 'vitest';
import type { ComfyUICapability } from '../core/comfy';
import {
  bootReadState,
  probeOnce,
  type IndicatorState,
} from './ComfyStatusIndicator';

function makeCap(opts: {
  kind: 'http' | 'stub';
  isAvailable?: () => Promise<boolean>;
}): ComfyUICapability {
  return {
    id: opts.kind === 'http' ? 'http:test' : 'stub:test',
    kind: opts.kind,
    isAvailable: opts.isAvailable ?? (async () => opts.kind === 'http'),
    submit: async () => {
      throw new Error('not used in test');
    },
    cancel: async () => {
      throw new Error('not used in test');
    },
  };
}

describe('bootReadState', () => {
  it('maps http capability → http indicator state', () => {
    expect(bootReadState(makeCap({ kind: 'http' }))).toBe('http');
  });

  it('maps stub capability → stub indicator state', () => {
    expect(bootReadState(makeCap({ kind: 'stub' }))).toBe('stub');
  });
});

describe('probeOnce', () => {
  it('emits "probing" before the in-flight probe resolves', async () => {
    const emit = vi.fn();
    const cap = makeCap({
      kind: 'http',
      isAvailable: () => new Promise((r) => setTimeout(() => r(true), 0)),
    });
    const p = probeOnce(cap, emit);
    // Emit fired synchronously with 'probing' before isAvailable resolves.
    expect(emit).toHaveBeenNthCalledWith(1, 'probing');
    await p;
    expect(emit).toHaveBeenNthCalledWith(2, 'http');
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('resolves to http when isAvailable returns true', async () => {
    const emit = vi.fn();
    await probeOnce(
      makeCap({ kind: 'http', isAvailable: async () => true }),
      emit,
    );
    const states = emit.mock.calls.map((c) => c[0] as IndicatorState);
    expect(states).toEqual(['probing', 'http']);
  });

  it('resolves to stub when isAvailable returns false', async () => {
    const emit = vi.fn();
    await probeOnce(
      makeCap({ kind: 'http', isAvailable: async () => false }),
      emit,
    );
    const states = emit.mock.calls.map((c) => c[0] as IndicatorState);
    expect(states).toEqual(['probing', 'stub']);
  });

  it('falls back to stub when isAvailable throws', async () => {
    const emit = vi.fn();
    await probeOnce(
      makeCap({
        kind: 'http',
        isAvailable: async () => {
          throw new Error('network down');
        },
      }),
      emit,
    );
    const states = emit.mock.calls.map((c) => c[0] as IndicatorState);
    expect(states).toEqual(['probing', 'stub']);
  });
});
