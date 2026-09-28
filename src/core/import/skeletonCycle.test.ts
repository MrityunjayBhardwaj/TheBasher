// #1183 — a skeleton whose parent chain loops is refused with the bone named, not walked forever.
//
// `BoneSpec.parent` is only a number. A bone its own parent — which every Mixamo FBX produced
// before #1181 — made `retargetClip` loop synchronously in `shallowestMapped`, freezing the tab;
// vitest's timeout cannot interrupt that, so the bounded-time row runs it in a child process.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { boneOnACycle } from './threeAdapter';
import { parseFbx } from './fbx';
import { parseBvh, BVH_UNIT_SCALE_CENTIMETRES } from './bvh';
import { SkeletonParams } from '../../nodes/Skeleton';
import type { BoneSpec } from '../../nodes/types';

const bone = (name: string, parent: number): BoneSpec => ({
  name,
  parent,
  position: [0, 1, 0],
  rotation: [0, 0, 0],
});
const TREE = [bone('root', -1), bone('spine', 0), bone('head', 1), bone('arm', 1)];
const SELF = [bone('a', 0), bone('b', 0)];
const LOOP_BELOW_A_ROOT = [bone('root', -1), bone('x', 3), bone('y', 1), bone('z', 2)];

describe('boneOnACycle', () => {
  it('names a bone that is its own parent', () => {
    expect(boneOnACycle(SELF)).toBe('a');
  });

  it('names a bone on a longer loop, even when the skeleton also has a real root', () => {
    expect(['x', 'y', 'z']).toContain(boneOnACycle(LOOP_BELOW_A_ROOT));
  });

  it('finds nothing in a tree, in either parent order, or in an empty list', () => {
    expect(boneOnACycle(TREE)).toBeNull();
    // Children listed before their parents are still a tree.
    expect(boneOnACycle([bone('head', 2), bone('root', -1), bone('spine', 1)])).toBeNull();
    expect(boneOnACycle([])).toBeNull();
  });

  it('leaves a parent index outside the list to the readers that treat it as a root', () => {
    expect(boneOnACycle([bone('a', 7)])).toBeNull();
  });

  it('refuses no skeleton any import road produces from the committed fixtures', () => {
    const fbx = ['rig.fbx', 'rig-two-skins.fbx', 'mixamo-naming.fbx', 'null-in-chain.fbx'];
    const bvh = ['walk.bvh', 'soma-walk.bvh', 'mixamo-naming.bvh', 'kimodo-served-f0.bvh'];
    const dir = resolve(process.cwd(), 'public/fixtures/anim');
    let examined = 0;
    for (const f of fbx) {
      const buf = readFileSync(join(dir, f));
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
      expect(boneOnACycle(parseFbx(ab, f).skeletonParams.bones), f).toBeNull();
      examined++;
    }
    for (const f of bvh) {
      const text = readFileSync(join(dir, f), 'utf8');
      expect(
        boneOnACycle(parseBvh(text, f, BVH_UNIT_SCALE_CENTIMETRES).skeletonParams.bones),
        f,
      ).toBeNull();
      examined++;
    }
    expect(examined).toBe(fbx.length + bvh.length);
  });
});

describe('retargetClip refuses a cyclic skeleton, naming the bone and the rig', () => {
  // Run where a hang can be stopped: a child process with a deadline. In this process a
  // regression would freeze the whole test run; there it reads as a timeout.
  const clip = {
    name: 'c',
    duration: 1,
    keyframes: [
      { bone: 0, time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
      { bone: 0, time: 1, position: [0, 0, 0], rotation: [0.1, 0, 0] },
    ],
  };
  const cases = {
    source: { sourceBones: SELF, sourceClip: clip, targetBones: TREE, nameMap: { a: 'root' } },
    target: {
      sourceBones: TREE,
      sourceClip: clip,
      targetBones: LOOP_BELOW_A_ROOT,
      nameMap: { root: 'root', spine: 'x' },
    },
  };

  const DEADLINE_MS = 30_000;
  let outcome: Record<string, string> = {};
  let elapsed = 0;

  it(
    'both refusals come back well inside the deadline',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'retarget-cycle-'));
      const script = join(dir, 'run.ts');
      writeFileSync(
        script,
        `import { retargetClip } from ${JSON.stringify(resolve(process.cwd(), 'src/core/import/retarget'))};
const cases = ${JSON.stringify(cases)};
const out: Record<string, string> = {};
for (const [label, args] of Object.entries(cases)) {
  try {
    retargetClip(args as never);
    out[label] = 'RETURNED';
  } catch (e) {
    out[label] = (e as Error).message;
  }
}
console.log('OUTCOME ' + JSON.stringify(out));
`,
      );
      const started = Date.now();
      const stdout = execFileSync(
        process.execPath,
        [resolve(process.cwd(), 'node_modules/vite-node/vite-node.mjs'), script],
        // SIGKILL: a process spinning in a synchronous loop never runs a SIGTERM handler, and
        // vite-node installs one — measured, the default signal left the child running.
        { encoding: 'utf8', timeout: DEADLINE_MS, killSignal: 'SIGKILL', cwd: process.cwd() },
      );
      elapsed = Date.now() - started;
      const line = stdout.split('\n').find((l) => l.startsWith('OUTCOME '));
      expect(line, 'the child printed its outcome').toBeDefined();
      outcome = JSON.parse((line as string).slice('OUTCOME '.length));
      expect(elapsed).toBeLessThan(DEADLINE_MS);
    },
    DEADLINE_MS + 10_000,
  );

  it('names the source rig and its bone', () => {
    expect(outcome.source).toMatch(/source skeleton's bone "a" is its own ancestor/);
  });

  it('names the target rig and a bone on its loop', () => {
    expect(outcome.target).toMatch(/target skeleton's bone "[xyz]" is its own ancestor/);
  });
});

describe('the Skeleton node refuses a cyclic write', () => {
  it('names the bone', () => {
    const parsed = SkeletonParams.safeParse({ bones: SELF });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.map((i) => i.message).join(' ')).toMatch(
      /bone "a" is its own ancestor/,
    );
  });

  it('still takes a tree, its default, and a parent outside the list as before', () => {
    expect(SkeletonParams.safeParse({ bones: TREE }).success).toBe(true);
    expect(SkeletonParams.safeParse({}).success).toBe(true);
    expect(SkeletonParams.safeParse({ bones: [bone('a', 7)] }).success).toBe(true);
  });
});
