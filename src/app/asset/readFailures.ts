// Read failures — ONE place a cached "this file could not be read" is forgotten (#1312).
//
// Three suspense loaders (baked geometry, baked textures, environment HDRIs) cache a failed read,
// so a missing file does not suspend forever, and draw a stand-in for it (#1048 #1308 #1309). Each
// cached failure answers only for the file it read. It is forgotten when:
//   - that path is written again (`onStorageWrite`), because the file is back. The stores are
//     content-addressed, so re-importing the same bytes or baking identical content lands on the
//     same path, and without this the NEW work drew the old failure until a reload (measured);
//   - the loader finds the key now reads a different path (a project image under another open
//     project). Only the texture loader has such keys; it checks this itself (`failedPathCache`).
//
// Forgetting has to re-render what drew the stand-in, and nothing else changed for those
// components, so the loader hooks subscribe to `useReadFailureEpoch`. The epoch moves only when a
// failed path is written again, so the hooks cost nothing otherwise.
//
// REF: src/core/storage/writeNotice.ts (the write signal); src/app/asset/bakedGeometryLoader.ts,
//      bakedTextureLoader.ts, environmentTextureLoader.ts (the three callers); issue #1312.

import { useSyncExternalStore } from 'react';
import { onStorageWrite } from '../../core/storage';

const forgettersByPath = new Map<string, Set<() => void>>();
const subscribers = new Set<() => void>();
let epoch = 0;

/**
 * Record that a read of `path` failed. `forget` drops the loader's cached failure (and its banner
 * row) and runs once, when the path is written again.
 */
export function rememberFailedRead(path: string, forget: () => void): void {
  let set = forgettersByPath.get(path);
  if (!set) {
    set = new Set();
    forgettersByPath.set(path, set);
  }
  set.add(forget);
}

/** A write landed at `path`: every failure cached for it is forgotten, and the hooks re-render. */
export function forgetFailedReads(path: string): void {
  const set = forgettersByPath.get(path);
  if (!set) return;
  forgettersByPath.delete(path);
  for (const forget of set) forget();
  epoch++;
  for (const notify of [...subscribers]) notify();
}

onStorageWrite(forgetFailedReads);

function subscribe(notify: () => void): () => void {
  subscribers.add(notify);
  return () => subscribers.delete(notify);
}

function currentEpoch(): number {
  return epoch;
}

/** Re-render the calling loader hook whenever a failed read is forgotten. */
export function useReadFailureEpoch(): number {
  return useSyncExternalStore(subscribe, currentEpoch);
}

/** Test-only — drop every recorded failure. */
export function __resetReadFailuresForTests(): void {
  forgettersByPath.clear();
}
