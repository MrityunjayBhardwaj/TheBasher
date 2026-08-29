// Generate-and-rig, the compose action — and the first app-layer caller the rig
// road has ever had.
//
// Shaped after generateModel.test.ts: the assertions are about the SURFACE —
// which capability calls happen, in what order, what lands in the scene, and
// what reaches the banner — rather than about the generator's internals, which
// have their own tests in core.
//
// 🔑 THE TEST THAT CARRIES THE POINT IS `imports the RIGGED bytes, not the
// generated ones`. Both calls return a GLB. Importing the wrong one produces a
// scene that looks completely correct — a mesh, textured, in the right place —
// and is missing only the skeleton, which is the entire reason the action was
// invoked. Nothing else in the suite would notice.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDagStore } from '../../core/dag/store';
import { registerAllNodes } from '../../nodes/registerAll';
import { useAssetErrorStore } from '../stores/assetErrorStore';
import { StubModelGenerationCapability } from '../../core/modelgen';
import { StubRiggingCapability, STUB_RIG_BONES } from '../../core/rigging';
import type { RiggingCapability } from '../../core/rigging';

const generation = new StubModelGenerationCapability();
let rigging: RiggingCapability = new StubRiggingCapability();

// Override ONLY the capability getters. Replacing the whole boot module drops
// `getStorage`, which `ingestSingleFile` needs — and that failure is silent in
// the worst way: every call returns ok:false and every surface test goes red for
// a reason unrelated to the surface.
vi.mock('../boot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../boot')>()),
  getModelCapability: async () => generation,
  getRiggingCapability: async () => rigging,
}));

// Imported AFTER vi.mock so the module picks up the mocked boot.
import { generateRiggedCharacter, type RiggedCharacterProgress } from './generateRiggedCharacter';
import { getStorage } from '../boot';

const TEXT = { source: 'text', prompt: 'a stocky dwarf blacksmith' } as const;

function seedScene(): void {
  useDagStore.getState().hydrate({
    nodes: {
      n_scene: { id: 'n_scene', type: 'Scene', version: 1, params: {}, inputs: {} },
      n_time: { id: 'n_time', type: 'TimeSource', version: 1, params: {}, inputs: {} },
    },
    outputs: { scene: { node: 'n_scene', socket: 'out' } },
  });
}

beforeEach(() => {
  registerAllNodes();
  useAssetErrorStore.getState().clearAll();
  rigging = new StubRiggingCapability();
  seedScene();
});

describe('the happy road', () => {
  it('lands a rigged character and reports the spec that ARRIVED', async () => {
    const result = await generateRiggedCharacter(TEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.opfsPath).toMatch(/\.glb$/);
    // Read off the returned bytes, never from the request. A result echoing the
    // spec it ASKED for is a label, and a label can be wrong while every test
    // that reads it passes.
    expect(result.arrivedSpec).toBe('mixamo');
    expect(STUB_RIG_BONES.length).toBeGreaterThan(0);
  });

  it('writes the RIGGED bytes to OPFS, not the generated ones', async () => {
    // Both capabilities return a GLB; only one of them has a skin. Importing the
    // wrong one yields a scene that looks entirely correct — mesh, texture,
    // placement — and is missing only the skeleton, which is the whole reason
    // the action was invoked. Nothing else in the suite would notice.
    const rigSpy = vi.spyOn(rigging, 'rig');
    const genSpy = vi.spyOn(generation, 'generate');

    const result = await generateRiggedCharacter(TEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rigged = new Uint8Array(
      await rigSpy.mock.results[0].value.then((r: { glb: ArrayBuffer }) => r.glb),
    );
    const generated = new Uint8Array(
      await genSpy.mock.results[0].value.then((r: { glb: ArrayBuffer }) => r.glb),
    );
    // Non-vacuous: the two buffers genuinely differ, so "the rigged one landed"
    // is a real distinction rather than a claim identical bytes satisfy anyway.
    expect(rigged).not.toEqual(generated);

    // What actually reached disk, read back through the storage the import road
    // reads from — not the value the action happened to hold in a variable.
    const storage = await getStorage();
    const onDisk = await storage.read(result.opfsPath);
    expect(onDisk).toEqual(rigged);
    expect(onDisk).not.toEqual(generated);
  });

  it('rigs the task the generation produced — the only subject the service accepts', async () => {
    const rigSpy = vi.spyOn(rigging, 'rig');
    const checkSpy = vi.spyOn(rigging, 'checkRiggable');
    const result = await generateRiggedCharacter(TEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 🔑 `RigSubject` is `{ sourceTaskId }` — Tripo rigs a TASK, not a mesh. The
    // id must be the generation's own, and it must be the SAME one both calls
    // use, or the pre-check answers about a different mesh than the one rigged.
    expect(checkSpy.mock.calls[0][0]).toEqual({ sourceTaskId: result.taskId });
    expect(rigSpy.mock.calls[0][0].sourceTaskId).toBe(result.taskId);
  });

  it('a skeleton in a FOREIGN vocabulary is reported as unknown, not as what was asked for', async () => {
    // 🔑 THE DISCRIMINATING CASE, and without it the `arrivedSpec` assertion
    // above is vacuous: the stub returns mixamo AND we request mixamo, so an
    // implementation that simply echoed `requestedSpec` would pass it. Here the
    // request and the result disagree, and only reading the bytes gets it right.
    // This is exactly the live failure that cost a rig — the newer auto-rigging
    // model echoes `spec: mixamo` back and returns `tripo::`-prefixed joints.
    const foreign = await new StubRiggingCapability().rig({ sourceTaskId: 't', spec: 'tripo' });
    vi.spyOn(rigging, 'rig').mockResolvedValue({
      ...foreign,
      glb: glbWithBoneNames(['tripo::Root', 'tripo::0_Left_Limb_0', 'tripo::Spine']),
      requestedSpec: 'mixamo',
    });

    const result = await generateRiggedCharacter(TEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.arrivedSpec).toBe('unknown');
  });

  it('asks for mixamo by default, which is what the retarget road expects', async () => {
    const rigSpy = vi.spyOn(rigging, 'rig');
    await generateRiggedCharacter(TEXT);
    expect(rigSpy.mock.calls[0][0].spec).toBe('mixamo');
  });

  it('reports each phase, so a two-task wait is legible', async () => {
    const seen: RiggedCharacterProgress[] = [];
    await generateRiggedCharacter(TEXT, { onProgress: (p) => seen.push(p) });
    const phases = seen.map((p) => p.phase);
    // Order matters: the pre-check runs BEFORE the rig, because a rig is
    // billable and a refusal should cost nothing.
    expect(phases.indexOf('generating')).toBeLessThan(phases.indexOf('checking'));
    expect(phases.indexOf('checking')).toBeLessThan(phases.indexOf('rigging'));
    expect(phases).toContain('importing');
  });
});

describe('the refusals', () => {
  it('a mesh the service will not rig costs no rig call', async () => {
    vi.spyOn(rigging, 'checkRiggable').mockResolvedValue({
      taskId: 'c1',
      riggable: false,
      detectedRigType: 'others',
    });
    const rigSpy = vi.spyOn(rigging, 'rig');

    const result = await generateRiggedCharacter(TEXT);
    expect(result.ok).toBe(false);
    // The load-bearing half: the SECOND billable call never happened.
    expect(rigSpy).not.toHaveBeenCalled();
    expect(result.ok === false && result.reason).toContain('others');
  });

  it('a pre-check that did not answer says so, rather than naming a body plan', async () => {
    vi.spyOn(rigging, 'checkRiggable').mockResolvedValue({
      taskId: 'c1',
      riggable: false,
      // `null` means the service did not say — which is NOT the same as `others`,
      // and collapsing them turns "I could not tell" into a positive claim.
      detectedRigType: null,
    });
    const result = await generateRiggedCharacter(TEXT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('did not say');
    expect(result.reason).not.toContain('others');
    expect(result.reason).not.toContain('biped');
  });

  it('a failure reaches the banner, never console-only', async () => {
    vi.spyOn(rigging, 'rig').mockRejectedValue(new Error('transport exploded'));
    const result = await generateRiggedCharacter(TEXT, { name: 'dwarf' });
    expect(result.ok).toBe(false);
    expect(useAssetErrorStore.getState().errors.dwarf).toContain('transport exploded');
  });

  it('never throws — the surface that invoked it must be able to return to idle', async () => {
    vi.spyOn(generation, 'generate').mockRejectedValue(new Error('boom'));
    await expect(generateRiggedCharacter(TEXT)).resolves.toEqual({
      ok: false,
      reason: 'boom',
    });
  });
});

/**
 * A minimal GLB whose JSON chunk declares a skin over nodes with the given
 * names. Built here rather than byte-patched: a same-width substitution inside a
 * binary container silently changes its length, and the resulting file parses as
 * something else entirely.
 */
function glbWithBoneNames(names: readonly string[]): ArrayBuffer {
  const json = JSON.stringify({
    asset: { version: '2.0' },
    nodes: names.map((name) => ({ name })),
    skins: [{ joints: names.map((_, i) => i) }],
  });
  const jsonBytes = new TextEncoder().encode(json);
  // Chunks are 4-byte aligned; pad with spaces, which JSON ignores.
  const padded = new Uint8Array(Math.ceil(jsonBytes.length / 4) * 4).fill(0x20);
  padded.set(jsonBytes);

  const total = 12 + 8 + padded.length;
  const buffer = new ArrayBuffer(total);
  const view = new DataView(buffer);
  view.setUint32(0, 0x46546c67, true); // "glTF"
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, padded.length, true);
  view.setUint32(16, 0x4e4f534a, true); // "JSON"
  new Uint8Array(buffer).set(padded, 20);
  return buffer;
}
