// The two decisions a drop has to make on the director's behalf — #807.
//
// Both are pure over a DagState, which is the reason they were lifted out of the
// binding at all: "which character" and "which bridge" are the parts that can be
// silently wrong, and a decision only reachable through a DOM drop event is a
// decision nobody can test.

import { describe, expect, it, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '../../test-utils/sourceScan';
import { registerAllNodes } from '../../nodes/registerAll';
import {
  chooseMotionTarget,
  motionTargetCandidates,
  retargetedClipId,
} from './bindMotionToCharacter';
import { getBoneNameMapPreset } from '../../core/import/boneNameMaps';
import { gltfSkeletonDagId } from '../../core/import/gltfImportChain';
import type { DagState } from '../../core/dag/state';
import type { Node } from '../../core/dag/types';
import type { GltfSkinMetadata } from '../../nodes/types';

beforeAll(() => {
  // The candidate scan EVALUATES each rig node, so the registry must be live.
  registerAllNodes();
});

/** A skin whose joints carry the given names — the only field the chooser reads. */
function skin(names: string[]): GltfSkinMetadata {
  return {
    jointKeys: names,
    bindTRS: names.map(() => ({
      position: [0, 0, 0] as [number, number, number],
      rotation: [0, 0, 0] as [number, number, number],
      scale: [1, 1, 1] as [number, number, number],
    })),
    parentJointIndex: names.map((_, i) => (i === 0 ? -1 : 0)),
    inverseBindMatrices: [],
  };
}

/** A character: a GltfAsset carrying one skin, plus the GltfSkeleton over it. */
function character(assetRef: string, boneNames: string[]): Node[] {
  const assetId = `asset_${assetRef}`;
  const skelId = gltfSkeletonDagId(assetRef, 0);
  return [
    {
      id: assetId,
      type: 'GltfAsset',
      version: 1,
      params: {
        assetRef,
        nodeNameMap: {},
        childHierarchy: {},
        skins: [skin(boneNames)],
      },
      inputs: {},
    },
    {
      id: skelId,
      type: 'GltfSkeleton',
      version: 1,
      params: { skinIndex: 0 },
      inputs: { asset: { node: assetId, socket: 'out' } },
    },
    // The import root a director actually clicks (#222) — it carries NO assetRef
    // of its own, which is why selection has to walk to reach the asset.
    {
      id: `grp_${assetRef}`,
      type: 'Group',
      version: 1,
      params: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      inputs: { children: [{ node: assetId, socket: 'out' }] },
    },
  ];
}

function stateOf(...nodes: Node[]): DagState {
  const map: Record<string, Node> = {};
  for (const n of nodes) map[n.id] = n;
  return { nodes: map, outputs: {} };
}

const MIXAMO = Object.values(getBoneNameMapPreset('somaToMixamo')!.map);

describe('motionTargetCandidates', () => {
  it('finds a character by its rig node and reads the bones off the projection', () => {
    const state = stateOf(...character('user-imports/dwarf/dwarf.glb', MIXAMO));
    const found = motionTargetCandidates(state);
    expect(found).toHaveLength(1);
    expect(found[0].label).toBe('dwarf');
    expect(found[0].boneNames).toEqual(MIXAMO);
  });

  it('skips a rig node whose asset projects no bones', () => {
    // The node exists and evaluates; it just has nothing to drive. Reporting it
    // as a candidate would turn a scene with no character into an ambiguity.
    const state = stateOf(...character('user-imports/box/box.glb', []));
    expect(motionTargetCandidates(state)).toEqual([]);
  });

  it('is stable in order, so an ambiguity always names candidates the same way', () => {
    const nodes = [
      ...character('user-imports/b/b.glb', MIXAMO),
      ...character('user-imports/a/a.glb', MIXAMO),
    ];
    const forward = motionTargetCandidates(stateOf(...nodes)).map((c) => c.skeletonId);
    const reversed = motionTargetCandidates(stateOf(...[...nodes].reverse())).map(
      (c) => c.skeletonId,
    );
    expect(forward).toEqual(reversed);
  });
});

describe('chooseMotionTarget', () => {
  it('refuses with the "no character" reason when the scene has no rig', () => {
    const result = chooseMotionTarget(stateOf(), null, 'imported');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toBe('no-character');
  });

  it('takes the only character without needing a selection', () => {
    const state = stateOf(...character('user-imports/dwarf/dwarf.glb', MIXAMO));
    const result = chooseMotionTarget(state, null, 'imported');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.target.label).toBe('dwarf');
  });

  it('refuses AND names both characters when two exist and nothing is selected', () => {
    const state = stateOf(
      ...character('user-imports/dwarf/dwarf.glb', MIXAMO),
      ...character('user-imports/elf/elf.glb', MIXAMO),
    );
    const result = chooseMotionTarget(state, null, 'imported');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toBe('ambiguous');
    // The names are the whole point of the message — a refusal that does not
    // say WHICH two is a refusal the director cannot act on.
    expect(result.reason).toContain('dwarf');
    expect(result.reason).toContain('elf');
  });

  it('breaks the tie on the selected import Group, which carries no assetRef', () => {
    // The selection a director can actually make. Matching on params.assetRef
    // alone would find nothing here and refuse a scene that is not ambiguous.
    const state = stateOf(
      ...character('user-imports/dwarf/dwarf.glb', MIXAMO),
      ...character('user-imports/elf/elf.glb', MIXAMO),
    );
    const result = chooseMotionTarget(state, 'grp_user-imports/elf/elf.glb', 'imported');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.target.label).toBe('elf');
  });

  // ── #823 — the refusals name the road the clip arrived by ──────────────────
  //
  // Three of these became reachable from the generation road when #820 gave a
  // generated clip the same continuation, and their wording was written for the
  // drop road. The middle one is why this matters: a director who typed a
  // sentence, got a clip, and was told to "drop it again" has been handed an
  // instruction with no gesture behind it.

  it('#823 — a generated clip is not described as Imported, on every refusal', () => {
    const none = chooseMotionTarget(stateOf(), null, 'generated');
    expect(none.ok).toBe(false);
    if (none.ok) return;
    expect(none.reason).toContain('Generated the motion');
    expect(none.reason, 'nothing was imported on this road').not.toContain('Imported');

    const two = chooseMotionTarget(
      stateOf(
        ...character('user-imports/dwarf/dwarf.glb', MIXAMO),
        ...character('user-imports/elf/elf.glb', MIXAMO),
      ),
      null,
      'generated',
    );
    expect(two.ok).toBe(false);
    if (two.ok) return;
    expect(two.reason).toContain('Generated the motion');
    expect(two.reason).not.toContain('Imported');
  });

  it('#823 — and is not told to perform a gesture that does not exist', () => {
    // The load-bearing row. "Drop it again" is advice with nothing behind it on
    // a road where no file was ever dropped; "generate again" is a gesture the
    // director just used to get here.
    const state = stateOf(
      ...character('user-imports/dwarf/dwarf.glb', MIXAMO),
      ...character('user-imports/elf/elf.glb', MIXAMO),
    );
    const generated = chooseMotionTarget(state, null, 'generated');
    expect(generated.ok).toBe(false);
    if (generated.ok) return;
    expect(generated.reason, 'there is no file to drop on the generation road').not.toContain(
      'drop it again',
    );
    expect(generated.reason).toContain('generate again');

    // ...and the drop road is unchanged, which is the other half of "one voice":
    // this fix must not have quietly reworded the road that was already right.
    const imported = chooseMotionTarget(state, null, 'imported');
    expect(imported.ok).toBe(false);
    if (imported.ok) return;
    expect(imported.reason).toContain('Imported the motion');
    expect(imported.reason).toContain('drop it again');

    // Both still name the candidates — the part of the message a director acts on.
    for (const r of [generated.reason, imported.reason]) {
      expect(r).toContain('dwarf');
      expect(r).toContain('elf');
    }
  });

  it('#823 — no refusal in this module hardcodes a road, including the one behind a store', () => {
    // The third refusal, `no-bridge`, lives inside `bindMotionToCharacter` and
    // needs the DAG and notification stores to reach, so the two rows above
    // cannot see it. This one can: the verb comes from the ARRIVAL table or it
    // is hardcoded, and hardcoded is exactly the defect. Reading the source is
    // the cheapest instrument that covers all three at once — and it keeps
    // covering a fourth refusal nobody has written yet.
    // COMMENTS STRIPPED FIRST. The doc comment above ARRIVAL quotes both phrases
    // while explaining them, and a scan that counted prose would red on the
    // explanation of the fix — which is a false positive of exactly the kind
    // that gets a gate switched off.
    const src = stripComments(
      readFileSync(resolve(process.cwd(), 'src/app/asset/bindMotionToCharacter.ts'), 'utf8'),
    );
    const from = src.indexOf('const ARRIVAL');
    expect(from, 'the ARRIVAL table is gone — this row is measuring nothing').toBeGreaterThan(-1);
    const table = src.slice(from, src.indexOf('};', from));
    const body = src.replace(table, '');
    for (const road of ['Imported the motion', 'Generated the motion', 'drop it again']) {
      expect(
        body.includes(road),
        `a refusal hardcodes "${road}" instead of composing it from the arrival — the wording ` +
          `is then right on one road and wrong on the other, which is #823`,
      ).toBe(false);
    }
    // ...and the table is where those words DO live, so this is not passing
    // because the strings were simply deleted.
    expect(table).toContain('Imported');
    expect(table).toContain('drop it again');
  });

  it('breaks the tie on the rig node itself', () => {
    const state = stateOf(
      ...character('user-imports/dwarf/dwarf.glb', MIXAMO),
      ...character('user-imports/elf/elf.glb', MIXAMO),
    );
    const elfSkel = gltfSkeletonDagId('user-imports/elf/elf.glb', 0);
    const result = chooseMotionTarget(state, elfSkel, 'imported');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.target.skeletonId).toBe(elfSkel);
  });
});

describe('retargetedClipId', () => {
  it('is derived from the PAIR, so one clip can drive two characters', () => {
    const a = retargetedClipId('n_bvh_clip', 'skel_dwarf');
    const b = retargetedClipId('n_bvh_clip', 'skel_elf');
    expect(a).not.toBe(b);
  });

  it('is stable, so re-binding the same pair addresses the same clip', () => {
    expect(retargetedClipId('n_bvh_clip', 'skel_dwarf')).toBe(
      retargetedClipId('n_bvh_clip', 'skel_dwarf'),
    );
  });
});
