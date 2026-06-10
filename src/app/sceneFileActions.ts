// Scene-file UI affordances — File ▸ Open Scene… and File ▸ Save As (.basher)….
// The download + file-picker glue between the MenuBar and the boot orchestrators
// (buildSceneBundleForCurrent / importSceneBundle), kept out of boot.ts so the
// DOM-touching code (Blob download, hidden <input>) stays in the app layer next
// to its sibling openGltfFilePicker.
//
// Failures + incomplete exports route to useAssetErrorStore (V38 — no silent
// no-op), the same merged feedback surface the import pickers use.
//
// REF: asset/importPicker.ts (openGltfFilePicker — the picker pattern mirrored
//      here); boot.ts buildSceneBundleForCurrent/importSceneBundle; exportDag.ts
//      (the legacy DAG-only download this supersedes for sharing); vyapti V38.

import { buildSceneBundleForCurrent, importSceneBundle } from './boot';
import { SCENE_BUNDLE_EXTENSION, SceneBundleSchema } from './sceneBundle';
import { useAssetErrorStore, formatAssetError } from './stores/assetErrorStore';

/** Sanitize a project name into a download filename stem. */
function fileStem(name: string): string {
  return name.replace(/\s+/g, '-').toLowerCase() || 'scene';
}

/**
 * Build a self-contained `.basher` bundle of the current scene and download it.
 * Surfaces a warning if any referenced asset could not be embedded (the file is
 * then not fully portable — V38, never a silent partial export).
 */
export async function downloadSceneBundle(): Promise<void> {
  try {
    const { bundle, missingAssets } = await buildSceneBundleForCurrent();
    const json = JSON.stringify(bundle);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${fileStem(bundle.name)}${SCENE_BUNDLE_EXTENSION}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);

    if (missingAssets.length > 0) {
      useAssetErrorStore
        .getState()
        .report(
          'scene-export',
          `Saved without ${missingAssets.length} missing asset(s): the file may not open fully on another machine.`,
        );
    }
  } catch (err) {
    useAssetErrorStore.getState().report('scene-export', formatAssetError(err));
  }
}

/**
 * Open a plain FILE picker for `.basher` scene files and open the chosen file as
 * a NEW project (non-destructive). Accepts the native `.basher` and the legacy
 * `.basher.json` / `.json` DAG-only exports. Mirrors openGltfFilePicker's hidden
 * single-file <input> pattern. A parse/validation/IO failure surfaces via
 * useAssetErrorStore rather than throwing into the void (V38).
 */
export function openSceneFilePicker(): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = `${SCENE_BUNDLE_EXTENSION},.basher.json,.json,application/json`;
  input.style.display = 'none';
  document.body.appendChild(input);
  input.onchange = () => {
    void (async () => {
      try {
        const file = input.files?.[0];
        if (!file) return;
        const text = await file.text();
        let raw: unknown;
        try {
          raw = JSON.parse(text);
        } catch {
          throw new Error(`${file.name} is not a valid Basher scene file (corrupt JSON).`);
        }
        const bundle = SceneBundleSchema.parse(raw);
        await importSceneBundle(bundle);
      } catch (err) {
        useAssetErrorStore.getState().report('scene-open', formatAssetError(err));
      } finally {
        input.remove();
      }
    })();
  };
  input.click();
}
