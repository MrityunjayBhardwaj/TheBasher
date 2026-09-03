// Rebuild the project's retargeted clip from the BUNDLE'S OWN source nodes.
// GATE: with the pre-fix solver this must reproduce what the bundle already
// holds. Only then is a substitution of the fixed result trustworthy.
import { describe, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseGltfContainer, resolveBuffers } from './glb';
import { buildNodeNameMap, buildSkinMetadata } from './gltfImportChain';
import { projectGltfSkeleton } from './projectGltfSkeleton';
import { retargetClip } from './retarget';
import { BONE_NAME_MAP_PRESETS } from './boneNameMaps';
import type { BoneSpec, GltfSkinMetadata } from '../../nodes/types';

const BUNDLE = process.env.BUNDLE!;
const GLB = process.env.GLB!;
const OUT = process.env.OUT;
const CLIP_NODE = 'n_bvh_clip_2crg4_on_n_gltfSkel_74081cc8';
const SRC_SKEL = 'n_bvh_skel_1bvkt';
const SRC_CLIP = 'n_bvh_clip_2crg4';

describe('bundle clip rebuild', () => {
  it('reproduces / regenerates', async () => {
    const bundle = JSON.parse(readFileSync(BUNDLE, 'utf8'));
    const nodes = bundle.state.nodes;
    const sourceBones = nodes[SRC_SKEL].params.bones as BoneSpec[];
    const src = nodes[SRC_CLIP].params;
    const existing = nodes[CLIP_NODE].params.keyframes as Array<{
      bone: number; time: number; position: number[]; rotation: number[];
    }>;

    const glb = readFileSync(GLB);
    const { json, bin } = parseGltfContainer(
      glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer,
    );
    const buffers = await resolveBuffers(json, bin);
    const { keyByGltfNodeIndex, childHierarchy } = buildNodeNameMap(json, 'rigged');
    const skins = buildSkinMetadata(json, buffers, keyByGltfNodeIndex, childHierarchy);
    const target = projectGltfSkeleton(skins[0] as unknown as GltfSkinMetadata);

    const preset = BONE_NAME_MAP_PRESETS.find((p) => p.id === 'somaToMixamo')!;
    const out = retargetClip({
      sourceBones,
      sourceClip: { name: src.name, duration: src.duration, keyframes: src.keyframes },
      targetBones: target.bones,
      nameMap: preset.map,
      outputName: nodes[CLIP_NODE].params.name,
    });
    const got = out.clipParams.keyframes as typeof existing;

    console.log(`existing=${existing.length} rebuilt=${got.length} duration ${nodes[CLIP_NODE].params.duration} vs ${out.clipParams.duration}`);
    let worstP = 0, worstR = 0, worstT = 0, order = 0;
    for (let i = 0; i < Math.min(existing.length, got.length); i++) {
      const a = existing[i], b = got[i];
      if (a.bone !== b.bone) order++;
      worstT = Math.max(worstT, Math.abs(a.time - b.time));
      for (let c = 0; c < 3; c++) {
        worstP = Math.max(worstP, Math.abs((a.position?.[c] ?? 0) - (b.position?.[c] ?? 0)));
        worstR = Math.max(worstR, Math.abs(a.rotation[c] - b.rotation[c]));
      }
    }
    console.log(`  order mismatches=${order}  worst time=${worstT.toExponential(3)}  position=${worstP.toExponential(3)}  rotation=${worstR.toExponential(3)} rad`);
    if (OUT) { writeFileSync(OUT, JSON.stringify({ ...out.clipParams, boneNames: target.bones.map((b) => b.name) })); console.log(`  wrote ${OUT}`); }
  });
});
