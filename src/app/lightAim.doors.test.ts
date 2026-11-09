// #1765 — every road that gives a light a Track-To gives it an object to aim at: an empty named
// after the light, at the point it should face, hung where the light hangs (never under it).
//
// Two halves, because one alone cannot hold the door set:
//   1. A census of the SOURCE: every production file that mints a Track-To by literal is either a
//      light door (driven below) or a camera door, which is out of scope until the user decides
//      whether cameras follow. A new literal anywhere reds here until it is placed.
//   2. Each light door RUN: the Track-To it makes aims at a Null, at the expected world point,
//      named "….aim", not a child of the light. The one generic door — the constraint stack's
//      "+ Add", which mints `nodeType: constraintType`, no literal — is driven here too.
// The agent's `mutator.constrain` always names what to aim at, so it must NOT make an empty.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import { applyOp, type DagState } from '../core/dag';
import type { Op } from '../core/dag/types';
import { registerAllNodes } from '../nodes/registerAll';
import { buildDefaultDagState } from '../core/project/default';
import {
  buildExampleProject,
  CAPTURED_EXAMPLE_IDS,
  EXAMPLE_PROJECT_IDS,
} from '../core/project/examples';
import { migrateLightAimToTurn } from '../core/project/migrations';
import { buildAddPrimitiveOps } from './addPrimitives';
import { buildAddStudioLightOps } from './addStudioLight';
import { buildImportProfilesOps } from './studioProfileIO';
import { buildAddConstraintOps } from './constraintStack';
import { constrainMutator } from '../agent/mutators/builders/constrain';
import { makeSplitLight } from '../test-utils/splitLight';
import { resolveWorldTransform } from './resolveWorldTransform';
import { childIdsOf } from './sceneHierarchy';
import { lightKindOf } from './lightNode';

registerAllNodes();

type V3 = [number, number, number];
const T0 = { time: { frame: 0, seconds: 0, normalized: 0 } };

const apply = (s: DagState, ops: readonly Op[]): DagState =>
  ops.reduce((acc, op) => applyOp(acc, op).next, s);

/** Every Track-To on a sun, spot or area light in `s`: what it aims at must be an empty at `at`. */
function expectAimedAtEmpties(s: DagState, at: (lightId: string) => V3, label: string): number {
  let n = 0;
  for (const node of Object.values(s.nodes)) {
    if (node.type !== 'TrackTo') continue;
    const p = node.params as { target: string; aimNode: string };
    const kind = lightKindOf(s.nodes, p.target);
    if (!kind || !['Directional', 'Spot', 'Area'].includes(kind)) continue;
    n++;
    const empty = s.nodes[p.aimNode];
    expect(empty?.type, `${label}: ${p.target}'s Track-To aims at an object`).toBe('Null');
    expect(empty.meta?.name, label).toMatch(/\.aim$/);
    expect(childIdsOf(s, p.target), label).not.toContain(p.aimNode);
    const w = resolveWorldTransform(s, p.aimNode, T0)!;
    expect(w, `${label}: the empty is placed in the scene`).not.toBeNull();
    const want = at(p.target);
    w.position.forEach((v, i) => expect(v, label).toBeCloseTo(want[i], 9));
  }
  return n;
}

/** Production source files under src/ (no tests, no test utilities). */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== 'test-utils') out.push(...sourceFiles(p));
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.startsWith('tmp-')) {
      out.push(p);
    }
  }
  return out;
}

describe('#1765 — a light Track-To always aims at an object', () => {
  it('census: every literal Track-To mint is a light door driven here or a named camera door', () => {
    const LIGHT_DOORS: Record<string, number> = {
      'src/app/lightAim.ts': 1, // Add ▸ Light, studio light, profile import, the stack's "+ Add"
      'src/core/project/default.ts': 1, // the default project's sun
      'src/core/project/examples.ts': 1, // the op-built examples' sun
      'src/core/project/migrations.ts': 1, // v26 → v27, the light step (raw node)
    };
    // Out of scope: the user has not decided whether cameras get an aim empty.
    const CAMERA_DOORS: Record<string, number> = {
      'src/app/CameraLookAtTarget.tsx': 1,
      'src/agent/mutators/builders/cameraTrajectory.ts': 1,
      'src/core/project/migrations.ts': 1, // v25 → v26, the camera step (raw node)
    };
    const found: Record<string, number> = {};
    for (const file of sourceFiles('src')) {
      const text = readFileSync(file, 'utf8');
      const n =
        (text.match(/nodeType: 'TrackTo'/g)?.length ?? 0) +
        (text.match(/type: 'TrackTo',\s*\n\s*version:/g)?.length ?? 0);
      if (n > 0) found[file] = n;
    }
    // Not a mint: the node type's own definition (`type: 'TrackTo', version: 1`).
    const DEFINITION: Record<string, number> = { 'src/nodes/TrackTo.ts': 1 };
    const expected: Record<string, number> = { ...LIGHT_DOORS, ...DEFINITION };
    for (const [f, n] of Object.entries(CAMERA_DOORS)) expected[f] = (expected[f] ?? 0) + n;
    expect(found).toEqual(expected);
  });

  it('Add ▸ Light: a sun, spot and area light aim at an empty at the origin; a point light has none', () => {
    for (const kind of ['DirectionalLight', 'SpotLight', 'AreaLight'] as const) {
      const base = buildDefaultDagState();
      const s = apply(base, buildAddPrimitiveOps(base, kind, [3, 4, 5])!.ops);
      // The default sun and the new light.
      expect(expectAimedAtEmpties(s, () => [0, 0, 0], kind)).toBe(2);
    }
    const base = buildDefaultDagState();
    const r = buildAddPrimitiveOps(base, 'PointLight', [3, 4, 5])!;
    expect(r.ops.some((o) => o.type === 'addNode' && o.nodeType === 'Null')).toBe(false);
  });

  it('a studio light aims at an empty at the rig centre', () => {
    const base = buildDefaultDagState();
    const centre: V3 = [1, 2, -1];
    const s = apply(base, buildAddStudioLightOps(base, centre)!.ops);
    expect(expectAimedAtEmpties(s, (id) => (id === 'n_light' ? [0, 0, 0] : centre), 'studio')).toBe(
      2,
    );
  });

  it('an imported studio profile: each light aims at an empty at the profile centre', () => {
    const base = buildDefaultDagState();
    const centre: V3 = [2, 1, 0];
    const light = {
      position: [0, 3, 4] as V3,
      intensity: 5,
      color: '#ffffff',
      width: 1,
      height: 1,
    };
    const r = buildImportProfilesOps(base, {
      version: 1,
      profiles: [{ name: 'Key', center: centre, radius: 6, lights: [light, light] }],
    } as Parameters<typeof buildImportProfilesOps>[1]);
    const s = apply(base, r.ops);
    expect(
      expectAimedAtEmpties(s, (id) => (id === 'n_light' ? [0, 0, 0] : centre), 'profile'),
    ).toBe(3);
  });

  it('the default project and every op-built example aim their suns at an empty at the origin', async () => {
    expect(expectAimedAtEmpties(buildDefaultDagState(), () => [0, 0, 0], 'default')).toBe(1);
    for (const id of EXAMPLE_PROJECT_IDS) {
      const s = (await buildExampleProject(id)).state;
      expect(
        expectAimedAtEmpties(s, () => [0, 0, 0], id),
        id,
      ).toBeGreaterThan(0);
    }
    expect(CAPTURED_EXAMPLE_IDS.length).toBeGreaterThan(0);
  });

  it("the constraint stack's + Add on a light makes an empty at the origin, in the light's group", () => {
    let s = apply(buildDefaultDagState(), [
      {
        type: 'addNode',
        nodeId: 'grp',
        nodeType: 'Group',
        params: { position: [4, 0, 0], rotation: [0, 90, 0] },
      },
      {
        type: 'connect',
        from: { node: 'grp', socket: 'out' },
        to: { node: 'n_scene', socket: 'children' },
      },
    ] as Op[]);
    s = makeSplitLight(s, {
      objectId: 'spot',
      lightKind: 'Spot',
      position: [0, 3, 0],
      connectTo: { node: 'grp', socket: 'children' },
    }).state;
    const built = buildAddConstraintOps(s, 'spot', 'TrackTo')!;
    s = apply(s, built.ops);
    const aim = (s.nodes[built.constraintId].params as { aimNode: string }).aimNode;
    // It hangs where the light hangs: in the group, so moving the group carries both.
    expect(childIdsOf(s, 'grp')).toContain(aim);
    expect(expectAimedAtEmpties(s, () => [0, 0, 0], 'stack')).toBe(2);
    // A mesh still gets a bare Track-To: the rule is a light's.
    const box = buildAddConstraintOps(s, 'n_box', 'TrackTo')!;
    expect(box.ops.some((o) => o.type === 'addNode' && o.nodeType === 'Null')).toBe(false);
  });

  it('the agent constrain names what to aim at, so a light aims there and no empty is made', () => {
    const base = buildDefaultDagState();
    let s = makeSplitLight(base, {
      objectId: 'spot',
      lightKind: 'Spot',
      position: [0, 3, 3],
      connectTo: { node: 'n_scene', socket: 'lights' },
    }).state;
    const ops = constrainMutator.build(
      { target: 'spot', type: 'TrackTo', to: 'n_box' },
      // `build` reads no closure; the gate that computes one is not under test here.
      {} as Parameters<typeof constrainMutator.build>[1],
      s,
    );
    expect(ops.some((o) => o.type === 'addNode' && o.nodeType === 'Null')).toBe(false);
    s = apply(s, ops);
    const tt = Object.values(s.nodes).find(
      (n) => n.type === 'TrackTo' && (n.params as { target: string }).target === 'spot',
    )!;
    expect((tt.params as { aimNode: string }).aimNode).toBe('n_box');
  });

  it('the v26 → v27 step aims every converted light at an empty at its old point', () => {
    let s = makeSplitLight(buildDefaultDagState(), {
      objectId: 'spot',
      lightKind: 'Spot',
      position: [4, 6, 2],
      connectTo: { node: 'n_scene', socket: 'lights' },
    }).state;
    s = {
      ...s,
      nodes: {
        ...s.nodes,
        spot_data: {
          ...s.nodes.spot_data,
          params: { ...(s.nodes.spot_data.params as object), target: [-1, 0, 3] },
        },
      },
    };
    const raw = migrateLightAimToTurn({ formatVersion: 26, state: s }) as { state: DagState };
    const want: Record<string, V3> = { spot: [-1, 0, 3] };
    const n = expectAimedAtEmpties(raw.state, (id) => want[id] ?? [0, 0, 0], 'migration');
    // The default sun is already aimed (an existing Track-To at its seed empty); the spot is new.
    expect(n).toBeGreaterThanOrEqual(2);
    void THREE;
  });
});
