// BoxSelect (#226) — the in-Canvas half of viewport box-select. It owns the world
// → screen PROJECTION (needs the live camera + canvas size from useThree) and the
// COMMIT (resolve each selectable node's world origin, hit-test against the
// marquee, apply the selection). It registers `commit` on the boxSelectStore so the
// DOM overlay (BoxSelectOverlay, in Viewport) can drive it across the Canvas
// boundary. Renders nothing.
//
// Discipline: lives in src/viewport/ but writes only through useSelectionStore (a
// UI projection, not the DAG) — the same V1/V8 contract selectNodeOnClick keeps.
// Reads world origins via the pure resolveWorldTransform (one band, H40 / V37) so a
// box-select hits an object exactly where it RENDERS — plus the Follow-Path position
// band ON TOP (#342), because the pure walk is TRS-only and a follower renders where
// its path puts it, not where it was authored.

import { useThree } from '@react-three/fiber';
import { useEffect } from 'react';
import * as THREE from 'three';
import { useDagStore } from '../core/dag/store';
import { useTimeStore } from '../app/stores/timeStore';
import { useSelectionStore } from '../app/stores/selectionStore';
import { useBoxSelectStore } from '../app/stores/boxSelectStore';
import { resolveWorldTransform } from '../app/resolveWorldTransform';
import { resolveFollowedWorldPosition } from '../app/nodeConstraints';
import { getViewportSelectableIds } from '../app/selectableNodes';
import { boxSelectHits, type BoxCandidate, type PixelRect, type ScreenPoint } from './boxSelect';

export function BoxSelect() {
  const camera = useThree((s) => s.camera);
  const width = useThree((s) => s.size.width);
  const height = useThree((s) => s.size.height);

  useEffect(() => {
    // World point → canvas-relative CSS px. NDC.z>1 ⇒ behind the camera ⇒ not a hit.
    const project = (world: [number, number, number]): ScreenPoint => {
      const v = new THREE.Vector3(world[0], world[1], world[2]).project(camera);
      return {
        x: (v.x * 0.5 + 0.5) * width,
        y: (1 - (v.y * 0.5 + 0.5)) * height,
        visible: v.z <= 1,
      };
    };

    const commit = (rect: PixelRect, additive: boolean) => {
      const state = useDagStore.getState().state;
      const t = useTimeStore.getState();
      const ctx = { time: { frame: t.frame, seconds: t.seconds, normalized: t.normalized } };
      const candidates: BoxCandidate[] = [];
      for (const id of getViewportSelectableIds(state)) {
        const wt = resolveWorldTransform(state, id, ctx);
        if (!wt) continue;
        // A Follow-Path moves an object's ORIGIN, and resolveWorldTransform is pure TRS —
        // it deliberately applies no constraint band, because that purity is what the band's
        // own inputs read. So a follower must be boxed at its FOLLOWED world point (what the
        // renderer draws) rather than its authored one; unfollowed objects keep the pure
        // origin byte-for-byte. Reading the band ON TOP of the pure walk (never folded INTO
        // it) is the same split the renderer uses — and is why this can't cycle. #342.
        const followed = resolveFollowedWorldPosition(state, id, ctx);
        candidates.push({ id, world: followed ?? wt.position });
      }
      const hits = boxSelectHits(candidates, rect, project);
      const sel = useSelectionStore.getState();
      if (additive) {
        // Shift-box ADDS to the existing set (Blender shift-box never toggles).
        // selectMany makes the last id active — keep newly-added hits last.
        const next = [...sel.selectedNodeIds].filter((id) => !hits.includes(id));
        sel.selectMany([...next, ...hits]);
      } else {
        // Replace-mode: an empty marquee clears (Blender box-on-nothing deselects).
        sel.selectMany(hits);
      }
    };

    useBoxSelectStore.getState().setCommit(commit);

    if (import.meta.env.DEV) {
      const w = window as unknown as Record<string, unknown>;
      // Test-observation seam — run the REAL projection + hit-test + select for a
      // canvas-relative px rect, bypassing the pointer drag (deterministic e2e).
      w.__basher_box_select = (x0: number, y0: number, x1: number, y1: number, additive = false) =>
        commit({ x0, y0, x1, y1 }, additive);
      // Side-A projection readout for the boundary-pair assertion.
      w.__basher_box_select_project = (world: [number, number, number]) => project(world);
    }

    return () => {
      useBoxSelectStore.getState().setCommit(null);
      if (import.meta.env.DEV) {
        const w = window as unknown as Record<string, unknown>;
        delete w.__basher_box_select;
        delete w.__basher_box_select_project;
      }
    };
  }, [camera, width, height]);

  return null;
}
