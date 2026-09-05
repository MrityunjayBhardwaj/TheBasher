// #921 — what the bone-map editor draws, asserted without mounting anything.
//
// The fixtures build a real SOMA→glTF retarget: a source rig whose `LeftLeg` is the
// THIGH against a target rig whose `LeftLeg` would be the SHIN. That collision is
// the reason this editor exists (boneNameMaps.ts:138), so it is the fixture rather
// than a synthetic a/b/c — a row list that cannot show it is not worth drawing.

import { describe, expect, it } from 'vitest';
import { boneMapView, elidePrefix, mapWithRow, sharedPrefix } from './boneMapRows';
import type { GraphNodeLike } from './graphNodes';

function bone(name: string, parent = -1) {
  return { name, parent, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
}

/** SOMA-side names, in parentage order: LeftLeg is the thigh here. */
const SOURCE_BONES = [
  bone('Hips'),
  bone('LeftLeg', 0),
  bone('LeftShin', 1),
  bone('LeftFoot', 2),
  bone('Neck2', 0),
];

/** glTF humanoid target. */
const TARGET_BONES = [bone('hips'), bone('thigh.L', 0), bone('shin.L', 1), bone('foot.L', 2)];

const CORRECT_MAP: Record<string, string> = {
  Hips: 'hips',
  LeftLeg: 'thigh.L',
  LeftShin: 'shin.L',
  LeftFoot: 'foot.L',
};

function graph(map: Record<string, string>, extra: Record<string, GraphNodeLike> = {}) {
  const nodes: Record<string, GraphNodeLike> = {
    srcRig: { id: 'srcRig', type: 'Skeleton', params: { bones: SOURCE_BONES }, inputs: {} },
    tgtRig: { id: 'tgtRig', type: 'Skeleton', params: { bones: TARGET_BONES }, inputs: {} },
    clip: {
      id: 'clip',
      type: 'AnimationClip',
      params: { name: 'walk', duration: 1, keyframes: [{ bone: 0, time: 0 }] },
      inputs: { skeleton: { node: 'srcRig' } },
    },
    map1: { id: 'map1', type: 'BoneNameMap', params: { name: 'bridge', map }, inputs: {} },
    rt: {
      id: 'rt',
      type: 'RetargetClip',
      params: { name: 'retargeted' },
      inputs: {
        sourceClip: { node: 'clip' },
        boneMap: { node: 'map1' },
        skeleton: { node: 'tgtRig' },
      },
    },
    ...extra,
  } as unknown as Record<string, GraphNodeLike>;
  return nodes;
}

describe('boneMapView — the rows a director reads', () => {
  it('gives every source bone a row, mapped or not', () => {
    const v = boneMapView(graph(CORRECT_MAP), 'rt');
    expect(v).not.toBeNull();
    expect(v!.rows).toHaveLength(SOURCE_BONES.length);
    expect(v!.rows.map((r) => r.source).sort()).toEqual(
      ['Hips', 'LeftFoot', 'LeftLeg', 'LeftShin', 'Neck2'].sort(),
    );
  });

  it('a source bone with no entry reads unmapped, not absent', () => {
    const v = boneMapView(graph(CORRECT_MAP), 'rt')!;
    const neck = v.rows.find((r) => r.source === 'Neck2')!;
    expect(neck.state).toBe('unmapped');
    expect(neck.target).toBeNull();
    expect(v.unmappedCount).toBe(1);
  });

  it('an entry naming a bone the target rig lacks reads DANGLING, not mapped', () => {
    // The SOMA trap, spelled: LeftLeg sent to a target name that does not exist.
    const v = boneMapView(graph({ ...CORRECT_MAP, LeftLeg: 'LeftLeg' }), 'rt')!;
    const row = v.rows.find((r) => r.source === 'LeftLeg')!;
    expect(row.state).toBe('dangling');
    expect(row.target).toBe('LeftLeg');
    expect(v.danglingCount).toBe(1);
    // …and it must NOT be counted as driving anything.
    expect(v.drivenTargets).toBe(3);
  });

  it('counts TARGET coverage — the number that predicts a frozen limb', () => {
    const v = boneMapView(graph(CORRECT_MAP), 'rt')!;
    expect(v.drivenTargets).toBe(4);
    expect(v.targetTotal).toBe(4);
  });

  it('two source bones sent to one target count that target ONCE', () => {
    const v = boneMapView(graph({ ...CORRECT_MAP, Neck2: 'hips' }), 'rt')!;
    expect(v.drivenTargets).toBe(4);
    expect(v.rows.filter((r) => r.state === 'mapped')).toHaveLength(5);
  });

  it('sorts what needs attention to the top, keeping rig order inside a group', () => {
    const v = boneMapView(graph({ ...CORRECT_MAP, LeftShin: 'nope' }), 'rt')!;
    expect(v.rows[0].state).toBe('dangling');
    expect(v.rows[1].state).toBe('unmapped');
    // Hips before LeftLeg: parentage order survives the sort.
    const mapped = v.rows.filter((r) => r.state === 'mapped').map((r) => r.source);
    expect(mapped).toEqual(['Hips', 'LeftLeg', 'LeftFoot']);
  });

  it('keeps a map entry whose SOURCE bone the rig does not carry', () => {
    // A map written for another clip. Dropping it would hide why the counts differ.
    const v = boneMapView(graph({ ...CORRECT_MAP, Tail: 'tail' }), 'rt')!;
    const orphan = v.rows.find((r) => r.source === 'Tail');
    expect(orphan).toBeDefined();
    expect(orphan!.state).toBe('orphan');
  });

  it('an ORPHAN with a perfectly valid target is still not driving anything', () => {
    // Self-review found this reading as an ordinary `mapped` row: its target exists,
    // so it looked healthy AND was counted in coverage — overstating the one number
    // the panel leads with. No keyframe addresses a bone the source rig lacks.
    const v = boneMapView(graph({ ...CORRECT_MAP, Tail: 'foot.L' }), 'rt')!;
    const orphan = v.rows.find((r) => r.source === 'Tail')!;
    expect(orphan.state).toBe('orphan');
    expect(v.drivenTargets).toBe(4); // NOT 5 — foot.L was already driven by LeftFoot
  });

  it('an orphan naming an otherwise-undriven target does not inflate coverage', () => {
    const v = boneMapView(graph({ Hips: 'hips', Tail: 'thigh.L' }), 'rt')!;
    expect(v.drivenTargets).toBe(1);
  });

  it('offers the target rig its own joint names, in rig order', () => {
    const v = boneMapView(graph(CORRECT_MAP), 'rt')!;
    expect(v.targetBoneNames).toEqual(['hips', 'thigh.L', 'shin.L', 'foot.L']);
  });
});

describe('boneMapView — provenance is derived, never stored', () => {
  it('an entry the auto-map would not propose reads EDITED', () => {
    // thigh.L → foot.L is nobody's proposal.
    const v = boneMapView(graph({ ...CORRECT_MAP, LeftLeg: 'foot.L' }), 'rt')!;
    expect(v.rows.find((r) => r.source === 'LeftLeg')!.origin).toBe('edited');
  });

  it('the same map read twice gives the same provenance — no hidden state', () => {
    const a = boneMapView(graph(CORRECT_MAP), 'rt')!;
    const b = boneMapView(graph(CORRECT_MAP), 'rt')!;
    expect(a.rows.map((r) => r.origin)).toEqual(b.rows.map((r) => r.origin));
  });
});

describe('boneMapView — the shared-map surprise', () => {
  it('names the OTHER retargets reading this map node', () => {
    const nodes = graph(CORRECT_MAP, {
      rt2: {
        id: 'rt2',
        type: 'RetargetClip',
        params: { name: 'other' },
        inputs: { boneMap: { node: 'map1' } },
      } as unknown as GraphNodeLike,
    });
    const v = boneMapView(nodes, 'rt')!;
    expect(v.sharedWith).toEqual(['rt2']);
  });

  it('a retarget on its own map is not "shared"', () => {
    const nodes = graph(CORRECT_MAP, {
      map2: {
        id: 'map2',
        type: 'BoneNameMap',
        params: { name: 'other', map: {} },
        inputs: {},
      } as unknown as GraphNodeLike,
      rt2: {
        id: 'rt2',
        type: 'RetargetClip',
        params: { name: 'other' },
        inputs: { boneMap: { node: 'map2' } },
      } as unknown as GraphNodeLike,
    });
    expect(boneMapView(nodes, 'rt')!.sharedWith).toEqual([]);
  });
});

describe('boneMapView — a half-wired graph answers null, not an empty table', () => {
  it('null when no map node is wired', () => {
    const nodes = graph(CORRECT_MAP);
    (nodes.rt as { inputs: Record<string, unknown> }).inputs = {
      sourceClip: { node: 'clip' },
      skeleton: { node: 'tgtRig' },
    };
    expect(boneMapView(nodes, 'rt')).toBeNull();
  });

  it('null when the target rig has no bones', () => {
    const nodes = graph(CORRECT_MAP);
    (nodes.tgtRig as { params: Record<string, unknown> }).params = { bones: [] };
    expect(boneMapView(nodes, 'rt')).toBeNull();
  });

  it('null for a node that is not a RetargetClip', () => {
    expect(boneMapView(graph(CORRECT_MAP), 'map1')).toBeNull();
  });

  it('DRAWS for a clip with no keyframes — that is when the map most needs fixing', () => {
    const nodes = graph(CORRECT_MAP);
    (nodes.clip as { params: Record<string, unknown> }).params = {
      name: 'walk',
      duration: 1,
      keyframes: [],
    };
    expect(boneMapView(nodes, 'rt')).not.toBeNull();
  });
});

describe('sharedPrefix — the redundant half is what gives way', () => {
  it('finds the convention prefix a Mixamo rig puts on its joints', () => {
    // Observed in the app: at ~300px every option rendered `mixamorig_L…`, so
    // LeftLeg and LeftUpLeg were the same label. This is the fix.
    expect(sharedPrefix(['mixamorig_LeftLeg', 'mixamorig_LeftUpLeg', 'mixamorig_Hips'])).toBe(
      'mixamorig_',
    );
  });

  it('SURVIVES the one bone outside the convention — the measured failure', () => {
    // A real Tripo rig: 22 `mixamorig_*` joints and a bare `Root`. Requiring a prefix
    // shared by ALL of them returned '' and elided nothing.
    expect(sharedPrefix(['Root', 'mixamorig_Hips', 'mixamorig_Spine', 'mixamorig_LeftLeg'])).toBe(
      'mixamorig_',
    );
  });

  it('refuses when only a MINORITY follow the convention', () => {
    expect(sharedPrefix(['a', 'b', 'c', 'mixamorig_Hips'])).toBe('');
  });

  it('never returns a prefix that would leave a name with nothing to show', () => {
    expect(sharedPrefix(['mixamorig_', 'mixamorig_Hips'])).not.toBe('mixamorig_Hips');
    expect(sharedPrefix(['hips', 'hips'])).toBe('');
  });

  it('is empty when the names carry no separator convention', () => {
    expect(sharedPrefix(['hips', 'thigh', 'shin'])).toBe('');
  });

  it('is empty for a single name — there is no redundancy to remove', () => {
    expect(sharedPrefix(['mixamorig_Hips'])).toBe('');
  });

  it('the view offers FULL names even while the prefix is elided', () => {
    const v = boneMapView(graph(CORRECT_MAP), 'rt')!;
    expect(v.targetBoneNames).toContain('thigh.L');
  });

  it('the SOURCE column gets the same treatment — the defect is symmetric', () => {
    // A Mixamo-authored clip: every row would read `mixamorig_…` and truncate.
    // NOTE the fixture has to CARRY a prefix. The first version of this test asserted
    // `''` against the SOMA rig, which shares nothing — so it passed whether the
    // computation ran or not, and a falsifier that stubbed `sourcePrefix: ''` left it
    // green. An assertion that cannot discriminate is not a test.
    const nodes = graph(CORRECT_MAP);
    (nodes.srcRig as { params: Record<string, unknown> }).params = {
      bones: [bone('mixamorig_Hips'), bone('mixamorig_LeftLeg', 0), bone('mixamorig_LeftUpLeg', 0)],
    };
    expect(boneMapView(nodes, 'rt')!.sourcePrefix).toBe('mixamorig_');
  });

  it('NEVER blanks the odd bone out — the measured defect', () => {
    // 22 `mixamorig_*` joints and a bare `Root`. An unguarded slice rendered `Root` as
    // an EMPTY option, which is a picker entry a director cannot read or choose.
    expect(elidePrefix('Root', 'mixamorig_')).toBe('Root');
    expect(elidePrefix('mixamorig_Hips', 'mixamorig_')).toBe('Hips');
    expect(elidePrefix('mixamorig_', 'mixamorig_')).toBe('mixamorig_');
    expect(elidePrefix('Hips', '')).toBe('Hips');
  });

  it('and stays empty for a source rig with no convention', () => {
    expect(boneMapView(graph(CORRECT_MAP), 'rt')!.sourcePrefix).toBe('');
  });
});

describe('mapWithRow — the write is the whole record', () => {
  it('sets an entry', () => {
    expect(mapWithRow({ a: 'x' }, 'b', 'y')).toEqual({ a: 'x', b: 'y' });
  });

  it('a null target REMOVES the entry rather than storing an empty string', () => {
    expect(mapWithRow({ a: 'x', b: 'y' }, 'b', null)).toEqual({ a: 'x' });
  });

  it('an empty target removes it too — a blank picker means "no target"', () => {
    expect(mapWithRow({ a: 'x' }, 'a', '')).toEqual({});
  });

  it('does not mutate the map it was given', () => {
    const before = { a: 'x' };
    mapWithRow(before, 'a', 'z');
    expect(before).toEqual({ a: 'x' });
  });

  it('survives a source bone name containing a dot', () => {
    // The measured reason this writes a whole record: `setAtPath` splits on '.',
    // so a subpath write of `map.spine.001` would build a nested object.
    expect(mapWithRow({}, 'spine.001', 'spine.001')).toEqual({ 'spine.001': 'spine.001' });
  });
});
