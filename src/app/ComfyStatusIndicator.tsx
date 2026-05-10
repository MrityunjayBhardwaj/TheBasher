// ComfyStatusIndicator — small "is the AI render bridge live?" badge per
// UI-SPEC §5.10 + D-UX-13. Lives on R1 ProjectTabs's right edge once
// ProjectTabs lands (W3); for W2 it mounts in Chrome's right cluster as
// a temporary home.
//
// State machine:
//   - 'http'    — capability kind === 'http'        → green
//   - 'stub'    — capability kind === 'stub'        → gray
//   - 'probing' — a probe is in-flight              → yellow
//
// Probe rules (D-UX-13):
//   1. Boot read — at mount, resolve the cached capability via
//      getComfyCapability(); kind tells you the initial state. NO HTTP
//      probe at boot — pickComfyUI already did one during boot's resolve.
//   2. 30s probe — only when mode === 'run'. The timer is torn down when
//      the user leaves run mode so non-rendering sessions don't burn HTTP
//      requests on a sleeping ComfyUI server.
//   3. Hover probe — pointer-enter triggers an immediate isAvailable()
//      check regardless of mode. Lets the user demand a fresh status
//      without leaving their current mode.
//
// "Never constant polling" (§11 #12): the only timer in this component is
// the run-mode interval, which auto-clears on mode change. There is no
// mount-time interval.
//
// Test seam: deps.getCapability is optional and defaults to the boot
// helper. Tests inject a stub capability so vitest doesn't need a live
// ComfyUI server or a real boot sequence.
//
// V8 file-rooted: src/app/. Reads useModeStore, calls a capability
// surface (V6). No DAG mutation. Capability calls are read-only.
//
// REF: docs/UI-SPEC.md §5.10, §11 #12 (D-UX-13); THESIS.md §28, §44;
// project_p5_context D-07.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ComfyUICapability } from '../core/comfy';
import { getComfyCapability } from './boot';
import { useModeStore } from './stores/modeStore';

export const PROBE_INTERVAL_MS = 30_000;

export type IndicatorState = 'http' | 'stub' | 'probing';

/**
 * Run a single probe against the capability and report the resulting
 * state. Pure with respect to side effects — emits intermediate
 * 'probing' before resolving to 'http' or 'stub'. Extracted for unit
 * testing (the React component composes this with its own setState).
 *
 * This is the ground-truth state-machine for D-UX-13: the React shell
 * just feeds emit() into setState. Everything testable about probe
 * semantics lives here, free of React rendering.
 */
export async function probeOnce(
  cap: ComfyUICapability,
  emit: (s: IndicatorState) => void,
): Promise<void> {
  emit('probing');
  try {
    const ok = await cap.isAvailable();
    emit(ok ? 'http' : 'stub');
  } catch {
    emit('stub');
  }
}

/** Map a freshly-resolved capability to its boot-read state. */
export function bootReadState(cap: ComfyUICapability): IndicatorState {
  return cap.kind === 'http' ? 'http' : 'stub';
}

interface ComfyStatusIndicatorDeps {
  /** Test seam — inject a fixed capability instead of hitting the boot cache. */
  readonly getCapability?: () => Promise<ComfyUICapability>;
  /** Test seam — substitute setInterval (vitest fake timers). */
  readonly intervalMs?: number;
}

function stateLabel(s: IndicatorState): string {
  switch (s) {
    case 'http':
      return 'live';
    case 'stub':
      return 'stub';
    case 'probing':
      return 'probing';
  }
}

function stateClass(s: IndicatorState): string {
  switch (s) {
    case 'http':
      return 'bg-accent text-bg';
    case 'stub':
      return 'bg-bg-1 text-fg-mute';
    case 'probing':
      return 'bg-warn/30 text-warn';
  }
}

export function ComfyStatusIndicator({
  getCapability = getComfyCapability,
  intervalMs = PROBE_INTERVAL_MS,
}: ComfyStatusIndicatorDeps = {}): ReactNode {
  const mode = useModeStore((s) => s.mode);
  const [state, setState] = useState<IndicatorState>('stub');
  const capRef = useRef<ComfyUICapability | null>(null);

  // Boot read: resolve the cached capability and seed initial state from
  // its kind. No HTTP request from this effect — pickComfyUI's probe
  // happened in boot.ts already, and its result is cached there.
  useEffect(() => {
    let cancelled = false;
    getCapability()
      .then((cap) => {
        if (cancelled) return;
        capRef.current = cap;
        setState(bootReadState(cap));
      })
      .catch(() => {
        // Capability resolve itself failed (boot misconfigured) — fall
        // back to stub so the indicator at least renders something.
        if (!cancelled) setState('stub');
      });
    return () => {
      cancelled = true;
    };
  }, [getCapability]);

  // Single probe — used by the 30s interval AND by hover. probeOnce
  // emits 'probing' immediately so the user sees the badge flash
  // yellow, then resolves to http/stub.
  const probe = useCallback(async () => {
    const cap = capRef.current;
    if (!cap) return;
    await probeOnce(cap, setState);
  }, []);

  // Run-mode interval (D-UX-13). Mount and tear down with mode changes so
  // we never poll outside run mode.
  useEffect(() => {
    if (mode !== 'run') return;
    const id = setInterval(() => {
      void probe();
    }, intervalMs);
    return () => clearInterval(id);
  }, [mode, intervalMs, probe]);

  return (
    <button
      type="button"
      onMouseEnter={() => {
        void probe();
      }}
      data-testid="comfy-status-indicator"
      data-state={state}
      title={`ComfyUI: ${stateLabel(state)} (hover to refresh)`}
      className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wide ${stateClass(state)}`}
    >
      <span aria-hidden>●</span>
      <span>{stateLabel(state)}</span>
    </button>
  );
}
