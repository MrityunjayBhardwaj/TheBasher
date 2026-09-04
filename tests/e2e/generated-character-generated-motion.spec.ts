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
// The bind road wrote the clip's RADIANS into the GltfChild rotation band, which
// is DEGREES, so every bone rotation rendered at π/180 of its size (#843). The
// clip was right, the channels were minted, the bones resolved — and a 40° leg
// swing rendered as 0.7°. (The conversion lived in `bakeClipOntoRig` then; #889
// deleted that eager bake, and the same boundary is now crossed in two places —
// the read band for an unedited bone, the mint for an edited one — so this
// assertion covers strictly more than it did.) The only assertion that could have caught it is
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
// REF: src/app/bakedGltfChannels.ts + src/app/animate/ensureChannelForBone.ts
//        (the two sides of the units boundary);
//      src/app/asset/bindMotionToCharacter.ts (the bind decisions);
//      src/viewport/SceneFromDAG.tsx (the TRS useFrame — the read site);
//      issues #843, #844, #807, #820.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';
import { parseBvh, BVH_UNIT_SCALE_CENTIMETRES } from '../../src/core/import/bvh';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * The character/clip pairs this runs against.
 *
 * TRACKED FIRST, AND IT IS THE POINT OF #850. This spec used to run only
 * against real vendor output — a ~58 MB Tripo GLB whose licence is not cleared
 * and which is therefore untracked — so on a runner the files were absent, the
 * spec SKIPPED, and every gate written for this seam was local-only. A gate
 * that cannot run is not a gate. The generated stand-in pair carries the same
 * structure in 10 KB: `mixamorig:` colon names, a non-identity corrective root,
 * a T-pose bind, unequal legs, and a hip offset that is NOT the leg chain.
 *
 * The vendor pair still runs when it happens to be present, because a stand-in
 * is a claim about what matters and the real asset is the thing itself. It is
 * additive: absent, nothing is lost that CI ever had.
 */
const PAIRS = [
  {
    name: 'a generated stand-in rig on a generated SOMA walk',
    glb: 'public/fixtures/rig/standin-character.glb',
    bvh: 'public/fixtures/anim/soma-walk.bvh',
    ref: 'fixtures/rig/standin-character.glb',
    // The clip is 31 frames at 30 fps — sampling past its end would measure the
    // held last pose as if it were motion.
    times: [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1.0],
    // SOMA's thigh is `LeftLeg` and its shin `LeftShin`; a bone's offset is the
    // length of the bone ABOVE it, so thigh is measured at the knee.
    sourceLegBones: ['LeftShin', 'LeftFoot', 'RightShin', 'RightFoot'],
    tracked: true,
  },
  {
    name: 'a Tripo-rigged character on a Kimodo clip',
    glb: 'public/assets/tripo-rigged.glb',
    bvh: 'public/assets/kimodo-walk.bvh',
    ref: 'assets/tripo-rigged.glb',
    times: [0, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0],
    sourceLegBones: ['LeftShin', 'LeftFoot', 'RightShin', 'RightFoot'],
    tracked: false,
  },
] as const;

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
/** How far below horizontal the upper arm must hang, in degrees.
 *  A walking figure carries its arms down the sides. Sampling the source at its
 *  A-pose and the target at its T-pose bind left them halfway out (#845):
 *  measured 21-42° on the live pair, and 67-76° once the two rigs are aligned by
 *  rest DIRECTION instead of by two different poses. The bar sits between. */
const MIN_ARM_HANG_DEG = 50;
/** How far the character's stride may drift from the clip's, each measured
 *  against its OWN legs. The retarget scale is the only thing that sets this,
 *  and it read 13% low while every other assertion here stayed green (#846). */
const MAX_STRIDE_DRIFT = 0.03;
/** How far a LEAF joint — the neck-head, a wrist, an ankle-toe — may sit from
 *  the target's own bind bend, in degrees, at its closest sample.
 *  Direction alignment pins two of three rotational degrees of freedom, and a
 *  bone with no mapped child has none of them pinned: it used to inherit its
 *  parent's correction, computed for a bone pointing somewhere else (#853).
 *  Measured before: the live head never came closer than 39° and the stand-in's
 *  left toe sat at a flat 180°. After: 1.4° and 0.0°. The bar sits between. */
const MAX_LEAF_JOINT_DEG = 12;

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

for (const pair of PAIRS) {
  runPair(pair);
}

function runPair(pair: (typeof PAIRS)[number]): void {
  test(`${pair.name} walks`, async ({ page }) => {
    await walks(page, pair);
  });
}

async function walks(page: Page, pair: (typeof PAIRS)[number]): Promise<void> {
  const GLB_FILE = path.join(ROOT, pair.glb);
  const BVH_FILE = path.join(ROOT, pair.bvh);
  const GLB_URL = `/${pair.glb.replace(/^public\//, '')}`;
  const BVH_URL = `/${pair.bvh.replace(/^public\//, '')}`;
  const ASSET_REF = pair.ref;

  if (!fs.existsSync(GLB_FILE) || !fs.existsSync(BVH_FILE)) {
    // A TRACKED pair going missing is a repo defect, not an environment one, so
    // it fails rather than skipping. Only the vendor pair may be absent.
    expect(pair.tracked, `${pair.glb} and ${pair.bvh} are tracked and must exist`).toBe(false);
    test.skip(true, `needs ${pair.glb} + ${pair.bvh} (untracked vendor output)`);
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

  // The BIND, captured before any motion exists — the only definition of
  // "unbent" this rig has, and the reference the leaf-joint row below compares
  // against. It has to be read here: once a clip is bound there is no frame in
  // which the rig is at its bind.
  const bindPose = await page.evaluate(() => {
    const w = window as unknown as BasherWindow & {
      __basher_three?: { getState: () => { scene?: unknown } };
    };
    const scene = w.__basher_three?.getState().scene as
      | { traverse: (f: (o: never) => void) => void }
      | undefined;
    if (!scene) throw new Error('no scene handle — the probe would report a vacuous zero');
    const out: Record<string, number[]> = {};
    scene.traverse((o: never) => {
      const b = o as unknown as {
        name: string;
        isBone?: boolean;
        matrixWorld: { elements: number[] };
      };
      if (b.isBone) out[b.name] = [...b.matrixWorld.elements];
    });
    return out;
  });
  expect(Object.keys(bindPose).length, 'the bind pose must have bones in it').toBeGreaterThan(20);

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
  const played = await page.evaluate(async (sampleTimes: readonly number[]) => {
    const w = window as unknown as BasherWindow;
    const times = sampleTimes;
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
  }, pair.times);

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
  const posture = await page.evaluate(async (sampleTimes: readonly number[]) => {
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
    for (const t of sampleTimes) {
      w.__basher_time!.getState().setTime(t);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      rows.push(y('mixamorigHead') - y('mixamorigHips'));
    }
    return rows;
  }, pair.times);
  const worstPosture = Math.min(...posture);
  expect(
    worstPosture,
    `the head dropped to ${worstPosture.toFixed(3)} above the hips — the character is ` +
      `performing the motion lying down (#844). Samples: ${posture.map((v) => v.toFixed(3)).join(', ')}`,
  ).toBeGreaterThan(MIN_UPRIGHT);

  // ---- 5. STRIDE — does it travel as far as its own legs are stepping? ----
  //
  // 🔴 THE #846 GUARD, AND IT IS THE ONLY ONE THAT COULD HAVE SEEN IT. Every
  // assertion above was green while the retarget scaled the root's travel 13%
  // too small: the bones swung, the character stood up, and it travelled — just
  // less than its legs were carrying it. That is foot slide, and "it travels at
  // all" cannot distinguish it from a correct walk.
  //
  // The measure is DIMENSIONLESS: stride divided by leg length. A correct scale
  // preserves it exactly across the retarget, because scaling a rig and its
  // locomotion by the same factor leaves the proportion alone. Measured on this
  // pair: 1.6684 on the source, 1.6684 rendered — and 1.4515 under the defect.
  //
  // It is not the implementation restated. Both leg lengths here are read from
  // NAMED bones — the source's from the BVH, the target's from the bones the
  // renderer actually posed — where the code derives its leg structurally and
  // never sees these names. A scale computed from a different basis (feet
  // included, one leg instead of two) moves the rendered side and not this one.
  // ---- 5. ARM CARRIAGE — is it walking, or holding a T-pose while it walks? --
  //
  // 🔴 THE #845 GUARD. Standing the character up (#844) and swinging its bones
  // (#843) both passed while the arms stayed stuck halfway out to the sides,
  // because the reconciliation sampled a DIFFERENT reference pose on each rig —
  // the source's A-pose against the target's T-pose bind — and every arm bone
  // carried the angle between them for the whole clip. Nothing else here can see
  // it: the arms rotate, the head is above the hips, and the stride is right.
  const arms = await page.evaluate(async (sampleTimes: readonly number[]) => {
    const w = window as unknown as BasherWindow & {
      __basher_three?: { getState: () => { scene?: unknown } };
    };
    const scene = w.__basher_three?.getState().scene as
      | { traverse: (f: (o: never) => void) => void }
      | undefined;
    if (!scene) throw new Error('no scene handle — the probe would report a vacuous zero');
    const hang: number[] = [];
    for (const t of sampleTimes) {
      w.__basher_time!.getState().setTime(t);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const at = new Map<string, [number, number, number]>();
      scene.traverse((o: never) => {
        const b = o as unknown as {
          name: string;
          isBone?: boolean;
          matrixWorld: { elements: number[] };
        };
        if (b.isBone) {
          const e = b.matrixWorld.elements;
          at.set(b.name, [e[12], e[13], e[14]]);
        }
      });
      // Both arms, so a fix that only lands on one side cannot pass.
      for (const side of ['Left', 'Right']) {
        const shoulder = at.get(`mixamorig${side}Arm`);
        const elbow = at.get(`mixamorig${side}ForeArm`);
        if (!shoulder || !elbow) throw new Error(`no rendered ${side} arm`);
        const d = [elbow[0] - shoulder[0], elbow[1] - shoulder[1], elbow[2] - shoulder[2]];
        const length = Math.hypot(d[0], d[1], d[2]);
        hang.push((Math.asin(-d[1] / length) * 180) / Math.PI);
      }
    }
    return hang;
  }, pair.times);

  const flattest = Math.min(...arms);
  expect(
    flattest,
    `an upper arm sat only ${flattest.toFixed(1)}° below horizontal — the arms are held out ` +
      `toward the target's T-pose bind instead of following the clip (#845). ` +
      `Samples: ${arms.map((v) => v.toFixed(0)).join(', ')}`,
  ).toBeGreaterThan(MIN_ARM_HANG_DEG);

  // ---- 6. LEAF JOINTS — is the head on straight? ------------------------
  //
  // 🔴 THE #853 GUARD. Everything above passed while the character walked
  // correctly and held its head bent 42° at the neck for the whole clip. The
  // leaves of a Mixamo rig are the head, both hands and both toe bases: they
  // have no mapped child, so the direction alignment that pins two of three
  // rotational degrees of freedom for every other bone pins NONE of theirs, and
  // they took their parent's correction instead — computed for a bone pointing
  // somewhere else.
  //
  // WHY THE MINIMUM, AND NOT THE MAXIMUM. A leaf joint legitimately bends
  // during a walk: a head bobs, a toe flexes at toe-off. What the defect adds is
  // a CONSTANT — the same 42° at every sample. So the measure has to be the
  // sample where the joint comes CLOSEST to the target's own bind bend: real
  // motion passes through neutral and a constant offset never does. The first
  // sample is excluded because it is the reference the correction is derived
  // from, where the answer is zero by construction and would prove nothing.
  const leafJoints = await page.evaluate(
    async ([sampleTimes, bind]: [readonly number[], Record<string, number[]>]) => {
      const w = window as unknown as BasherWindow & {
        __basher_three?: { getState: () => { scene?: unknown } };
      };
      const scene = w.__basher_three?.getState().scene as
        | { traverse: (f: (o: never) => void) => void }
        | undefined;
      if (!scene) throw new Error('no scene handle — the probe would report a vacuous zero');
      type Q = [number, number, number, number];
      const quat = (e: number[]): Q => {
        const c = (i: number): [number, number, number] => {
          const v: [number, number, number] = [e[i * 4], e[i * 4 + 1], e[i * 4 + 2]];
          const n = Math.hypot(v[0], v[1], v[2]);
          return [v[0] / n, v[1] / n, v[2] / n];
        };
        const [m00, m10, m20] = c(0);
        const [m01, m11, m21] = c(1);
        const [m02, m12, m22] = c(2);
        const tr = m00 + m11 + m22;
        if (tr > 0) {
          const k = Math.sqrt(tr + 1) * 2;
          return [(m21 - m12) / k, (m02 - m20) / k, (m10 - m01) / k, k / 4];
        }
        if (m00 > m11 && m00 > m22) {
          const k = Math.sqrt(1 + m00 - m11 - m22) * 2;
          return [k / 4, (m01 + m10) / k, (m02 + m20) / k, (m21 - m12) / k];
        }
        if (m11 > m22) {
          const k = Math.sqrt(1 + m11 - m00 - m22) * 2;
          return [(m01 + m10) / k, k / 4, (m12 + m21) / k, (m02 - m20) / k];
        }
        const k = Math.sqrt(1 + m22 - m00 - m11) * 2;
        return [(m02 + m20) / k, (m12 + m21) / k, k / 4, (m10 - m01) / k];
      };
      const mul = (a: Q, b: Q): Q => [
        a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
        a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
        a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
        a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
      ];
      const inv = (a: Q): Q => [-a[0], -a[1], -a[2], a[3]];
      const deg = (a: Q): number => (2 * Math.acos(Math.min(1, Math.abs(a[3]))) * 180) / Math.PI;
      const bend = (parent: number[], child: number[]): Q => mul(inv(quat(parent)), quat(child));

      // Every leaf of the mapped rig, each named with the joint above it.
      const JOINTS: Array<[string, string]> = [
        ['Head', 'Neck'],
        ['LeftHand', 'LeftForeArm'],
        ['RightHand', 'RightForeArm'],
        ['LeftToeBase', 'LeftFoot'],
        ['RightToeBase', 'RightFoot'],
      ];
      const names = Object.keys(bind);
      const find = (leaf: string): string | undefined =>
        names.find((n) => n.replace(/[^A-Za-z]/g, '').endsWith(leaf));

      const closest: Record<string, number> = {};
      const perSample: Record<string, number[]> = {};
      for (let i = 0; i < sampleTimes.length; i++) {
        w.__basher_time!.getState().setTime(sampleTimes[i]);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const at: Record<string, number[]> = {};
        scene.traverse((o: never) => {
          const b = o as unknown as {
            name: string;
            isBone?: boolean;
            matrixWorld: { elements: number[] };
          };
          if (b.isBone) at[b.name] = [...b.matrixWorld.elements];
        });
        if (i === 0) continue; // the reference sample — zero by construction
        for (const [leaf, parent] of JOINTS) {
          const L = find(leaf);
          const P = find(parent);
          if (!L || !P || !bind[L] || !bind[P] || !at[L] || !at[P]) continue;
          const off = deg(mul(bend(at[P], at[L]), inv(bend(bind[P], bind[L]))));
          perSample[leaf] = [...(perSample[leaf] ?? []), off];
          closest[leaf] = Math.min(closest[leaf] ?? Infinity, off);
        }
      }
      return { closest, perSample };
    },
    [pair.times, bindPose] as [readonly number[], Record<string, number[]>],
  );

  expect(
    Object.keys(leafJoints.closest).length,
    'no leaf joint was measured at all — the probe would report a vacuous pass',
  ).toBe(5);
  for (const [leaf, off] of Object.entries(leafJoints.closest)) {
    expect(
      off,
      `${leaf} never came closer than ${off.toFixed(1)}° to its own bind bend — a leaf bone ` +
        `has no mapped child, so nothing pins its orientation and it inherited a correction ` +
        `computed for another bone (#853). Samples: ` +
        `${(leafJoints.perSample[leaf] ?? []).map((v) => v.toFixed(0)).join(', ')}`,
    ).toBeLessThan(MAX_LEAF_JOINT_DEG);
  }

  const sampleWindow = pair.times[pair.times.length - 1];
  const sourceBones = parseBvh(
    fs.readFileSync(BVH_FILE, 'utf8'),
    'stride-reference',
    BVH_UNIT_SCALE_CENTIMETRES,
  );
  const boneLen = (name: string): number => {
    const b = sourceBones.skeletonParams.bones.find((x) => x.name === name);
    if (!b) throw new Error(`the source clip has no bone ${name} — the probe would divide by zero`);
    return Math.hypot(b.position[0], b.position[1], b.position[2]);
  };
  // A bone's offset is the length of the bone ABOVE it, so the thigh is measured
  // at the knee and the shin at the ankle. SOMA's `LeftLeg` is the thigh.
  const sourceLegs = pair.sourceLegBones.reduce((sum, n) => sum + boneLen(n), 0);
  const hipsBone = sourceBones.skeletonParams.bones.findIndex((b) => b.name === 'Hips');
  const sourceKeys = sourceBones.clipParams.keyframes.filter(
    (k) => k.bone === hipsBone && k.time <= sampleWindow,
  );
  const sourceStride = Math.max(
    ...sourceKeys.map((k) =>
      Math.hypot(
        k.position[0] - sourceKeys[0].position[0],
        k.position[1] - sourceKeys[0].position[1],
        k.position[2] - sourceKeys[0].position[2],
      ),
    ),
  );

  const rendered = await page.evaluate(async (sampleTimes: readonly number[]) => {
    const w = window as unknown as BasherWindow & {
      __basher_three?: { getState: () => { scene?: unknown } };
    };
    const scene = w.__basher_three?.getState().scene as
      | { traverse: (f: (o: never) => void) => void }
      | undefined;
    if (!scene) throw new Error('no scene handle — the probe would report a vacuous zero');
    const worldPositions = (): Map<string, [number, number, number]> => {
      const out = new Map<string, [number, number, number]>();
      scene.traverse((o: never) => {
        const b = o as unknown as {
          name: string;
          isBone?: boolean;
          matrixWorld: { elements: number[] };
        };
        if (b.isBone) {
          const e = b.matrixWorld.elements;
          out.set(b.name, [e[12], e[13], e[14]]);
        }
      });
      return out;
    };
    const gap = (m: Map<string, [number, number, number]>, a: string, b: string): number => {
      const p = m.get(a);
      const q = m.get(b);
      if (!p || !q) throw new Error(`no rendered bone ${!p ? a : b}`);
      return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    };

    let legs = NaN;
    const hips: [number, number, number][] = [];
    for (const t of sampleTimes) {
      w.__basher_time!.getState().setTime(t);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const m = worldPositions();
      if (Number.isNaN(legs)) {
        // Thigh and shin on both sides, posed — the same two long bones the
        // scale is derived from, read here off the rendered skeleton.
        legs =
          gap(m, 'mixamorigLeftUpLeg', 'mixamorigLeftLeg') +
          gap(m, 'mixamorigLeftLeg', 'mixamorigLeftFoot') +
          gap(m, 'mixamorigRightUpLeg', 'mixamorigRightLeg') +
          gap(m, 'mixamorigRightLeg', 'mixamorigRightFoot');
      }
      const p = m.get('mixamorigHips');
      if (!p) throw new Error('no rendered hips');
      hips.push(p);
    }
    const stride = Math.max(
      ...hips.map((p) => Math.hypot(p[0] - hips[0][0], p[1] - hips[0][1], p[2] - hips[0][2])),
    );
    return { legs, stride };
  }, pair.times);

  const sourceRatio = sourceStride / sourceLegs;
  const renderedRatio = rendered.stride / rendered.legs;
  const drift = Math.abs(renderedRatio - sourceRatio) / sourceRatio;
  expect(
    drift,
    `the character strides ${renderedRatio.toFixed(4)} of its own leg length where the clip ` +
      `strides ${sourceRatio.toFixed(4)} of the source's — ${(drift * 100).toFixed(1)}% apart. ` +
      `The retarget scale is wrong and the feet are sliding (#846). ` +
      `rendered stride ${rendered.stride.toFixed(4)} over legs ${rendered.legs.toFixed(4)}; ` +
      `source stride ${sourceStride.toFixed(4)} over legs ${sourceLegs.toFixed(4)}.`,
  ).toBeLessThan(MAX_STRIDE_DRIFT);

  expect(errors, `page errors during playback: ${errors.join(' | ')}`).toEqual([]);
}
