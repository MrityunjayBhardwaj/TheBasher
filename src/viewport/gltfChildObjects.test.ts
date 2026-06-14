// H90/V44 — per-child clone objects resolve by STAMPED id, not by the three.js
// name (which diverges from the producer's nodeNameMap key on real exports).
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildChildIdToObject, resolveChildObject } from './gltfChildObjects';

/** A clone where a child's three.js NAME diverges from the producer key (the
 *  H90 dedup-suffix mismatch), but the stamp is present (the V44 fix). */
function makeDivergentClone(): {
  root: THREE.Group;
  wheel: THREE.Object3D;
  body: THREE.Object3D;
  nodeNameMap: Record<string, string>;
} {
  const root = new THREE.Group();
  // Producer key "Wheel_0_003" → childId "cid-wheel"; three named it "Wheel_0003".
  const wheel = new THREE.Object3D();
  wheel.name = 'Wheel_0003';
  wheel.userData.basherGltfChildId = 'cid-wheel';
  // Producer key "Body" → childId "cid-body"; name matches here.
  const body = new THREE.Object3D();
  body.name = 'Body';
  body.userData.basherGltfChildId = 'cid-body';
  root.add(wheel, body);
  return {
    root,
    wheel,
    body,
    nodeNameMap: { Wheel_0_003: 'cid-wheel', Body: 'cid-body' },
  };
}

function nameMapOf(root: THREE.Object3D): Map<string, THREE.Object3D> {
  const m = new Map<string, THREE.Object3D>();
  root.traverse((o) => {
    if (o.name && !m.has(o.name)) m.set(o.name, o);
  });
  return m;
}

describe('buildChildIdToObject', () => {
  it('indexes every stamped object by its basherGltfChildId; first stamp wins', () => {
    const { root, wheel, body } = makeDivergentClone();
    const idMap = buildChildIdToObject(root);
    expect(idMap.get('cid-wheel')).toBe(wheel);
    expect(idMap.get('cid-body')).toBe(body);
    expect(idMap.size).toBe(2);
  });

  it('ignores objects without a stamp', () => {
    const root = new THREE.Group();
    root.add(new THREE.Object3D()); // unstamped
    expect(buildChildIdToObject(root).size).toBe(0);
  });
});

describe('resolveChildObject', () => {
  it('resolves a name-divergent child by its stamped id (the H90 fix)', () => {
    const { root, wheel, nodeNameMap } = makeDivergentClone();
    const idMap = buildChildIdToObject(root);
    const nameMap = nameMapOf(root); // keyed by "Wheel_0003" — NOT the producer key
    // By name alone this misses ("Wheel_0_003" ∉ nameMap); by id it resolves.
    expect(nameMap.get('Wheel_0_003')).toBeUndefined();
    expect(resolveChildObject('Wheel_0_003', nodeNameMap, idMap, nameMap)).toBe(wheel);
  });

  it('falls back to the three.js name when there is no stamp (pre-UX#7 saves)', () => {
    const root = new THREE.Group();
    const legacy = new THREE.Object3D();
    legacy.name = 'LegacyPart';
    root.add(legacy);
    const idMap = buildChildIdToObject(root); // empty — nothing stamped
    const nameMap = nameMapOf(root);
    // nodeNameMap maps the key to a childId that isn't stamped anywhere → id miss
    // → name fallback hits because the key happens to equal the three name here.
    expect(resolveChildObject('LegacyPart', { LegacyPart: 'cid-x' }, idMap, nameMap)).toBe(legacy);
  });

  it('returns undefined when neither id nor name resolves', () => {
    const { root, nodeNameMap } = makeDivergentClone();
    const idMap = buildChildIdToObject(root);
    const nameMap = nameMapOf(root);
    expect(resolveChildObject('Nonexistent', nodeNameMap, idMap, nameMap)).toBeUndefined();
  });
});
