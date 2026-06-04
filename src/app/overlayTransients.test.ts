// B1 unit — overlayTransients, the single transient-overlay primitive.
//
// Proves: a matching edit returns a NEW object with the paramPath overwritten
// (transform AND non-transform); the base is never mutated; no match / empty
// set / null child → identity (same ref, no churn). One writeAt (the same the
// channel patch uses) → no path-writer drift (H40).

import { describe, expect, it } from 'vitest';
import { overlayTransients } from './overlayTransients';
import type { SceneChild } from '../nodes/types';
import type { TransientEdit } from './stores/transientEditStore';

const NODE = 'n_box';

function editMap(...edits: TransientEdit[]): Map<string, TransientEdit> {
  const m = new Map<string, TransientEdit>();
  for (const e of edits) m.set(`${e.nodeId}|${e.paramPath}`, e);
  return m;
}

/** Minimal SceneChild-shaped object with a transform band + a nested field. */
function baseChild(): SceneChild {
  return {
    kind: 'Transform',
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    material: { color: '#ffffff', metalness: 0 },
  } as unknown as SceneChild;
}

describe('overlayTransients (B1)', () => {
  it('overlays a TRANSFORM band onto a new clone; base untouched', () => {
    const base = baseChild();
    const edits = editMap({ nodeId: NODE, paramPath: 'position', value: [9, 0, 0] });
    const out = overlayTransients(base, NODE, edits) as unknown as Record<string, unknown>;

    expect(out).not.toBe(base); // NEW object
    expect(out.position).toEqual([9, 0, 0]); // path overwritten
    expect((base as unknown as Record<string, unknown>).position).toEqual([0, 0, 0]); // base untouched
  });

  it('overlays a NON-TRANSFORM nested path (material.color)', () => {
    const base = baseChild();
    const edits = editMap({ nodeId: NODE, paramPath: 'material.color', value: '#ff0000' });
    const out = overlayTransients(base, NODE, edits) as unknown as {
      material: { color: string; metalness: number };
    };

    expect(out.material.color).toBe('#ff0000');
    expect(out.material.metalness).toBe(0); // sibling untouched
    expect((base as unknown as { material: { color: string } }).material.color).toBe('#ffffff');
  });

  it('applies MULTIPLE matching edits in one pass (D-149-1 multi-slot)', () => {
    const base = baseChild();
    const edits = editMap(
      { nodeId: NODE, paramPath: 'position', value: [9, 0, 0] },
      { nodeId: NODE, paramPath: 'scale', value: [2, 2, 2] },
    );
    const out = overlayTransients(base, NODE, edits) as unknown as Record<string, unknown>;
    expect(out.position).toEqual([9, 0, 0]);
    expect(out.scale).toEqual([2, 2, 2]);
  });

  it('ignores edits targeting a DIFFERENT node', () => {
    const base = baseChild();
    const edits = editMap({ nodeId: 'other-node', paramPath: 'position', value: [9, 0, 0] });
    const out = overlayTransients(base, NODE, edits);
    expect(out).toBe(base); // identity — no match for NODE
  });

  it('empty edit set → identity (same ref)', () => {
    const base = baseChild();
    expect(overlayTransients(base, NODE, editMap())).toBe(base);
  });

  it('null child → null (render sampleTarget can return null)', () => {
    expect(
      overlayTransients(
        null,
        NODE,
        editMap({ nodeId: NODE, paramPath: 'position', value: [1, 2, 3] }),
      ),
    ).toBeNull();
  });
});
