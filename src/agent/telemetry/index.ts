// Telemetry barrel.

export type { TelemetryEvent, TelemetryEventKind } from './types';
export {
  recordEvent,
  readEvents,
  clearEvents,
  isTelemetryDisabled,
  __resetTelemetryCacheForTests,
} from './recorder';
