// cornerLayerNames — which NAMED corner layers a geometry descriptor's mesh carries, and
// which render buffer each one lands in (#1062).
//
// ── THE QUESTION THIS EXISTS TO ANSWER ───────────────────────────────────────────────
//
// A material now NAMES the layers it reads: `mapUvLayers.albedo = 'UVMap.001'`,
// `geometry.colorLayer = 'Color'`. Turning that name into something the GPU understands —
// a `texture.channel`, a `vertexColors` flag — needs the drawn mesh's own ordered layer
// list. This module is where a descriptor is asked for it.
//
// 🔴 A NAME IS NEVER PARSED TO GET ITS ANSWER. `uvLayerIndex` does exactly that, correctly,
// for the ONE road whose geometry carries no layer list (three's own copy of a glTF, whose
// buffers are numbered in the file's `TEXCOORD` order). A stored mesh is the opposite case:
// its layers need not have come from an import at all — a cube projection authors
// `UVProject` — so reading a number out of a name would answer confidently about a layer
// the mesh never had. Here the name is LOOKED UP in the list, or it does not resolve.
//
// ── WHY A DESCRIPTOR WALK AND NOT A REGISTRY LOOKUP ──────────────────────────────────
//
// The answer is needed by `usePrimitiveMaterial`, which runs BEFORE the geometry is
// fetched and must answer on a first render, for a handle that may not be built yet. A
// descriptor is in hand at that moment and is a total description of the mesh, so the walk
// is synchronous and needs nothing from the registry.
//
// The cost of deriving rather than recording is that this states, a second time, what each
// builder actually writes — and two statements of one fact drift. That is closed by
// `cornerLayerConformance.gate.test.ts`, which builds every sync-buildable descriptor kind
// and asserts this module's answer equals the corner-layer attributes the built geometry
// really carries. A builder that starts or stops carrying a layer reds the gate.
//
// REF: src/app/meshGeometryData.ts (`cornerLayerBufferNames`, the name → buffer rule this
//      shares); src/nodes/attributes.ts (`uvLayerIndex`, the numbered road and why it is
//      different); src/app/cornerMaterialisation.ts (what `uvProject` writes);
//      ref/GROUND_TRUTH_BLENDER_ATTRIBUTE_NAMING.md; issues #1062, #1117, #786.

import type { GeometryDescriptor, MeshCornerLayer } from '../nodes/types';
import { UV_MAP, UV_PROJECT } from '../nodes/attributes';
import { cornerLayerBufferNames } from './meshGeometryData';

/** A layer's identity for the draw: its name, and the type that decides its buffer. */
export type NamedCornerLayer = Pick<MeshCornerLayer, 'name' | 'type'>;

/** What three.js names the single UV buffer it authors for a built-in primitive. */
const PRIMITIVE_UV: readonly NamedCornerLayer[] = [{ name: UV_MAP, type: 'float2' }];

/**
 * The render buffer a colour layer is drawn to. Derived from the one naming rule rather than
 * spelled, so it cannot name a buffer the build never writes.
 */
export const COLOUR_BUFFER: string = cornerLayerBufferNames([{ type: 'float4' }])[0];

/**
 * The named corner layers the mesh this descriptor describes will carry, IN THE ORDER the
 * build draws them — the order {@link cornerLayerBufferNames} turns into `uv`, `uv1`, … and
 * `color`.
 *
 * An EMPTY list means "this mesh has no layer list to resolve against", which is a different
 * claim from "this mesh has no layers": a `gltf` handle draws three's copy of the file, whose
 * buffers are numbered rather than named, and the road that draws it resolves by number
 * instead (`gltfMapOverlay`). Either way no name resolves here, which is the answer that
 * makes a material naming a layer decline rather than guess.
 */
export function cornerLayerNamesOf(descriptor: GeometryDescriptor): readonly NamedCornerLayer[] {
  switch (descriptor.kind) {
    case 'mesh':
      // The stored mesh's own list, which is the whole point: these names came from the
      // producer (the reader spells an import's `UVMap`/`UVMap.001`/`Color`), never from
      // this module.
      return descriptor.data.cornerLayers.map(({ name, type }) => ({ name, type }));

    case 'box':
    case 'sphere':
      // three authors exactly one UV buffer for its built-in geometries, and this project
      // already calls that buffer `UVMap` everywhere else — `readMeshUVs` LIFTS a layer of
      // that name off it. Naming it here is what keeps the conformance gate an equality
      // rather than an exemption.
      return PRIMITIVE_UV;

    case 'baked':
      // A bake keeps position/normal/uv/index and nothing else (`bakedGeometryStore.ts`),
      // so whatever the source was named, one UV layer survives. That the OTHER layers are
      // dropped on the way in is #1119, not this module's to paper over.
      return PRIMITIVE_UV;

    case 'gltf':
      // The file's-copy road. Numbered buffers, no layer list — see the doc above.
      return [];

    case 'array':
    case 'mirror':
    case 'subset':
      // Replicate / reflect / select FACES. Every builder merges attributes by name and
      // changes only how many of each there are, so the layer list is the source's,
      // unchanged — measured per-builder at full corner count before this was written.
      return cornerLayerNamesOf(descriptor.source.descriptor);

    case 'bevel':
      // A bevel writes `position` and an interpolated `uv` and computes normals; it REFUSES
      // a source carrying any other corner layer by name (`buildBevel`, #881). So the
      // output carries the source's first `float2` — the same layer, interpolated onto new
      // corners, therefore still that layer's name — and nothing else.
      return firstUvLayerOf(cornerLayerNamesOf(descriptor.source.descriptor));

    case 'uvProject': {
      // 🔴 THE CASE THAT MAKES NAME-PARSING WRONG. `materialiseCornerLayer` copies every
      // source attribute by name and then OVERWRITES `uv` with the projection, so the mesh
      // still carries the source's other layers while its first `float2` is no longer the
      // source's UV set — it is a projection, and it is named for what it is.
      const source = cornerLayerNamesOf(descriptor.source.descriptor);
      const at = source.findIndex((layer) => layer.type === 'float2');
      const projected: NamedCornerLayer = { name: UV_PROJECT, type: 'float2' };
      // A source with no UV set at all GAINS one, and it is first because it is the only
      // `float2` there is.
      if (at === -1) return [projected, ...source];
      return source.map((layer, i) => (i === at ? projected : layer));
    }

    default: {
      const unreachable: never = descriptor;
      throw new Error(
        `cornerLayerNamesOf: undeclared descriptor kind ${JSON.stringify(unreachable)}`,
      );
    }
  }
}

/** The first `float2` of a list, as a list — a bevel's whole output layer set. */
function firstUvLayerOf(layers: readonly NamedCornerLayer[]): readonly NamedCornerLayer[] {
  const uv = layers.find((layer) => layer.type === 'float2');
  return uv === undefined ? [] : [uv];
}

/**
 * The render buffer a NAMED layer is drawn to — `uv`, `uv1`, `uv2`, `uv3` or `color` — or
 * `null` when this mesh carries no layer by that name.
 *
 * `null` is the honest answer and every caller declines on it rather than falling back to
 * the first layer. Blender draws a named-but-absent layer BLACK; we do not, because there is
 * no active-layer notion here to fall back to and a silently black mesh is the failure this
 * work exists to remove. That divergence is deliberate and pinned by a test.
 *
 * REF: ref/GROUND_TRUTH_BLENDER_ATTRIBUTE_NAMING.md (a named-but-absent layer, Cycles first
 *      pixel `0,0,0`).
 */
export function cornerLayerBufferOf(
  layers: readonly NamedCornerLayer[],
  name: string,
): string | null {
  const at = layers.findIndex((layer) => layer.name === name);
  if (at === -1) return null;
  // Buffer names come from the ONE rule the build uses, over the whole list — never from
  // counting this entry's predecessors here, which would be that rule spelled twice.
  return cornerLayerBufferNames(layers)[at] ?? null;
}

/**
 * The `texture.channel` a map naming this layer must sample, or `null` when the name does
 * not resolve to a UV buffer on this mesh.
 *
 * `color` is not a UV buffer, so a map naming the colour layer does not resolve — asking a
 * texture to sample a colour is not a thing three can do, and answering `0` would silently
 * sample a different layer than the one named.
 */
export function uvChannelOf(layers: readonly NamedCornerLayer[], name: string): number | null {
  const buffer = cornerLayerBufferOf(layers, name);
  if (buffer === null) return null;
  if (buffer === 'uv') return 0;
  const match = /^uv(\d+)$/.exec(buffer);
  return match === null ? null : Number(match[1]);
}
