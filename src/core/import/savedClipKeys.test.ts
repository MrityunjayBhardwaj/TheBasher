// #1432 — the saved-keys road reproduces, bit for bit, what the retarget returned before producers
// moved to poses.
//
// The v9 → v10 migration (`eagerChannelKeepReason`) keeps or drops a saved channel by comparing it
// with `!==` against a retarget of the saved keys. So this road is only correct if it returns the
// very doubles the old one did; "close" would keep every channel it should drop. The fixture is that
// old road's output, recorded at `c087f77f` through `retargetClipParamsFromNodes` for a generated
// walk onto the stand-in rig, with the keys it was given.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseGltfContainer, resolveBuffers } from './glb';
import { buildNodeNameMap, buildSkinMetadata } from './gltfImportChain';
import { projectGltfSkeleton } from './projectGltfSkeleton';
import { parseBvh } from './bvh';
import { getBoneNameMapPreset } from './boneNameMaps';
import { retargetSavedKeys } from './savedClipKeys';
import type { AnimationKeyframe, GltfSkinMetadata } from '../../nodes/types';

interface Recorded {
  readonly source: string;
  readonly unitScale: number;
  readonly target: string;
  readonly nameMap: string;
  readonly input: AnimationKeyframe[];
  readonly output: {
    readonly name: string;
    readonly duration: number;
    readonly loop: string;
    readonly keyframes: AnimationKeyframe[];
  };
}

const recorded = JSON.parse(
  readFileSync(resolve(__dirname, '__fixtures__/saved-keys-retarget-soma-generated.json'), 'utf8'),
) as Recorded;

async function rig(rel: string) {
  const buf = readFileSync(resolve(process.cwd(), rel));
  const { json, bin } = parseGltfContainer(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
  );
  const buffers = await resolveBuffers(json, bin);
  const { keyByGltfNodeIndex, childHierarchy } = buildNodeNameMap(json, 'standin');
  const [skin] = buildSkinMetadata(json, buffers, keyByGltfNodeIndex, childHierarchy);
  return projectGltfSkeleton(skin as unknown as GltfSkinMetadata).bones;
}

describe('retargetSavedKeys', () => {
  it('returns exactly the keys the retarget returned before #1432', async () => {
    const source = parseBvh(
      readFileSync(resolve(process.cwd(), recorded.source), 'utf8'),
      'clip',
      recorded.unitScale,
    );
    const result = retargetSavedKeys({
      sourceBones: source.skeletonParams.bones,
      sourceClip: {
        name: 'clip',
        duration: source.clipParams.duration,
        keyframes: recorded.input,
        loop: 'hold',
      },
      targetBones: await rig(recorded.target),
      nameMap: getBoneNameMapPreset(recorded.nameMap)!.map,
    });
    // The denominator: an empty recording would match an empty answer.
    expect(recorded.output.keyframes.length).toBe(138);
    // Every double, compared as the migration compares them (`!==`): the recording is JSON, which
    // writes -0 as 0, and so does `===`. Anything short of equal fails here.
    const got = result.clipParams;
    expect(got.keyframes.length).toBe(recorded.output.keyframes.length);
    let unequal = 0;
    got.keyframes.forEach((k, i) => {
      const r = recorded.output.keyframes[i];
      if (k.bone !== r.bone || k.time !== r.time) unequal++;
      for (let c = 0; c < 3; c++) {
        if (k.position[c] !== r.position[c] || k.rotation[c] !== r.rotation[c]) unequal++;
      }
    });
    expect(unequal).toBe(0);
    expect([got.name, got.duration, got.loop]).toEqual([
      recorded.output.name,
      recorded.output.duration,
      recorded.output.loop,
    ]);
  });
});
