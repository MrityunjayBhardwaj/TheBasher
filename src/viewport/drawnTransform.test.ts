// #1728 — the transform an overlay renderer writes onto its wrapper group draws exactly what the
// value drew with its transform on itself.

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  drawsTransformAsGroup,
  sameApartFromTransform,
  withoutTransform,
  writeTransform,
} from './drawnTransform';
import { degVec3ToRad } from './rotation';
import type { SceneObject } from '../nodes/types';

/** The world matrix of a leaf under the given chain of groups, each given as TRS props. */
function worldOf(
  chain: ({ p: number[]; r: number[]; s: number[] } | THREE.Object3D)[],
): THREE.Matrix4 {
  const root = new THREE.Group();
  let cur: THREE.Object3D = root;
  for (const link of chain) {
    let g: THREE.Object3D;
    if (link instanceof THREE.Object3D) g = link;
    else {
      g = new THREE.Group();
      g.position.set(link.p[0], link.p[1], link.p[2]);
      g.rotation.set(link.r[0], link.r[1], link.r[2]);
      g.scale.set(link.s[0], link.s[1], link.s[2]);
    }
    cur.add(g);
    cur = g;
  }
  cur.updateWorldMatrix(true, false);
  return cur.matrixWorld.clone();
}

const close = (a: THREE.Matrix4, b: THREE.Matrix4) =>
  a.elements.every((x, i) => Math.abs(x - b.elements[i]) < 1e-9);

describe('#1728 — drawnTransform', () => {
  const position = [1.5, -2, 3];
  const rotation = [30, -45, 120];
  const scale = [2, 0.5, 1.25];

  it('a Group drawn at identity inside the wrapper sits where it sat with its own transform, pivot included', () => {
    const pivot = [0.3, 1, -0.7];
    const neg = { p: pivot.map((x) => -x), r: [0, 0, 0], s: [1, 1, 1] };
    // Before: GroupR's outer group carries T·R·S, the inner one -pivot.
    const before = worldOf([{ p: position, r: degVec3ToRad(rotation as never), s: scale }, neg]);
    // After: the wrapper carries what writeTransform writes; GroupR draws the identity copy.
    const value = { kind: 'Group', position, rotation, scale, pivot, children: [] };
    const wrapper = new THREE.Group();
    writeTransform(wrapper, value);
    const bare = withoutTransform(value);
    const after = worldOf([
      wrapper,
      { p: bare.position, r: degVec3ToRad(bare.rotation as never), s: bare.scale },
      neg,
    ]);
    expect(close(before, after)).toBe(true);
  });

  it('a quaternion-mode value is written with the orientation its renderer would have drawn', () => {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.4, -1.1, 2.0, 'XYZ'));
    const value = {
      kind: 'Object',
      position,
      rotation: [0, 0, 0],
      scale,
      rotationMode: 'quaternion',
      quaternion: [q.x, q.y, q.z, q.w],
      data: null,
    };
    const wrapper = new THREE.Group();
    writeTransform(wrapper, value);
    expect(wrapper.quaternion.angleTo(q)).toBeLessThan(1e-6);
    // The identity copy drops the mode, or MeshChild would put the quaternion back.
    const bare = withoutTransform(value) as Record<string, unknown>;
    expect(bare.rotationMode).toBeUndefined();
    expect(bare.quaternion).toBeUndefined();
    expect(bare.rotation).toEqual([0, 0, 0]);
  });

  it('null writes identity', () => {
    const wrapper = new THREE.Group();
    writeTransform(wrapper, { kind: 'Null', position, rotation, scale });
    writeTransform(wrapper, null);
    wrapper.updateMatrix();
    expect(wrapper.matrix.equals(new THREE.Matrix4())).toBe(true);
  });

  it('keeps every other field as the same object, so the evaluator-minted identity still holds', () => {
    const material = { base: { color: [1, 0, 0] } };
    const data = { kind: 'MeshData', material, materialKey: 'k' };
    const value = { kind: 'Object', position, rotation, scale, data, materialKey: 'm' };
    const bare = withoutTransform(value);
    expect(bare.data).toBe(data);
    expect(bare.materialKey).toBe('m');
  });

  it('sameApartFromTransform: a moved transform is the same draw; a changed field is not', () => {
    const data = { kind: 'MeshData' };
    const a = { kind: 'Object', position, rotation, scale, data };
    expect(sameApartFromTransform(a, { ...a, position: [9, 9, 9], rotation: [1, 2, 3] })).toBe(
      true,
    );
    expect(sameApartFromTransform(a, { ...a, data: { kind: 'MeshData' } })).toBe(false);
    expect(sameApartFromTransform(a, { ...a, extra: 1 })).toBe(false);
    const { data: _drop, ...noData } = a;
    void _drop;
    expect(sameApartFromTransform(a, noData)).toBe(false);
  });

  it('only kinds whose renderer uses the transform for placement alone take the wrapper', () => {
    const k = (v: object) => drawsTransformAsGroup(v as SceneObject);
    expect(k({ kind: 'Object', data: { kind: 'MeshData' } })).toBe(true);
    expect(k({ kind: 'Object', data: null })).toBe(true);
    expect(k({ kind: 'Group' })).toBe(true);
    expect(k({ kind: 'Transform' })).toBe(true);
    expect(k({ kind: 'Null' })).toBe(true);
    // A light reads scale as intensity and aims from its position.
    expect(k({ kind: 'Object', data: { kind: 'LightData' } })).toBe(false);
    expect(k({ kind: 'PointLight' })).toBe(false);
    expect(k({ kind: 'Character' })).toBe(false);
  });
});
