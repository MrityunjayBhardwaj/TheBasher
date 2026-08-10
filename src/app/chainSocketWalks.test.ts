// chainSocketWalks — the scene-lane walkers read the DECLARED chain socket
// (`NodeDefinition.chainInput`, #396), never the socket spelled `target`.
//
// WHY THESE TESTS LOOK ARTIFICIAL, AND WHY THEY HAVE TO. A registry census taken
// while writing #610 found SEVEN node types with a `target` input socket and
// ALL SEVEN declaring it as their `chainInput` — zero divergence. So every test
// written against the shipped registry passes identically whether the walker reads
// the declaration or the name, and reverting the fold reddens nothing. A suite like
// that measures agreement between two spellings, not the rule.
//
// The only test with power is one that CONSTRUCTS the divergence the registry does
// not yet contain: a wrapper whose spine is NOT called `target`, and which also has
// a `target` socket pointing somewhere else — the shape the first operator with a
// second same-typed input (a boolean's cutter, a deform's capture pose) will have.
// A by-name walker follows the decoy; a declaration-reading walker follows the spine.
//
// REF: src/app/operatorChain.ts (chainSocketOf); src/core/dag/types.ts (chainInput);
//      issues #396, #610.

import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { __resetRegistryForTests } from '../core/dag';
import { registerNodeType } from '../core/dag/registry';
import type { DagState } from '../core/dag/state';
import type { Node, NodeDefinition } from '../core/dag/types';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import { childEdges } from './resolveWorldTransform';
import { findTargetAssetRef } from './resolveOverrideSlots';

/** A wrapper whose spine is `spine` and which ALSO has a `target` argument socket.
 *  This is the shape no shipped node has yet — see the header. */
const SpineWrapper: NodeDefinition<Record<string, never>, unknown> = {
  type: 'TmpSpineWrapper',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: z.object({}),
  inputs: {
    spine: { type: 'SceneObject', cardinality: 'single' },
    target: { type: 'SceneObject', cardinality: 'single' },
  },
  chainInput: 'spine',
  outputs: { out: { type: 'SceneObject', cardinality: 'single' } },
  evaluate: () => ({ kind: 'Transform', child: null }),
};

function node(id: string, type: string, inputs: Node['inputs'], params: unknown = {}): Node {
  return { id, type, params, inputs } as unknown as Node;
}

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
  registerNodeType(SpineWrapper);
});

describe('childEdges descends the declared spine, not the socket named `target`', () => {
  it('returns the `spine` child and ignores a decoy wired to `target`', () => {
    const state = {
      nodes: {
        n_wrap: node('n_wrap', 'TmpSpineWrapper', {
          spine: { node: 'n_real' },
          target: { node: 'n_decoy' },
        }),
        n_real: node('n_real', 'BoxData', {}),
        n_decoy: node('n_decoy', 'BoxData', {}),
      },
    } as unknown as DagState;

    const childValue = { kind: 'Mesh' };
    const edges = childEdges(state, 'n_wrap', {
      kind: 'Transform',
      child: childValue,
    } as never);

    expect(edges).toHaveLength(1);
    // The whole point: `n_decoy` is what a by-name read returns.
    expect(edges[0].id).toBe('n_real');
    expect(edges[0].id).not.toBe('n_decoy');
    expect(edges[0].value).toBe(childValue);
  });

  it('descends nothing when the wrapper type declares no chain at all', () => {
    const state = {
      nodes: {
        n_leaf: node('n_leaf', 'BoxData', { target: { node: 'n_real' } }),
        n_real: node('n_real', 'BoxData', {}),
      },
    } as unknown as DagState;

    // BoxData is a leaf producer: it declares no `chainInput`, so even a `target`
    // binding must not be mistaken for a scene-graph edge.
    const edges = childEdges(state, 'n_leaf', {
      kind: 'Transform',
      child: { kind: 'Mesh' },
    } as never);

    expect(edges).toHaveLength(0);
  });
});

describe('findTargetAssetRef walks the declared spine', () => {
  it('reaches the glTF through `spine` while `target` points at a non-asset decoy', () => {
    const nodes: Record<string, Node> = {
      n_wrap: node('n_wrap', 'TmpSpineWrapper', {
        spine: { node: 'n_gltf' },
        target: { node: 'n_decoy' },
      }),
      n_gltf: node('n_gltf', 'GltfAsset', {}, { assetRef: 'asset-abc' }),
      n_decoy: node('n_decoy', 'BoxData', {}),
    };

    // A by-name walk steps to n_decoy, finds no GltfAsset and no further `target`,
    // and returns null — the submesh selector silently disappears.
    expect(findTargetAssetRef(nodes, 'n_wrap')).toBe('asset-abc');
  });

  it('still walks a real Transform/MaterialOverride chain (spelled `target` today)', () => {
    const nodes: Record<string, Node> = {
      n_ovr: node('n_ovr', 'MaterialOverride', { target: { node: 'n_xf' } }),
      n_xf: node('n_xf', 'Transform', { target: { node: 'n_gltf' } }),
      n_gltf: node('n_gltf', 'GltfAsset', {}, { assetRef: 'asset-xyz' }),
    };

    expect(findTargetAssetRef(nodes, 'n_ovr')).toBe('asset-xyz');
  });

  it('stops at a node that has a `target` but declares no chain', () => {
    const nodes: Record<string, Node> = {
      n_leaf: node('n_leaf', 'BoxData', { target: { node: 'n_gltf' } }),
      n_gltf: node('n_gltf', 'GltfAsset', {}, { assetRef: 'asset-nope' }),
    };

    expect(findTargetAssetRef(nodes, 'n_leaf')).toBeNull();
  });
});
