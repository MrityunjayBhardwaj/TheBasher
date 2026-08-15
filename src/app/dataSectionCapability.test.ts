// dataSectionCapability — the gate (#498).
//
// The table declares ONE thing per (data kind, section): can that kind host the section,
// and if not, is that permanent or merely unbuilt. Everything else here is MEASURED against
// the code that already answers the neighbouring question, because a second declaration of
// something already derivable is exactly what goes stale.
//
// The load-bearing test is `agrees with modifierDataSource in both directions`. The two
// predicates answer different questions — can-it-ever vs can-it-now — so they are not a
// duplicated source of truth. But they CAN contradict, and a contradiction would be silent:
// the offer would be enabled where the accept refuses, which is the exact #377/#498 defect
// one level up. Asserting the correspondence over every union member is what makes that
// impossible rather than merely unlikely.
//
// REF: src/app/dataSectionCapability.ts; src/app/modifierGeometry.ts; issue #498.

import { describe, expect, it } from 'vitest';
import { modifierDataSource } from './modifierDataSource';
import {
  DATA_DEPENDENT_SECTIONS,
  OBJECT_DATA_KINDS,
  dataSectionCapability,
  sectionAppliesToData,
  type ObjectDataKind,
} from './dataSectionCapability';
import type { BakedMaterialSpec, ObjectData } from '../nodes/types';

const BAKED_MATERIAL: BakedMaterialSpec = {
  materialClass: 'standard',
  color: '#c81e5a',
  roughness: 0.4,
  metalness: 0.1,
  opacity: 1,
  transparent: false,
  emissive: '#000000',
  emissiveIntensity: 1,
  map: null,
  normalMap: null,
  roughnessMap: null,
  metalnessMap: null,
  aoMap: null,
  emissiveMap: null,
};

/**
 * One real value per `ObjectData` member.
 *
 * Typed as a total `Record` on purpose — this is the "guard the guard" half. A new kind
 * added to the union fails to compile HERE as well as in the table, so the sweep below
 * cannot silently keep passing over a stale five-sixths of the union.
 */
const FIXTURES: Record<ObjectDataKind, ObjectData> = {
  MeshData: {
    kind: 'MeshData',
    geometry: { key: 'box|1,1,1', descriptor: { kind: 'box', size: [1, 1, 1] } },
    material: null,
  },
  BakedData: {
    kind: 'BakedData',
    geometry: {
      key: 'baked|deadbeef-8',
      descriptor: { kind: 'baked', hash: 'deadbeef', vertexCount: 8 },
    },
    material: BAKED_MATERIAL,
  },
  ModifiedData: {
    kind: 'ModifiedData',
    geometry: {
      key: 'array|box|1,1,1|3',
      descriptor: {
        kind: 'array',
        source: { key: 'box|1,1,1', descriptor: { kind: 'box', size: [1, 1, 1] } },
        count: 3,
        offset: [2, 0, 0],
      },
    },
    material: null,
  },
  CurveData: {
    kind: 'CurveData',
    points: [
      [0, 0, 0],
      [1, 0, 0],
    ],
    samples: [
      [0, 0, 0],
      [1, 0, 0],
    ],
    closed: false,
  },
  LightData: {
    kind: 'LightData',
    light: 'Point',
    intensity: 1,
    color: '#ffffff',
    distance: 0,
    decay: 2,
    angle: 0.5,
    penumbra: 0,
    width: 1,
    height: 1,
    target: [0, 0, 0],
    lookAt: [0, 0, 0],
  },
  CameraData: {
    kind: 'CameraData',
    projection: 'Perspective',
    fov: 50,
    zoom: 1,
    near: 0.01,
    far: 500,
    sensorSize: 36,
    dofEnabled: false,
    focusDistance: 5,
    fStop: 2.8,
    focusOnTarget: false,
    lookAt: [0, 0, 0],
    roll: 0,
  },
};

describe('#498 dataSectionCapability', () => {
  it('classifies every ObjectData kind, and classifies nothing else', () => {
    // Guard the guard: an empty sweep would pass every assertion below vacuously.
    expect(OBJECT_DATA_KINDS.length).toBeGreaterThan(0);
    // #394 S3d added 'material'. The list is pinned as an EQUALITY rather than a floor
    // because a section silently leaving the table takes its whole column of answers
    // with it, and nothing else here would notice.
    expect(DATA_DEPENDENT_SECTIONS).toEqual(['modifier', 'material']);

    const fixtureKinds = Object.keys(FIXTURES).sort();
    expect([...OBJECT_DATA_KINDS].sort()).toEqual(fixtureKinds);

    // …and each fixture really is the kind it is filed under (a copy-paste in the table
    // above would otherwise make the sweep test one kind twice and skip another).
    for (const kind of OBJECT_DATA_KINDS) {
      expect(FIXTURES[kind].kind).toBe(kind);
    }
  });

  it('agrees with modifierDataSource in both directions', () => {
    // THE anti-drift assertion. can-it-now must imply can-it-ever, and for the modifier
    // section the converse holds too: every kind this table calls 'supported' must be a
    // kind the modifier's own evaluate accepts. A future kind that is 'not-yet' would
    // break the converse legitimately, so that direction is asserted per state rather
    // than blanket — see the explicit split below.
    for (const kind of OBJECT_DATA_KINDS) {
      const acceptsNow = modifierDataSource(FIXTURES[kind]) !== null;
      const cap = dataSectionCapability(kind, 'modifier');

      if (cap.state === 'supported') {
        expect(acceptsNow, `${kind} is 'supported' but modifierDataSource refuses it`).toBe(true);
      } else {
        expect(acceptsNow, `${kind} is '${cap.state}' but modifierDataSource accepts it`).toBe(
          false,
        );
      }
    }
  });

  it("every 'not-yet' names an issue and every 'never' gives a reason", () => {
    // The justified-opt-out list is the load-bearing half: a deliberate refusal and a
    // forgotten one are indistinguishable unless the meaning is written down.
    let notYet = 0;
    let never = 0;
    for (const section of DATA_DEPENDENT_SECTIONS) {
      for (const kind of OBJECT_DATA_KINDS) {
        const cap = dataSectionCapability(kind, section);
        if (cap.state === 'not-yet') {
          notYet++;
          expect(cap.issue, `${kind}/${section} 'not-yet' must name an issue`).toBeGreaterThan(0);
          expect(cap.reason.length).toBeGreaterThan(20);
        }
        if (cap.state === 'never') {
          never++;
          expect(
            cap.reason.length,
            `${kind}/${section} 'never' must give a reason`,
          ).toBeGreaterThan(20);
        }
      }
    }
    // Pin the census so a kind silently changing state is a red, not a shrug.
    // modifier: curve 'not-yet' (#349) + light/camera 'never'.
    // material: curve 'not-yet' (#528) + light/camera 'never'.
    expect({ notYet, never }).toEqual({ notYet: 2, never: 4 });
  });

  it('pins the measured Blender answer per kind', () => {
    // Measured on Blender 5.1.1, not assumed: obj.modifiers.new('ARRAY') returns a
    // modifier on a mesh and a curve, and None on a camera and a light.
    expect(dataSectionCapability('MeshData', 'modifier').state).toBe('supported');
    expect(dataSectionCapability('BakedData', 'modifier').state).toBe('supported');
    expect(dataSectionCapability('ModifiedData', 'modifier').state).toBe('supported');
    expect(dataSectionCapability('CurveData', 'modifier').state).toBe('not-yet');
    expect(dataSectionCapability('LightData', 'modifier').state).toBe('never');
    expect(dataSectionCapability('CameraData', 'modifier').state).toBe('never');
  });

  it('pins the measured Blender answer per kind for the material section', () => {
    // #394 S3d. Read off the Blender 5.1 Python API reference, property by property —
    // a datablock either declares `materials` or it does not, which is a stronger
    // signal than a poll result: bpy.types.Mesh.materials and bpy.types.Curve.materials
    // are both declared (the same `IDMaterials[Material]` collection), while
    // bpy.types.Light and bpy.types.Camera declare no such property at all.
    expect(dataSectionCapability('MeshData', 'material').state).toBe('supported');
    expect(dataSectionCapability('BakedData', 'material').state).toBe('supported');
    expect(dataSectionCapability('ModifiedData', 'material').state).toBe('supported');
    expect(dataSectionCapability('CurveData', 'material').state).toBe('not-yet');
    expect(dataSectionCapability('LightData', 'material').state).toBe('never');
    expect(dataSectionCapability('CameraData', 'material').state).toBe('never');
  });

  it('keeps the two sections from collapsing into one answer', () => {
    // Guard against the cheapest way this table could go wrong: a second column that is
    // a copy of the first would satisfy every per-kind pin above AND the census, because
    // the two sections happen to partition the kinds the same way today. What must
    // differ is the ISSUE a 'not-yet' names — the curve's modifier gap (#349) and its
    // material gap (#528) are separate pieces of work, and a copied column would file
    // one under the other.
    const mod = dataSectionCapability('CurveData', 'modifier');
    const mat = dataSectionCapability('CurveData', 'material');
    expect(mod.state).toBe('not-yet');
    expect(mat.state).toBe('not-yet');
    if (mod.state !== 'not-yet' || mat.state !== 'not-yet') throw new Error('unreachable');
    expect(mat.issue).not.toBe(mod.issue);
  });

  it('offers the section for supported and not-yet, and withholds it only for never', () => {
    // The curve keeps its affordance ON PURPOSE. Hiding it would encode a tracked gap
    // (#349) as an intentional design decision, which is the thing #498 warns against.
    //
    // #394 S4 — SWEPT OVER BOTH COLUMNS rather than spot-checked on 'modifier'. The
    // spot-check version tested four of twelve cells and none of the material ones, so
    // a material column whose offer decision disagreed with its state would have passed.
    // Derived from the state rather than re-listed per kind, because a second hand-written
    // list of "which kinds offer it" is the exact thing this function exists to prevent.
    let offered = 0;
    let withheld = 0;
    for (const section of DATA_DEPENDENT_SECTIONS) {
      for (const kind of OBJECT_DATA_KINDS) {
        const state = dataSectionCapability(kind, section).state;
        const applies = sectionAppliesToData(kind, section);
        expect(applies, `${kind}/${section} is '${state}' but offers=${applies}`).toBe(
          state !== 'never',
        );
        if (applies) offered++;
        else withheld++;
      }
    }
    // Guard the guard, and pin the split so a column emptying cannot pass vacuously:
    // 12 cells = 2 sections × 6 kinds; 4 are 'never' (light + camera, both sections).
    expect({ offered, withheld }).toEqual({ offered: 8, withheld: 4 });
  });

  it('MATERIAL: "supported" means the VALUE carries a material field, both directions', () => {
    // #394 S4 — the material column's anti-drift gate, and it is NOT the modifier
    // column's. `canWearMaterial` (modifierGeometry.ts:233-236) READS this table, so
    // asserting the two agree would be a tautology — unlike `modifierDataSource`, there
    // is no independent resolver to check against. The independent fact is the VALUE:
    // a material operator composes onto `data.material`, so a kind this table calls
    // 'supported' must be a kind whose value actually has that field to compose onto,
    // and a kind that has one must not be refused.
    //
    // ⚠️ PLAN S4 asked for "wherever the table says supported, a `material` SOCKET
    // exists". Measured at head, that is false and should be: only `BoxData` and
    // `SphereData` declare a `material` socket, while `BakedData` is 'supported' and
    // declares none (it carries a CAPTURED `BakedMaterialSpec` on its value) and the
    // three `ModifiedData` producers inherit through their source. The socket is one way
    // a material ARRIVES; the field is what every one of them lands in, which is why the
    // field is the property the lane actually depends on.
    let withField = 0;
    for (const kind of OBJECT_DATA_KINDS) {
      const value = FIXTURES[kind] as { material?: unknown };
      const hasMaterialField = 'material' in value;
      const state = dataSectionCapability(kind, 'material').state;
      expect(
        hasMaterialField,
        `${kind} is '${state}' but ${hasMaterialField ? 'has' : 'has no'} material field`,
      ).toBe(state === 'supported');
      if (hasMaterialField) withField++;
    }
    // Non-vacuous in BOTH directions — 3 kinds carry the field, 3 do not. A sweep that
    // landed all on one side would satisfy the equivalence and prove only one arm of it.
    expect(withField).toBe(3);
    expect(OBJECT_DATA_KINDS.length - withField).toBe(3);
  });

  it('returns a stable reference so callers can memoize on it', () => {
    // sectionsOf caches on Object.is; a table that allocated per call would re-render
    // the inspector on every unrelated store change.
    expect(dataSectionCapability('CameraData', 'modifier')).toBe(
      dataSectionCapability('CameraData', 'modifier'),
    );
  });
});
