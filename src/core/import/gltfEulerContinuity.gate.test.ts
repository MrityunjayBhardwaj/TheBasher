// #876 GATE — the glTF embedded-clip road must produce Euler keyframes a LINEAR
// sampler can interpolate, i.e. representatives chosen with reference to the
// previous key rather than canonically per key.
//
// WHY THE FIXTURE IS SYNTHESISED HERE RATHER THAN COMMITTED AS AN ASSET.
// The tracked assets cannot fail this test — measured, not assumed:
//   many-bone-rig.glb   0 discontinuities of 16 intervals
//   skinned-bar.glb     0 of 1
//   standin-character   0 TransformClip nodes at all
// Only `mixamo-xbot.glb` exposes it, and that asset is untracked, so CI would
// gate on a file it does not have. A fixture that cannot fail is worse than no
// fixture: it reads green either way and licenses the belief that the road is
// covered.
//
// So the quaternions below are DERIVED FROM THE LIVE FAILING CASE rather than
// invented, and the derivation had to be done twice — see the note on QUATS.
import { describe, it, expect } from 'vitest';
import { Euler, Quaternion } from 'three';
import { buildGltfImportOps } from './gltfImportChain';
import { emptyDagState } from '../dag';

// mixamo-xbot.glb, animation 'run', mixamorig:RightForeArm, keys 9..15 — verbatim.
//
// 🔴 MY FIRST ATTEMPT AT THIS FIXTURE COULD NOT FAIL, and the reason is worth
// keeping. I picked keys where the quaternions barely moved and x/z alternated
// sign around zero, reasoning that the sign flip was the branch cut. It is not:
// with y ~ 2.8 deg the decomposition is nowhere near a singularity and the
// canonical converter returns the same representative every time. That fixture
// read GREEN against the restored defect while the real asset still reported 6
// discontinuities — a gate certifying nothing.
//
// The actual mechanism is the XYZ gimbal singularity. These quaternions are a
// rotation about +Y sweeping from ~66 deg toward ~90 deg (w falls 0.835 -> 0.519),
// and as it crosses the pole the canonical decomposition switches between
// (0, y, 0) and (+/-180, +/-(180-y), +/-180). Two adjacent keys a few degrees
// apart then differ by 180 in TWO components, and a component-wise lerp walks
// the long way round.
const QUATS: [number, number, number, number][] = [
  [-0.000000163, 0.550522506, 0.000000092, 0.83482033],
  [0.000000054, 0.606458545, 0.000000041, 0.795115113],
  [0.000000162, 0.661976695, -0.000000091, 0.749524474],
  [-0.000000376, 0.727572739, 0.00000034, 0.686030567],
  [0.000000045, 0.773793995, -0.000000131, 0.633437335],
  [0.000000011, 0.818754375, 0.000000037, 0.574143946],
  [-0.000000023, 0.854994774, -0.00000002, 0.518636823],
];
const TIMES = QUATS.map((_, i) => 0.3 + i * (1 / 30));

/** Minimal animated GLB: one node, one rotation channel, float32 accessors. */
function synthesiseAnimatedGlb(): ArrayBuffer {
  const timeBytes = new Float32Array(TIMES).buffer;
  const quatBytes = new Float32Array(QUATS.flat()).buffer;
  const pad4 = (n: number) => (4 - (n % 4)) % 4;
  const binLen = timeBytes.byteLength + quatBytes.byteLength;

  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'ForeArm' }],
    buffers: [{ byteLength: binLen }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: timeBytes.byteLength },
      { buffer: 0, byteOffset: timeBytes.byteLength, byteLength: quatBytes.byteLength },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: TIMES.length,
        type: 'SCALAR',
        min: [TIMES[0]],
        max: [TIMES[TIMES.length - 1]],
      },
      { bufferView: 1, componentType: 5126, count: QUATS.length, type: 'VEC4' },
    ],
    animations: [
      {
        name: 'branch-cut',
        samplers: [{ input: 0, output: 1, interpolation: 'LINEAR' }],
        channels: [{ sampler: 0, target: { node: 0, path: 'rotation' } }],
      },
    ],
  };

  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPad = pad4(jsonBytes.byteLength);
  const binPad = pad4(binLen);
  const total = 12 + 8 + jsonBytes.byteLength + jsonPad + 8 + binLen + binPad;

  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  let o = 0;
  dv.setUint32(o, 0x46546c67, true); // 'glTF'
  dv.setUint32(o + 4, 2, true);
  dv.setUint32(o + 8, total, true);
  o = 12;
  dv.setUint32(o, jsonBytes.byteLength + jsonPad, true);
  dv.setUint32(o + 4, 0x4e4f534a, true); // 'JSON'
  o += 8;
  out.set(jsonBytes, o);
  for (let i = 0; i < jsonPad; i++) out[o + jsonBytes.byteLength + i] = 0x20; // spaces
  o += jsonBytes.byteLength + jsonPad;
  dv.setUint32(o, binLen + binPad, true);
  dv.setUint32(o + 4, 0x004e4942, true); // 'BIN\0'
  o += 8;
  out.set(new Uint8Array(timeBytes), o);
  out.set(new Uint8Array(quatBytes), o + timeBytes.byteLength);

  return out.buffer;
}

const D2R = Math.PI / 180;
/** Angular distance between two XYZ-Euler triples, in degrees. */
function angleDeg(a: readonly number[], b: readonly number[]): number {
  const qa = new Quaternion().setFromEuler(new Euler(a[0] * D2R, a[1] * D2R, a[2] * D2R, 'XYZ'));
  const qb = new Quaternion().setFromEuler(new Euler(b[0] * D2R, b[1] * D2R, b[2] * D2R, 'XYZ'));
  return (2 * Math.acos(Math.min(1, Math.abs(qa.dot(qb))))) / D2R;
}

describe('#876 — the glTF clip road produces interpolable Euler keyframes', () => {
  it('a rotation sitting on a branch cut does not sweep a turn between keys', async () => {
    const { ops } = await buildGltfImportOps(
      { buffer: synthesiseAnimatedGlb(), assetRef: 'gate-876', sceneNodeId: 'n_scene' },
      emptyDagState(),
    );

    const clips = ops.filter(
      (o): o is Extract<typeof o, { type: 'addNode' }> =>
        o.type === 'addNode' && o.nodeType === 'TransformClip',
    );
    // The fixture must actually reach the code under test.
    expect(clips.length).toBe(1);

    const keyframes = (clips[0].params as { keyframes: { rotation: number[]; time: number }[] })
      .keyframes;
    expect(keyframes.length).toBe(QUATS.length);

    // The property: what the LINEAR consumer traverses between two keys must not
    // exceed the actual angular distance between them. Measured the way
    // TransformClip samples — component-wise lerp of the Euler triple.
    let worstTravel = 0;
    let worstEndpoints = 0;
    let checked = 0;
    for (let i = 0; i < keyframes.length - 1; i++) {
      const a = keyframes[i].rotation;
      const b = keyframes[i + 1].rotation;
      const endpoints = angleDeg(a, b);
      let travel = 0;
      let prev = a;
      for (let s = 1; s <= 16; s++) {
        const u = s / 16;
        const cur = [0, 1, 2].map((k) => a[k] + (b[k] - a[k]) * u);
        travel += angleDeg(prev, cur);
        prev = cur;
      }
      checked++;
      if (travel > worstTravel) {
        worstTravel = travel;
        worstEndpoints = endpoints;
      }
    }

    expect(checked).toBe(QUATS.length - 1);
    // Adjacent keys here are ~3-6 deg apart. Canonical per-key conversion makes
    // the interpolant travel ~360 deg across the pole; the continuous one keeps
    // travel at the endpoint distance. Falsified against the restored prior
    // implementation, which reports 360.0 deg here.
    expect(
      worstTravel - worstEndpoints,
      `worst interval travelled ${worstTravel.toFixed(1)}° between keys ${worstEndpoints.toFixed(2)}° apart`,
    ).toBeLessThan(30);
  });
});
