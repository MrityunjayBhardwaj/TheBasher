// A project saved by an older app, put where a returning user's browser holds it.
//
// #1053 — the clone road's import (`__basher_importGltf`) is gone, so a project saved with a clone
// import can no longer be made in the browser. The specs that load one (the load converter's, #1216
// #1317) read a recording instead: the saved project exactly as `saveCurrent` wrote it, the file it
// imported and where, recorded by the spec's own staging at `capturedAt` (`git show
// <capturedAt>:<by>` shows the gestures). #1274 set the precedent for the characters whose edits used
// the clone road's own tools.
//
// REF: src/app/boot.ts (`saveCurrent`, `getStorage`, `__basher_writeOpfsBytes`);
// src/core/project/io.ts (`projectPath`); issues #1053, #1274, #1391.

import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';

export interface RecordedSave {
  capturedAt: string;
  by: string;
  /** The file under `/assets/` the project imported. */
  file: string;
  /** Where the project reads it from in this browser's storage. */
  ref: string;
  project: { id: string; state: { nodes: Record<string, { type: string }> } };
}

/** The recording `src/core/project/__fixtures__/<name>.json`. */
export const recordedSave = <T extends RecordedSave = RecordedSave>(name: string): T =>
  JSON.parse(readFileSync(`src/core/project/__fixtures__/${name}.json`, 'utf8')) as T;

export const savedTypes = (saved: RecordedSave): string[] =>
  Object.values(saved.project.state.nodes).map((n) => n.type);

/**
 * The recorded project saved in this browser and named as the one to resume, with its file in this
 * browser's storage unless `withFile` is false (cleared site data, another browser). The caller
 * reloads to load it on the resume road.
 */
export async function writeRecordedSave(
  page: Page,
  saved: RecordedSave,
  { withFile = true }: { withFile?: boolean } = {},
): Promise<void> {
  await page.evaluate(
    async ({ file, ref, project, withFile }) => {
      const w = window as unknown as {
        __basher_writeOpfsBytes: (path: string, bytes: Uint8Array) => Promise<void>;
      };
      if (withFile) {
        const buf = await fetch(`/assets/${file}`).then((r) => r.arrayBuffer());
        await w.__basher_writeOpfsBytes(ref, new Uint8Array(buf));
      }
      const boot = await import('/src/app/boot.ts');
      const io = await import('/src/core/project/io.ts');
      // #1391 — written RAW, as the older app that saved it wrote it: `saveProject` validates against
      // the CURRENT format and would refuse a recording from an earlier one before the load could
      // migrate it. The resume load migrates it, as it does for a returning user.
      await (
        await boot.getStorage()
      ).write(
        io.projectPath(project.id),
        new TextEncoder().encode(JSON.stringify(project, null, 2)),
      );
      localStorage.setItem('basher.lastProjectId', project.id);
    },
    { ...saved, withFile },
  );
}
