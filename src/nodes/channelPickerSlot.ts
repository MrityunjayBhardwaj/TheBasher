// channelPickerSlot — where a keyframe channel's or a ParamDriver's `target`/`paramPath` pickers
// are looked up (#1066).
//
// The pickers answer from the measured census and the ComfyUI compile, both of which live in
// `src/app` and reach `boot.ts`, and `boot.ts` registers every node — including the channel
// whose schema would import them. A static import from the schema closes that loop: loading a
// channel node started loading the registry, which read `Action.ts`'s channel schemas before
// they existed (measured: `createActionMutator.spec.parse` threw inside zod). So the schema
// asks this slot, and `src/app/channelPickers.ts` fills it when the app composes itself —
// the same shape as the evaluator's `__setEvalPerfHook`.
//
// 🔴 FAILS CLOSED. Until something installs the pickers, both fields show read-only with the
// reason below — never an empty list, which would read as "nothing animates here".

import type { DagState } from '../core/dag/state';
import type { ParamOption } from './paramWidget';

export type PickedChannelKind = 'number' | 'vec3' | 'quat' | 'color' | 'text';

export interface ChannelPickers {
  targetOptions(state: DagState, channelId: string, kind: PickedChannelKind): ParamOption[];
  pathOptions(state: DagState, channelId: string, kind: PickedChannelKind): ParamOption[];
  pathLock(state: DagState, channelId: string, kind: PickedChannelKind): string | null;
  /** A ParamDriver's pickers: its kind comes from its bound source, not from its type. */
  driverTargetOptions(state: DagState, driverId: string): ParamOption[];
  driverPathOptions(state: DagState, driverId: string): ParamOption[];
  driverPathLock(state: DagState, driverId: string): string | null;
}

export const PICKERS_NOT_INSTALLED =
  'the channel pickers are not installed (src/app/channelPickers.ts was not loaded)';

let installed: ChannelPickers | null = null;

/** Fill the slot. Called once by `src/app/channelPickers.ts` at load. */
export function installChannelPickers(pickers: ChannelPickers | null): void {
  installed = pickers;
}

export const channelTargetOptionsOf =
  (kind: PickedChannelKind) =>
  (state: DagState, channelId: string): ParamOption[] =>
    installed ? installed.targetOptions(state, channelId, kind) : [];

export const channelTargetLockOf = () => (): string | null =>
  installed ? null : PICKERS_NOT_INSTALLED;

export const channelPathOptionsOf =
  (kind: PickedChannelKind) =>
  (state: DagState, channelId: string): ParamOption[] =>
    installed ? installed.pathOptions(state, channelId, kind) : [];

export const channelPathLockOf =
  (kind: PickedChannelKind) =>
  (state: DagState, channelId: string): string | null =>
    installed ? installed.pathLock(state, channelId, kind) : PICKERS_NOT_INSTALLED;

export const driverTargetOptionsOf =
  () =>
  (state: DagState, driverId: string): ParamOption[] =>
    installed ? installed.driverTargetOptions(state, driverId) : [];

export const driverPathOptionsOf =
  () =>
  (state: DagState, driverId: string): ParamOption[] =>
    installed ? installed.driverPathOptions(state, driverId) : [];

export const driverPathLockOf =
  () =>
  (state: DagState, driverId: string): string | null =>
    installed ? installed.driverPathLock(state, driverId) : PICKERS_NOT_INSTALLED;
