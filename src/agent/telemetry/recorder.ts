// Telemetry recorder — opt-in, no-PII, killswitch-respecting.
//
// Default behavior: write to localStorage under 'basher.telemetry.events'.
// Optional remote: set VITE_BASHER_TELEMETRY_URL at build time. Absent
// → recorder never makes network calls.
//
// Killswitch (either disables):
//   - import.meta.env.DISABLE_BASHER_TELEMETRY === 'true'
//   - localStorage['basher.telemetry.disabled'] === 'true'
//
// Privacy lint: this file MUST NOT call JSON.stringify on tool args, op
// payloads, DAG state, prompts, or anything else carrying user content.
// The only string value the recorder ever serializes is `toolName` from
// the registered tool catalogue (a constant set: dag.inspect, dag.exec,
// agent.identify, mutator.rotate, …) — no PII surface.
//
// REF: P2.5.2 PLAN §5 Wave D step 9; vyapti V15.

import type { TelemetryEvent } from './types';

const STORAGE_KEY = 'basher.telemetry.events';
const KILLSWITCH_KEY = 'basher.telemetry.disabled';
const MAX_EVENTS_PER_BUCKET = 500;

/**
 * Allowlist of tool names the recorder is willing to log. Any name not
 * on this list is dropped silently — defense against future tools that
 * forget to declare themselves and might leak through.
 */
const TOOL_ALLOWLIST = new Set<string>([
  'dag.inspect',
  'dag.exec',
  'mesh.add',
  'character.walkTo',
  'camera.snapshot',
  'library.import',
  'agent.identify',
  'agent.listMutators',
  'agent.proposePlan',
  'agent.listStrategies',
  'agent.getStrategy',
  'mutator.rotate',
  'mutator.translate',
  'mutator.scale',
  'mutator.setMaterialColor',
  'mutator.duplicate',
  'mutator.deleteNode',
]);

/**
 * Runtime allowlist for event kinds (#21 defense-in-depth). The
 * TelemetryEventKind type guards compile-time callers, but the
 * recorder takes an external-shaped event and a typo / accidental
 * downstream pass-through that adds a new kind without updating the
 * recorder would slip into localStorage silently. Reject unknown
 * kinds at runtime so any new kind has to walk through this list.
 */
const VALID_EVENT_KINDS = new Set<string>([
  'tool_call',
  'turn_start',
  'turn_end',
  'diff_accept',
  'diff_reject',
]);

let cachedSessionId: string | null = null;
let cachedDisabled: boolean | null = null;
let storageListenerRegistered = false;

/**
 * Reset the cached killswitch decision. Call from test setup so changes
 * to localStorage / env are reflected.
 *
 * `storageListenerRegistered` is intentionally NOT reset — the
 * `addEventListener` call is guarded by this flag to prevent duplicate
 * listeners stacking up across test cycles. Production code reaches the
 * listener exactly once per page load.
 */
export function __resetTelemetryCacheForTests(): void {
  cachedSessionId = null;
  cachedDisabled = null;
}

/**
 * Lazily attach a single `'storage'` listener that invalidates the
 * killswitch cache when another tab/window toggles
 * `localStorage[KILLSWITCH_KEY]`. The `'storage'` event only fires for
 * cross-tab changes (browsers do not dispatch it for same-tab writes),
 * which matches user intent: a user disabling telemetry in one tab
 * expects every other open tab to honor it without a reload.
 */
function ensureStorageListener(): void {
  if (storageListenerRegistered) return;
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  window.addEventListener('storage', (event: StorageEvent) => {
    // `event.key === null` is the localStorage.clear() signal.
    if (event.key === null || event.key === KILLSWITCH_KEY) {
      cachedDisabled = null;
    }
  });
  storageListenerRegistered = true;
}

function getEnvFlag(): boolean {
  // Vite exposes import.meta.env at build time. In Node test contexts
  // (vitest with happy-dom + jsdom) import.meta.env is also available.
  // Wrap in a try so non-Vite environments don't blow up.
  try {
    const env = (import.meta as unknown as { env?: Record<string, string | boolean> }).env;
    if (env && env.DISABLE_BASHER_TELEMETRY === 'true') return true;
  } catch {
    /* env unavailable */
  }
  return false;
}

function getLocalStorageFlag(): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    return localStorage.getItem(KILLSWITCH_KEY) === 'true';
  } catch {
    return false;
  }
}

export function isTelemetryDisabled(): boolean {
  ensureStorageListener();
  if (cachedDisabled !== null) return cachedDisabled;
  cachedDisabled = getEnvFlag() || getLocalStorageFlag();
  return cachedDisabled;
}

function getSessionId(): string {
  if (cachedSessionId) return cachedSessionId;
  // crypto.randomUUID is allowed here. The `pure: true` lint rule that
  // forbids it (eslint.config) is scoped to `src/nodes/**` evaluators
  // (V2 determinism — node outputs must be a function of params+inputs).
  // The telemetry recorder is in `src/agent/`, outside that scope; a
  // session id is *inherently* non-deterministic (it identifies one
  // runtime), so a crypto-strong source is the right choice.
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof cryptoApi?.randomUUID === 'function') {
    cachedSessionId = cryptoApi.randomUUID();
  } else {
    // Pre-Node-20 / non-secure-context fallback. Still session-scoped,
    // still no-PII — just lower entropy than the primary path.
    cachedSessionId = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  }
  return cachedSessionId;
}

/**
 * Record a telemetry event. No-ops when:
 *   - the killswitch is set
 *   - kind is 'tool_call' AND toolName is not in the allowlist
 *
 * Persistence: appends to localStorage under STORAGE_KEY (capped at
 * MAX_EVENTS_PER_BUCKET — older events drop). Remote dispatch happens
 * only when VITE_BASHER_TELEMETRY_URL is set.
 */
export function recordEvent(event: Omit<TelemetryEvent, 'timestamp' | 'sessionId'>): void {
  if (isTelemetryDisabled()) return;
  // #21 — kind allowlist runs first: a typo / unknown kind drops
  // before the tool_call branch can leak a half-shaped event into
  // localStorage. The type system already enforces the union at
  // compile time; this is the runtime mirror for external callers
  // (recorder is imported from `src/agent/*`, no plumbing layer).
  if (!VALID_EVENT_KINDS.has(event.kind)) return;
  if (event.kind === 'tool_call' && event.toolName && !TOOL_ALLOWLIST.has(event.toolName)) {
    return;
  }

  const enriched: TelemetryEvent = {
    ...event,
    timestamp: Date.now(),
    sessionId: getSessionId(),
  };

  appendToLocalStorage(enriched);
  // Remote dispatch is intentionally not implemented for v0.5 — flips
  // on at the same time the env var is documented + reviewed. Keeping
  // the recorder local-only by default eliminates the exfiltration
  // attack surface (PLAN R16).
}

function appendToLocalStorage(event: TelemetryEvent): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const events: TelemetryEvent[] = raw ? (JSON.parse(raw) as TelemetryEvent[]) : [];
    events.push(event);
    if (events.length > MAX_EVENTS_PER_BUCKET) {
      events.splice(0, events.length - MAX_EVENTS_PER_BUCKET);
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(events));
  } catch {
    // localStorage may be unavailable (privacy mode, quota) — non-fatal.
  }
}

/** Read all stored events. Returns [] when telemetry is disabled. */
export function readEvents(): TelemetryEvent[] {
  if (isTelemetryDisabled()) return [];
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as TelemetryEvent[]) : [];
  } catch {
    return [];
  }
}

/** Erase the localStorage event log. */
export function clearEvents(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* non-fatal */
  }
}
