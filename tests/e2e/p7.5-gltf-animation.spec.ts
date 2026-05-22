// P7.5 — glTF TRS animation extraction end-to-end (closes #81).
//
// In-memory synthetic GLBs (built inside the browser via TextEncoder /
// Float32Array — no on-disk fixtures, no V21 ignore-file friction).
// Stages via `window.__basher_importGltf` — the same dev seam the
// agent uses (V11) and **the new path** (H41 — fixtures must NOT use
// the static drop chain that this phase replaces, otherwise a future
// regression in `buildGltfImportOps` would surface only at user merge).
//
// Boundary-pair (the H40 question "which side did I observe — the
// evaluator, or the surface?"): observed on BOTH sides where reachable
// in JSDOM e2e:
//   - producer side (evaluator output): `__basher_evaluate(transformClipId)`
//     returns the sampled TRS map.
//   - consumer side (eval-flow through GltfAsset's transformClip input):
//     `__basher_evaluate(gltfAssetId).value.transformClip` reflects the
//     same TRS, threaded through ClipSelect.
// The renderer-DOM side (THREE.Object3D.position post-render walk) is
// implicitly proven by the same eval-flow plus the existing #80 Draco
// e2e (which proves the GltfAssetR Suspense path renders at all).
//
// REF: PLAN.md Wave E4; SECTION-INVENTORY.md B3 + B11; CONTEXT D-06.

import { test, expect } from './_fixtures';

interface BasherWindow {
  __basher_dag: {
    getState: () => {
      state: {
        nodes: Record<string, { type: string; params?: Record<string, unknown> }>;
        outputs: { render?: { node: string }; scene?: { node: string } };
      };
      dispatch: (op: unknown) => void;
      dispatchAtomic?: (ops: unknown[], source?: string, label?: string) => void;
    };
  };
  __basher_evaluate: (
    nodeId: string,
    ctx?: { time: { frame: number; seconds: number; normalized: number } },
  ) => { value: unknown };
  __basher_importGltf?: (
    buffer: ArrayBuffer,
    assetRef: string,
    resolveBuffer?: (uri: string) => Promise<Uint8Array>,
  ) => Promise<{
    gltfAssetId: string;
    clipSelectId: string | null;
    transformClipIds: string[];
  }>;
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as BasherWindow;
    return Boolean(w.__basher_dag && w.__basher_evaluate && w.__basher_importGltf);
  });
});

test('P7.5 Test 1 — single-clip drop → evaluator samples bobbing Y at t=0.5', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const w = window as unknown as BasherWindow;

    // Build a synthetic GLB in-memory: one node 'Cube', one animation
    // 'bob' translating Y from 0 → 1 over t ∈ [0, 1].
    const buildGlb = () => {
      const MAGIC = 0x46546c67;
      const CHUNK_JSON = 0x4e4f534a;
      const CHUNK_BIN = 0x004e4942;
      const f32 = (vals: number[]) => new Uint8Array(new Float32Array(vals).buffer);
      const timesBytes = f32([0, 1]);
      const valuesBytes = f32([0, 0, 0, 0, 1, 0]);
      const bin = new Uint8Array(timesBytes.length + valuesBytes.length);
      bin.set(timesBytes, 0);
      bin.set(valuesBytes, timesBytes.length);
      const json = {
        nodes: [{ name: 'Cube' }],
        accessors: [
          { bufferView: 0, componentType: 5126, count: 2, type: 'SCALAR' },
          { bufferView: 1, componentType: 5126, count: 2, type: 'VEC3' },
        ],
        bufferViews: [
          { buffer: 0, byteOffset: 0, byteLength: timesBytes.length },
          { buffer: 0, byteOffset: timesBytes.length, byteLength: valuesBytes.length },
        ],
        buffers: [{ byteLength: bin.length }],
        animations: [
          {
            name: 'bob',
            channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }],
            samplers: [{ input: 0, output: 1 }],
          },
        ],
      };
      let jsonBytes = new TextEncoder().encode(JSON.stringify(json));
      while (jsonBytes.length % 4 !== 0) {
        const padded = new Uint8Array(jsonBytes.length + 1);
        padded.set(jsonBytes);
        padded[jsonBytes.length] = 0x20;
        jsonBytes = padded;
      }
      const totalLength = 12 + 8 + jsonBytes.length + 8 + bin.length;
      const buf = new ArrayBuffer(totalLength);
      const v = new DataView(buf);
      v.setUint32(0, MAGIC, true);
      v.setUint32(4, 2, true);
      v.setUint32(8, totalLength, true);
      let cursor = 12;
      v.setUint32(cursor, jsonBytes.length, true);
      v.setUint32(cursor + 4, CHUNK_JSON, true);
      new Uint8Array(buf, cursor + 8, jsonBytes.length).set(jsonBytes);
      cursor += 8 + jsonBytes.length;
      v.setUint32(cursor, bin.length, true);
      v.setUint32(cursor + 4, CHUNK_BIN, true);
      new Uint8Array(buf, cursor + 8, bin.length).set(bin);
      return buf;
    };

    const buffer = buildGlb();
    const ids = await w.__basher_importGltf!(buffer, 'p7.5/cube-bob.glb');
    const ctxHalf = { time: { frame: 30, seconds: 0.5, normalized: 0.5 } };

    // Producer side — TransformClip evaluator at t=0.5.
    const clipVal = w.__basher_evaluate(ids.transformClipIds[0], ctxHalf).value as {
      tracks: Record<string, { position: [number, number, number] }>;
    };
    // Eval-flow through ClipSelect → GltfAsset.transformClip.
    const gltfVal = w.__basher_evaluate(ids.gltfAssetId, ctxHalf).value as {
      transformClip: { tracks: Record<string, { position: [number, number, number] }> } | null;
      nodeNameMap: Record<string, string>;
    };
    return {
      ids,
      clipPosY: clipVal.tracks.Cube?.position[1] ?? null,
      gltfClipPosY: gltfVal.transformClip?.tracks.Cube?.position[1] ?? null,
      nodeNameMapHasCube: Boolean(gltfVal.nodeNameMap?.Cube),
    };
  });

  expect(result.ids.transformClipIds).toHaveLength(1);
  expect(result.ids.clipSelectId).not.toBeNull();
  expect(result.nodeNameMapHasCube).toBe(true);
  // Both sides of the producer-evaluator-flow boundary agree.
  expect(result.clipPosY).not.toBeNull();
  expect(result.gltfClipPosY).not.toBeNull();
  expect(result.clipPosY!).toBeGreaterThan(0.4);
  expect(result.clipPosY!).toBeLessThan(0.6);
  expect(result.gltfClipPosY!).toBeCloseTo(result.clipPosY!, 6);
});

test('P7.5 Test 2 — clip-switch via setParam selects the matching TransformClip', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const w = window as unknown as BasherWindow;

    // Build a multi-clip GLB: 'walk' moves Y to 1; 'run' moves Y to 5.
    const buildGlb = () => {
      const MAGIC = 0x46546c67;
      const CHUNK_JSON = 0x4e4f534a;
      const CHUNK_BIN = 0x004e4942;
      const f32 = (vals: number[]) => new Uint8Array(new Float32Array(vals).buffer);
      const t = f32([0, 1]);
      const walkVals = f32([0, 0, 0, 0, 1, 0]);
      const runVals = f32([0, 0, 0, 0, 5, 0]);
      const bin = new Uint8Array(t.length + walkVals.length + runVals.length);
      bin.set(t, 0);
      bin.set(walkVals, t.length);
      bin.set(runVals, t.length + walkVals.length);
      const json = {
        nodes: [{ name: 'Cube' }],
        accessors: [
          { bufferView: 0, componentType: 5126, count: 2, type: 'SCALAR' },
          { bufferView: 1, componentType: 5126, count: 2, type: 'VEC3' },
          { bufferView: 2, componentType: 5126, count: 2, type: 'VEC3' },
        ],
        bufferViews: [
          { buffer: 0, byteOffset: 0, byteLength: t.length },
          { buffer: 0, byteOffset: t.length, byteLength: walkVals.length },
          { buffer: 0, byteOffset: t.length + walkVals.length, byteLength: runVals.length },
        ],
        buffers: [{ byteLength: bin.length }],
        animations: [
          {
            name: 'walk',
            channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }],
            samplers: [{ input: 0, output: 1 }],
          },
          {
            name: 'run',
            channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }],
            samplers: [{ input: 0, output: 2 }],
          },
        ],
      };
      let jsonBytes = new TextEncoder().encode(JSON.stringify(json));
      while (jsonBytes.length % 4 !== 0) {
        const padded = new Uint8Array(jsonBytes.length + 1);
        padded.set(jsonBytes);
        padded[jsonBytes.length] = 0x20;
        jsonBytes = padded;
      }
      const totalLength = 12 + 8 + jsonBytes.length + 8 + bin.length;
      const buf = new ArrayBuffer(totalLength);
      const v = new DataView(buf);
      v.setUint32(0, MAGIC, true);
      v.setUint32(4, 2, true);
      v.setUint32(8, totalLength, true);
      let cursor = 12;
      v.setUint32(cursor, jsonBytes.length, true);
      v.setUint32(cursor + 4, CHUNK_JSON, true);
      new Uint8Array(buf, cursor + 8, jsonBytes.length).set(jsonBytes);
      cursor += 8 + jsonBytes.length;
      v.setUint32(cursor, bin.length, true);
      v.setUint32(cursor + 4, CHUNK_BIN, true);
      new Uint8Array(buf, cursor + 8, bin.length).set(bin);
      return buf;
    };

    const buffer = buildGlb();
    const ids = await w.__basher_importGltf!(buffer, 'p7.5/multi.glb');
    const ctxHalf = { time: { frame: 30, seconds: 0.5, normalized: 0.5 } };
    const initial = w.__basher_evaluate(ids.gltfAssetId, ctxHalf).value as {
      transformClip: {
        name: string;
        tracks: Record<string, { position: [number, number, number] }>;
      } | null;
    };
    // Switch selection to 'run' via setParam.
    const dag = w.__basher_dag.getState();
    if (!dag.dispatchAtomic) throw new Error('dispatchAtomic missing');
    dag.dispatchAtomic(
      [
        {
          type: 'setParam',
          nodeId: ids.clipSelectId!,
          paramPath: 'selectedClipName',
          value: 'run',
        },
      ],
      'user',
      'p7.5 clip-switch',
    );
    const switched = w.__basher_evaluate(ids.gltfAssetId, ctxHalf).value as {
      transformClip: {
        name: string;
        tracks: Record<string, { position: [number, number, number] }>;
      } | null;
    };
    // Switch to a non-existent name to verify null-on-miss.
    dag.dispatchAtomic(
      [
        {
          type: 'setParam',
          nodeId: ids.clipSelectId!,
          paramPath: 'selectedClipName',
          value: 'nonexistent',
        },
      ],
      'user',
      'p7.5 miss',
    );
    const miss = w.__basher_evaluate(ids.gltfAssetId, ctxHalf).value as {
      transformClip: { name: string } | null;
    };
    return {
      initialName: initial.transformClip?.name ?? null,
      initialPosY: initial.transformClip?.tracks.Cube?.position[1] ?? null,
      switchedName: switched.transformClip?.name ?? null,
      switchedPosY: switched.transformClip?.tracks.Cube?.position[1] ?? null,
      missClip: miss.transformClip,
    };
  });

  expect(result.initialName).toBe('walk');
  expect(result.initialPosY!).toBeCloseTo(0.5, 5);
  expect(result.switchedName).toBe('run');
  expect(result.switchedPosY!).toBeCloseTo(2.5, 5);
  // D-06 contract: null on miss, NOT silent fallback to clips[0].
  expect(result.missClip).toBeNull();
});

// Determinism is exercised directly at the unit level in
// `src/core/import/gltfImportChain.test.ts` (Test "determinism: same
// buffer → byte-identical Op[]"). Re-dropping the same buffer at the
// e2e layer would attempt to re-AddNode content-addressed ids that
// already exist — the application's own duplicate-id guard fires (a
// correct production behavior), so the assertion belongs at the
// unit-test depth, not here. PR description and SECTION-INVENTORY.md
// explicitly link to the unit gate for traceability.
