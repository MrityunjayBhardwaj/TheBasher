// A generated character, driven by generated motion, end to end (#843).
//
// ─────────────────────────────────────────────────────────────────────────
// WHY THIS SPEC EXISTS
// ─────────────────────────────────────────────────────────────────────────
// Every part of this chain already had a test, and the chain was still broken
// for a week. The retarget's OUTPUT was verified — real bind inverses, a travel
// track, correct bind rotations — and all of it was true while the character on
// screen stood still. Verifying a producer is not evidence that anything
// consumes it, so this spec asserts at the CONSUMER: after the whole pipeline
// runs, do the RENDERED bones actually rotate?
//
// What it drives is the road the director drives — `__basher_ingestBvhFile`,
// which is `routeImportByExtension` → `bindImportedMotion` →
// `bindMotionToCharacter`, the same path a dropped file and a generated clip
// both take. Driving the retarget mutator directly would pass while the app
// path refuses, which is exactly the gap #807 and #820 were each filed for.
//
// ─────────────────────────────────────────────────────────────────────────
// THE REGRESSION IT GUARDS
// ─────────────────────────────────────────────────────────────────────────
// `bakeClipOntoRig` wrote the clip's RADIANS into the GltfChild rotation band,
// which is DEGREES, so every bone rotation rendered at π/180 of its size (#843).
// The clip was right, the channels were minted, the bones resolved — and a 40°
// leg swing rendered as 0.7°. The only assertion that could have caught it is
// the one below: a rendered bone must rotate by an amount a person could SEE.
// `MIN_VISIBLE_DEG` is far above the ~0.4° the defect produced and far below the
// ~34° a real walk produces, so it cannot be satisfied by accident.
//
// POSTURE IS ASSERTED TOO (#844). The character used to perform the walk lying
// down — every bone but `Root` received an orientation unrelated to its bind,
// because SkeletonUtils copies the source's world rotation verbatim and the two
// rigs disagree about where a bone points at rest. Head-above-hips is the
// cheapest measurement that tells "walking" from "swimming on the floor": it
// read ~0.000 under the defect and ~0.31 once the rest poses are reconciled.
// A rotation check alone cannot see this — the bones were moving the whole time.
//
// ─────────────────────────────────────────────────────────────────────────
// FIXTURES
// ─────────────────────────────────────────────────────────────────────────
// This runs against the REAL artefacts of the two services — a Tripo-generated
// rigged GLB and a Kimodo SOMA clip. They are untracked (vendor output, licence
// not cleared, and the GLB is ~58 MB), so the spec SKIPS when they are absent
// rather than failing. That means it does not gate CI today; giving it a small
// generated stand-in rig is tracked separately.
//
// REF: src/agent/mutators/builders/bakeClipOntoRig.ts (the units boundary);
//      src/app/asset/bindMotionToCharacter.ts (the bind decisions);
//      src/viewport/SceneFromDAG.tsx (the TRS useFrame — the read site);
//      issues #843, #844, #807, #820.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './_fixtures';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GLB_FILE = path.join(ROOT, 'public/assets/tripo-rigged.glb');
const BVH_FILE = path.join(ROOT, 'public/assets/kimodo-walk.bvh');

const GLB_URL = '/assets/tripo-rigged.glb';
const BVH_URL = '/assets/kimodo-walk.bvh';
const ASSET_REF = 'assets/tripo-rigged.glb';

/** A rotation a person can see. The radians-in-a-degrees-band defect (#843)
 *  produced well under 1°; a real walk swings the legs by 30°+. */
const MIN_VISIBLE_DEG = 15;
/** How many bones must clear it — a walk drives the whole lower body, so a
 *  single moving bone means something is posing one limb and nothing else. */
const MIN_MOVING_BONES = 5;
/** Head-above-hips, in world units, below which the character is not upright.
 *  Measured ~0.000 with the rest poses unreconciled and ~0.31 with them
 *  reconciled, so the bar sits clear of both. */
const MIN_UPRIGHT = 0.15;

interface SkinHandle {
  boneCount: number;
  bound: boolean;
  boneName: (i: number) => string | null;
  boneRotation: (i: number) => [number, number, number] | null;
  vertex: (i: number) => [number, number, number];
}
interface BasherWindow {
  __basher_dag: {
    getState: () => {
      state: { nodes: Record<string, { type: string; params?: Record<string, unknown> }> };
    };
  };
  __basher_writeOpfsBytes?: (path: string, bytes: Uint8Array) => Promise<void>;
  __basher_importGltf?: (buffer: ArrayBuffer, assetRef: string) => Promise<unknown>;
  __basher_ingestBvhFile?: (bytes: Uint8Array, name: string) => Promise<string>;
  __basher_time?: { getState: () => { setTime: (s: number) => void } };
  __basher_gltf_skin?: () => SkinHandle | null;
}

test('a Tripo-rigged character walks on a Kimodo clip', async ({ page }) => {
  if (!fs.existsSync(GLB_FILE) || !fs.existsSync(BVH_FILE)) {
    test.skip(
      true,
      'needs public/assets/tripo-rigged.glb + kimodo-walk.bvh (untracked vendor output)',
    );
    return;
  }
  test.setTimeout(300_000);

  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/');
  await page.waitForFunction(
    () => {
      const w = window as unknown as BasherWindow;
      return Boolean(
        w.__basher_dag &&
        w.__basher_importGltf &&
        w.__basher_writeOpfsBytes &&
        w.__basher_ingestBvhFile &&
        w.__basher_time,
      );
    },
    { timeout: 60_000 },
  );

  // ---- 1. the generated, rigged character --------------------------------
  await page.evaluate(
    async ([url, ref]) => {
      const w = window as unknown as BasherWindow;
      const buf = await (await fetch(url)).arrayBuffer();
      await w.__basher_writeOpfsBytes!(ref, new Uint8Array(buf));
      await w.__basher_importGltf!(buf, ref);
    },
    [GLB_URL, ASSET_REF],
  );
  await page.waitForFunction(
    () => {
      const w = window as unknown as BasherWindow;
      return Boolean(w.__basher_gltf_skin && w.__basher_gltf_skin() !== null);
    },
    { timeout: 120_000 },
  );

  const character = await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const skin = w.__basher_gltf_skin!()!;
    const nodes = w.__basher_dag.getState().state.nodes;
    return {
      boneCount: skin.boneCount,
      bound: skin.bound,
      // #807 — the import mints one rig node per captured skin. Without it the
      // motion has nothing to be retargeted ONTO and the bind refuses.
      rigNodes: Object.values(nodes).filter((n) => n.type === 'GltfSkeleton').length,
    };
  });
  expect(character.bound, 'the imported character must have a bound skin').toBe(true);
  expect(character.boneCount).toBeGreaterThan(20);
  expect(character.rigNodes, 'the import must mint a rig node (#807)').toBeGreaterThan(0);

  // ---- 2. the generated motion, through the app's own bind road -----------
  const bind = await page.evaluate(async (url) => {
    const w = window as unknown as BasherWindow;
    const buf = await (await fetch(url)).arrayBuffer();
    const before = Object.keys(w.__basher_dag.getState().state.nodes);
    await w.__basher_ingestBvhFile!(new Uint8Array(buf), 'kimodo-walk');
    const after = w.__basher_dag.getState().state.nodes;
    const added = Object.keys(after).filter((id) => !before.includes(id));
    return {
      retargetedClips: added.filter((id) => id.includes('_on_')).length,
      // The bake materialises the clip onto the road the renderer reads (#803).
      bakedChannels: added.filter((id) => after[id].type === 'KeyframeChannelVec3').length,
    };
  }, BVH_URL);
  expect(bind.retargetedClips, 'the bind must produce a retargeted clip').toBeGreaterThan(0);
  expect(bind.bakedChannels, 'the bake must mint baked channels (#803)').toBeGreaterThan(0);

  // ---- 3. PLAYBACK — the assertion the whole spec exists for --------------
  const played = await page.evaluate(async () => {
    const w = window as unknown as BasherWindow;
    const times = [0, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0];
    const skin0 = w.__basher_gltf_skin!()!;
    const n = skin0.boneCount;
    const names = Array.from({ length: n }, (_, i) => skin0.boneName(i));
    const frames: number[][][] = [];
    const verts: [number, number, number][] = [];
    for (const t of times) {
      w.__basher_time!.getState().setTime(t);
      // Two rAFs: the TRS useFrame writes on the next frame after the time set.
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const skin = w.__basher_gltf_skin!()!;
      frames.push(Array.from({ length: n }, (_, i) => skin.boneRotation(i) ?? [0, 0, 0]));
      verts.push(skin.vertex(0));
    }
    const spreads = Array.from({ length: n }, (_, i) => {
      let m = 0;
      for (const f of frames)
        for (let a = 0; a < 3; a++) m = Math.max(m, Math.abs(f[i][a] - frames[0][i][a]));
      return { bone: names[i] ?? `#${i}`, deg: (m * 180) / Math.PI };
    }).sort((a, b) => b.deg - a.deg);
    const travel = Math.max(
      ...verts.map((v) => Math.hypot(v[0] - verts[0][0], v[1] - verts[0][1], v[2] - verts[0][2])),
    );
    return { spreads, travel };
  });

  const moving = played.spreads.filter((s) => s.deg > MIN_VISIBLE_DEG);
  const top = played.spreads.slice(0, 5).map((s) => `${s.bone} ${s.deg.toFixed(1)}°`);

  // 🔴 THE #843 GUARD. Under the radians-in-a-degrees-band defect this read
  // 1 bone at 5.6° and everything else under 1°.
  expect(
    moving.length,
    `only ${moving.length} bone(s) rotated more than ${MIN_VISIBLE_DEG}° across the clip — ` +
      `the motion is not reaching the rendered rig at full size (#843). Top: ${top.join(', ')}`,
  ).toBeGreaterThanOrEqual(MIN_MOVING_BONES);

  // #839 — the root travels. A walk that cycles its legs on the spot is the
  // other half of "the motion did not apply".
  expect(played.travel, 'the character must travel (#839)').toBeGreaterThan(0.1);

  // ---- 4. POSTURE — is it walking, or lying down doing the same motion? ---
  const posture = await page.evaluate(async () => {
    const w = window as unknown as BasherWindow & {
      __basher_three?: { getState: () => { scene?: unknown } };
    };
    const scene = w.__basher_three?.getState().scene as
      | { traverse: (f: (o: never) => void) => void }
      | undefined;
    if (!scene) throw new Error('no scene handle — the probe would report a vacuous zero');
    const bones = new Map<string, { matrixWorld: { elements: number[] } }>();
    scene.traverse((o: never) => {
      const obj = o as unknown as {
        name: string;
        isBone?: boolean;
        matrixWorld: { elements: number[] };
      };
      if (obj.isBone) bones.set(obj.name, obj);
    });
    const y = (n: string) => bones.get(n)?.matrixWorld.elements[13] ?? NaN;
    const rows: number[] = [];
    for (const t of [0, 0.5, 1.0, 1.5, 2.0]) {
      w.__basher_time!.getState().setTime(t);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      rows.push(y('mixamorigHead') - y('mixamorigHips'));
    }
    return rows;
  });
  const worstPosture = Math.min(...posture);
  expect(
    worstPosture,
    `the head dropped to ${worstPosture.toFixed(3)} above the hips — the character is ` +
      `performing the motion lying down (#844). Samples: ${posture.map((v) => v.toFixed(3)).join(', ')}`,
  ).toBeGreaterThan(MIN_UPRIGHT);

  expect(errors, `page errors during playback: ${errors.join(' | ')}`).toEqual([]);
});
