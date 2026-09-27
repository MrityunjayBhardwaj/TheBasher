// #1275 — a view lock on a native character follows what it draws.
//
// A native character's bones are never in the three.js scene (the armature band draws them from
// the graph), and neither of its Objects is mounted under its own id. So the rig comes from the
// graph: the armature Objects the locked node names (`reachedFromSelection`, the rule a bind uses),
// placed at the playhead by `skeletonObjectFrames`, the placement the band draws with.
//
// The live scene here is EMPTY on purpose: it is what the lock found for a character in the app
// (#1275, measured), so every point below has to come from the graph.

import { beforeEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { __resetRegistryForTests, applyOp } from '../core/dag';
import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';
import { nativeCharacterOps } from '../test-utils/nativeCharacter';
import { pointFromScan, scanForFollow } from './followScan';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

/** A character whose Hips travel 10 along +X between 0 s and 1 s, on its base layer. */
function walkingCharacter() {
  let state: DagState = buildDefaultDagState();
  const { ops, ids } = nativeCharacterOps({
    prefix: 'hero',
    bones: ['Hips', 'Spine'],
    sceneId: state.outputs.scene!.node,
  });
  const layer: Op[] = [
    {
      type: 'addNode',
      nodeId: 'hero_base',
      nodeType: 'PoseLayer',
      params: {
        mode: 'override',
        members: [{ bone: 'Hips', rotationMode: 'quaternion' }],
        channels: [
          {
            bone: 'Hips',
            component: 'position',
            keyframes: [
              { time: 0, value: [0, 0, 0], easing: 'linear' },
              { time: 1, value: [10, 0, 0], easing: 'linear' },
            ],
          },
        ],
      },
    },
    {
      type: 'connect',
      from: { node: ids.skeletonId, socket: 'pose' },
      to: { node: 'hero_base', socket: 'pose' },
    },
    {
      type: 'connect',
      from: { node: 'hero_base', socket: 'out' },
      to: { node: ids.armatureId, socket: 'pose' },
    },
  ];
  for (const op of [...ops, ...layer]) state = applyOp(state, op).next;
  return { state, ids };
}

const at = (state: DagState, nodeId: string, bone: string | null, seconds: number) =>
  pointFromScan(scanForFollow(new THREE.Scene(), nodeId, state), nodeId, bone, seconds);

describe('#1275 — a lock on a native character follows its drawn rig', () => {
  it('the armature Object: the rig’s centre, and it travels with the motion', () => {
    const { state, ids } = walkingCharacter();
    const start = at(state, ids.armatureId, null, 0);
    const later = at(state, ids.armatureId, null, 1);
    expect(start?.source).toBe('armature');
    expect(later!.point[0] - start!.point[0]).toBeCloseTo(10, 6);
  });

  it('the mesh Object it deforms, and the Group over both, follow the same rig', () => {
    const { state, ids } = walkingCharacter();
    const rig = at(state, ids.armatureId, null, 0.5);
    for (const id of [ids.meshId, ids.groupId]) {
      const p = at(state, id, null, 0.5);
      expect(p?.source, id).toBe('armature');
      expect(p!.point).toEqual(rig!.point);
    }
  });

  it('a named bone: its head, where the band draws it', () => {
    const { state, ids } = walkingCharacter();
    const p = at(state, ids.armatureId, 'Spine', 1);
    expect(p).toMatchObject({ source: 'bone', bone: 'Spine' });
    // Spine rests 1 above Hips, and Hips has travelled to x = 10.
    expect(p!.point[0]).toBeCloseTo(10, 6);
    expect(p!.point[1]).toBeCloseTo(1, 6);
  });

  it('a node that names no character does not take its rig', () => {
    const { state } = walkingCharacter();
    const cube = applyOp(state, {
      type: 'addNode',
      nodeId: 'cube',
      nodeType: 'Object',
      params: {},
    }).next;
    const scene = new THREE.Scene();
    const mounted = new THREE.Group();
    mounted.name = 'cube';
    mounted.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()));
    mounted.position.set(-5, 0, 0);
    scene.add(mounted);
    scene.updateMatrixWorld(true);
    const p = pointFromScan(scanForFollow(scene, 'cube', cube), 'cube', null, 1);
    expect(p?.source).toBe('object');
    expect(p!.point[0]).toBeCloseTo(-5, 6);
  });

  it('with no graph to read, a character yields nothing — the live scene holds none of it', () => {
    const { ids } = walkingCharacter();
    expect(at(null as unknown as DagState, ids.armatureId, null, 0)).toBeNull();
  });
});
