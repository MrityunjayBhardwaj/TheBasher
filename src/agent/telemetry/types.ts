// Telemetry event types.
//
// PRIVACY POSTURE (P2.5.2 PLAN §5 Wave D step 9):
//   - tool name + outcome + duration ONLY.
//   - NO prompt text, NO DAG content, NO node ids, NO user input.
//   - sessionId is a random uuid generated per browser tab — opaque.
//
// Killswitch:
//   - DISABLE_BASHER_TELEMETRY=true (env)
//   - localStorage['basher.telemetry.disabled'] = 'true'
// Either disables the recorder. Default behaviour: write to localStorage
// only; remote endpoint requires explicit VITE_BASHER_TELEMETRY_URL.

export type TelemetryEventKind =
  | 'tool_call'
  | 'turn_start'
  | 'turn_end'
  | 'diff_accept'
  | 'diff_reject';

export interface TelemetryEvent {
  kind: TelemetryEventKind;
  /** Tool name for `tool_call` events. Absent for turn/diff events. */
  toolName?: string;
  /** Outcome flag — present on tool_call + diff events. */
  success?: boolean;
  /** Wall-clock duration in milliseconds. Absent for instant events. */
  durationMs?: number;
  /** Unix milliseconds. */
  timestamp: number;
  /** Random per-tab session id — opaque, no user info. */
  sessionId: string;
}
