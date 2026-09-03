// @vitest-environment node
//
// 🔴 THROWAWAY LIVE HARNESS — NEVER STAGE THIS FILE.
//
// 🔑 THE `node` ENVIRONMENT ABOVE IS LOad-BEARING. The suite default is
// happy-dom, which simulates a browser and therefore ENFORCES the Same-Origin
// Policy on fetch — so the very first call died with "Cross-Origin Request
// Blocked" before reaching Tripo at all. Nothing was billed. This harness is a
// node-side probe of a remote API, not a browser test, so it runs in node.
//
// It spends real credits. `tmp-` prefixed on purpose: the unit tier runs as
// `npx vitest run --exclude '**/tmp-*'`, so nothing here ever reaches CI.
//
// WHAT IT ANSWERS. Exactly one claim, the residual that session 103 measured as
// not provable offline and deliberately left unasserted in `rigRoad.test.ts`:
//
//     Tripo text-to-3D → rig(spec: 'mixamo') → a Mixamo-named skeleton
//
// The verdict is already encoded in the production code, so this adds NO new
// assertion for the residual itself: `TripoModelGenerationCapability.rig()` reads
// the joint names out of the returned GLB and throws
// /returned a skeleton whose bone names are not Mixamo's/ when they are not.
//   rig() resolves ⇒ the road is real.
//   rig() throws that ⇒ the premise is false and the join must be re-derived.
//
// THEN it closes the loop: a REAL Kimodo clip retargets onto the REAL rig,
// through the production glTF skin-import path — the offline half of which
// already passes in `rigRoad.test.ts` against the stub.
//
// 🔴 THE CLIENT IS CONSTRUCTED DIRECTLY, NOT THROUGH `pickRigging`. `pickRigging`
// falls back to `StubRiggingCapability` when the service is unavailable, and the
// stub emits Mixamo-named bones — so a run through it would report a green that
// says nothing about Tripo. `kind` is asserted before anything else for the same
// reason.
//
// Run: TRIPO_API_KEY=… npx vitest run src/core/rigging/tmp-tripo-live.test.ts
//      TRIPO_API_VERSION=v2 to aim it at the older API instead (default: v3).
//
// 🔴 v3's wire is VENDOR-DOCUMENTED, not source-verified — this run is the first
// thing that would observe it. A failure here may be our transcription rather
// than the service. Before concluding anything about the rig road, fetch the
// authenticated schema (openapi.tripo3d.ai/openapi.json answers 401, not 404)
// and re-verify `tripoDialect.ts` against it.

import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { TripoModelGenerationCapability } from '../modelgen/TripoModelGenerationCapability';
import { parseGltfContainer, resolveBuffers } from '../import/glb';
import { buildNodeNameMap, buildSkinMetadata } from '../import/gltfImportChain';
import { projectGltfSkeleton } from '../import/projectGltfSkeleton';
import { parseBvh, BVH_UNIT_SCALE_CENTIMETRES } from '../import/bvh';
import { retargetClip } from '../import/retarget';
import { BONE_NAME_MAP_PRESETS } from '../import/boneNameMaps';
import { classifyRigSpec, missingForRetarget, mixamoBonesRequiredForRetarget } from './index';
import type { GltfSkinMetadata } from '../../nodes/types';

const OUT_DIR = resolve(process.env.TMPDIR ?? '/tmp', 'tripo-live-run');
const KIMODO_CLIP = resolve(
  process.env.HOME ?? '',
  'Documents/projects/auto-animate/kimodo/out/walk.bvh',
);
const PROMPT =
  'a stylized humanoid robot character standing upright in an A-pose, full body, ' +
  'clean simple shapes, two arms, two legs, one head';

const somaToMixamo = () => BONE_NAME_MAP_PRESETS.find((p) => p.id === 'somaToMixamo')!;
const requiredBones = () => mixamoBonesRequiredForRetarget(Object.values(somaToMixamo().map));

/** Run a rigged GLB down the PRODUCTION skin-import path and return its skeleton. */
async function skeletonOf(glb: ArrayBuffer) {
  const { json, bin } = parseGltfContainer(glb);
  const buffers = await resolveBuffers(json, bin);
  const { keyByGltfNodeIndex, childHierarchy } = buildNodeNameMap(json, 'rigged');
  const skins = buildSkinMetadata(json, buffers, keyByGltfNodeIndex, childHierarchy);
  expect(skins.length).toBeGreaterThan(0);
  return projectGltfSkeleton(skins[0] as unknown as GltfSkinMetadata);
}

/** Raw joint names straight off the container, BEFORE Basher sanitises them.
 *  A real Mixamo rig writes `mixamorig:Hips` with a COLON here; the import road
 *  turns it into `_`. Printed so the difference is visible rather than surprising. */
function rawJointNames(glb: ArrayBuffer): string[] {
  const { json } = parseGltfContainer(glb);
  const nodes = (json.nodes ?? []) as { name?: string }[];
  const skins = (json.skins ?? []) as { joints?: number[] }[];
  return skins.flatMap((s) => (s.joints ?? []).map((i) => nodes[i]?.name ?? '<unnamed>'));
}

function write(name: string, bytes: ArrayBuffer): string {
  const path = resolve(OUT_DIR, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.from(bytes));
  return path;
}

describe('LIVE — Tripo text-to-3D → rig(mixamo) → a Mixamo-named skeleton', () => {
  it('generates, rigs, and a real Kimodo clip drives what comes back', async () => {
    const apiKey = process.env.TRIPO_API_KEY;
    // A hard failure, not a skip. A skipped live run reports the same green as
    // a passing one, which is the exact vacuous-pass shape this file exists to
    // avoid producing.
    if (!apiKey) throw new Error('TRIPO_API_KEY is not set — nothing was run.');

    const apiVersion = (process.env.TRIPO_API_VERSION ?? 'v3') as 'v2' | 'v3';
    console.log(`[api] speaking ${apiVersion}`);
    const tripo = new TripoModelGenerationCapability({
      apiKey,
      apiVersion,
      timeoutMs: 900_000,
      pollIntervalMs: 3_000,
    });
    // Proof this is the REAL transport and not a stub that would fake the answer.
    expect(tripo.kind).toBe('http');

    const before = await tripo.getBalance();
    console.log(`[balance] before: ${JSON.stringify(before)}`);

    // ---- 1. text → 3D ------------------------------------------------------
    // A mesh already generated on this account is addressable by task id, which
    // is what makes iterating on the RIG half free. Generation is the billed
    // step — 20 credits, measured — and rig-check costs 0.
    let sourceTaskId = process.env.TRIPO_SOURCE_TASK_ID ?? '';
    if (sourceTaskId) {
      console.log(`[generate] SKIPPED — reusing the mesh already paid for: ${sourceTaskId}`);
    } else {
      let lastGen = '';
      const model = await tripo.generate({ source: 'text', prompt: PROMPT }, (p) => {
        const line = `${p.status} ${p.progress}%`;
        if (line !== lastGen) console.log(`[generate] ${line}`);
        lastGen = line;
      });
      console.log(`[generate] taskId=${model.taskId} bytes=${model.glb.byteLength}`);
      console.log(`[generate] wrote ${write('generated.glb', model.glb)}`);
      sourceTaskId = model.taskId;
    }

    // ---- 2. can it be rigged at all? --------------------------------------
    const check = await tripo.checkRiggable({ sourceTaskId });
    console.log(`[prerig] ${JSON.stringify(check)}`);
    expect(check.riggable).toBe(true);

    // ---- 3. rig, asking for Mixamo ----------------------------------------
    // 🔑 THE VERDICT. `rig()` itself refuses a mixamo request that came back in
    // another vocabulary. Resolving IS the answer; no assertion is added here.
    let lastRig = '';
    const rigModel = process.env.TRIPO_RIG_MODEL;
    if (rigModel) console.log(`[rig] auto-rigging model: ${rigModel}`);
    const rigged = await tripo.rig(
      { sourceTaskId, spec: 'mixamo', ...(rigModel ? { modelVersion: rigModel } : {}) },
      (p) => {
        const line = `${p.status} ${p.progress}%`;
        if (line !== lastRig) console.log(`[rig] ${line}`);
        lastRig = line;
      },
    );
    console.log(`[rig] taskId=${rigged.taskId} bytes=${rigged.glb.byteLength}`);
    console.log(`[rig] wrote ${write('rigged.glb', rigged.glb)}`);

    const raw = rawJointNames(rigged.glb);
    console.log(`[rig] ${raw.length} raw joints (colons expected): ${raw.slice(0, 8).join(', ')}`);

    // ---- 4. read the skeleton through the PRODUCTION import road ----------
    const skeleton = await skeletonOf(rigged.glb);
    const names = skeleton.bones.map((b) => b.name);
    console.log(`[import] ${names.length} bones after sanitising: ${names.join(', ')}`);

    expect(classifyRigSpec(names)).toBe('mixamo');
    const missing = missingForRetarget(names, requiredBones());
    console.log(`[retarget] missing bones: ${missing.length === 0 ? 'none' : missing.join(', ')}`);
    expect(missing).toEqual([]);

    // ---- 5. close the loop: a REAL Kimodo clip drives the REAL rig ---------
    const soma = parseBvh(
      readFileSync(KIMODO_CLIP, 'utf8'),
      'kimodo-walk',
      BVH_UNIT_SCALE_CENTIMETRES,
    );
    const out = retargetClip({
      sourceBones: soma.skeletonParams.bones,
      sourceClip: {
        name: soma.clipParams.name,
        duration: soma.clipParams.duration,
        keyframes: soma.clipParams.keyframes,
      },
      targetBones: skeleton.bones,
      nameMap: somaToMixamo().map,
    });
    console.log(
      `[retarget] ${out.clipParams.keyframes.length} keyframes over ` +
        `${out.clipParams.duration.toFixed(3)}s onto the LIVE rig`,
    );
    expect(out.clipParams.keyframes.length).toBeGreaterThan(0);
    const touched = new Set(out.clipParams.keyframes.map((k) => names[k.bone]));
    for (const bone of requiredBones()) expect(touched.has(bone)).toBe(true);

    // ---- 6. what it cost ---------------------------------------------------
    const after = await tripo.getBalance();
    console.log(`[balance] after:  ${JSON.stringify(after)}`);
    console.log(`[balance] delta:  ${(after.balance - before.balance).toFixed(4)}`);
  }, 1_800_000);
});
