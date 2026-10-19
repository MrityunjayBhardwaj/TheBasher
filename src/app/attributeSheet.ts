// attributeSheet — every attribute of the selected node's mesh, per domain, for the read-only
// Spreadsheet space (#1556). Blender's Spreadsheet editor and Houdini's Geometry Spreadsheet
// both show the evaluated geometry of what is selected, one domain at a time; this is the data
// half, and `SpreadsheetView` only draws it.
//
// A mesh's attributes live in two places today, and the sheet reads both rather than
// pretending there is one:
//   • a STORED mesh (`descriptor.kind === 'mesh'`, an import) keeps its points, corners, faces
//     and every layer it was given (UV sets, colours, face layers, skin influences) in its own
//     data. Only its face layers are also put in the attribute store (#1052), so the rest are
//     read off the data itself.
//   • every mesh carries an attribute set in the store (`GeometryRef.attributeKey`): the
//     material assignment, face groups, and whatever an operator derived.
//   • a procedural mesh's UVs are neither: they come off the built geometry through the UV
//     road (`readMeshUVs`), which says when they cannot be read and why.
// A column says which of the three it came from. A domain is listed when it has a column.
//
// REF: src/nodes/types.ts (MeshGeometryData, GeometryRef.attributeKey); src/app/attributeStore.ts
//      (read); src/app/uvAttributes.ts (readMeshUVs); src/app/resolveEvaluatedMesh.ts.

import { evaluate, type EvaluatorCache } from '../core/dag/evaluator';
import type { DagState } from '../core/dag/state';
import type { EvalCtx, NodeId } from '../core/dag/types';
import {
  attributeAt,
  componentsOf,
  isKnownDomain,
  KNOWN_DOMAINS,
  UV_MAP,
  type AttributeSet,
  type AttributeType,
  type KnownDomain,
} from '../nodes/attributes';
import type { GeometryRef } from '../nodes/types';
import { read } from './attributeStore';
import { resolveEvaluatedMesh } from './resolveEvaluatedMesh';
import { nodeDisplayName } from './sceneTreeWalk';
import { readMeshUVs } from './uvAttributes';

export interface SheetColumn {
  readonly name: string;
  readonly type: AttributeType;
  /** Numbers per element. */
  readonly components: number;
  readonly data: ArrayLike<number>;
  /** Where it was read: the stored mesh, the attribute store, or the UV road. */
  readonly from: 'stored' | 'store' | 'uv';
}

export interface SheetDomain {
  readonly domain: KnownDomain;
  readonly count: number;
  readonly columns: readonly SheetColumn[];
}

export type AttributeSheet =
  | {
      readonly status: 'ok';
      readonly name: string;
      readonly domains: readonly SheetDomain[];
      /** What could not be read, and why. */
      readonly notes: readonly string[];
    }
  | { readonly status: 'none'; readonly why: string };

const STATIC_CTX: EvalCtx = { time: { frame: 0, seconds: 0, normalized: 0 } };

/**
 * The attributes of `set` on `domain`, as columns. The one place the sheet dispatches on the
 * domain, censused with the other dispatch sites (`attributes.gate.test.ts`).
 */
export function storeColumnsAt(set: AttributeSet | null, domain: KnownDomain): SheetColumn[] {
  return Object.entries(set ?? {})
    .filter(([, a]) => a.domain === domain)
    .map(([name, a]) => ({
      name,
      type: a.type,
      components: componentsOf(a.type),
      data: a.data,
      from: 'store' as const,
    }));
}

/** The mesh `nodeId` puts out: an Object's own, or a data node's value. */
function geometryOf(state: DagState, nodeId: NodeId, cache: EvaluatorCache): GeometryRef | null {
  const mesh = resolveEvaluatedMesh(state, nodeId, STATIC_CTX, cache);
  if (mesh) return mesh.geometry;
  const value = evaluate(state, nodeId, { ctx: STATIC_CTX, cache }).value as {
    geometry?: unknown;
  };
  const g = value && typeof value === 'object' ? value.geometry : undefined;
  return g && typeof g === 'object' && 'descriptor' in g ? (g as GeometryRef) : null;
}

/** Read at rest (frame 0), through the caller's evaluator cache: the Spreadsheet hands it the
 *  shared UI cache (#1315). */
export function attributeSheetOf(
  state: DagState,
  nodeId: NodeId | null,
  cache: EvaluatorCache,
): AttributeSheet {
  if (!nodeId || !state.nodes[nodeId])
    return { status: 'none', why: 'Select a mesh to see its attributes.' };
  const name = nodeDisplayName(state.nodes, nodeId);
  let ref: GeometryRef | null;
  try {
    ref = geometryOf(state, nodeId, cache);
  } catch (e) {
    return { status: 'none', why: `${name} did not evaluate: ${(e as Error).message}` };
  }
  if (!ref) return { status: 'none', why: `${name} puts out no mesh.` };

  const columns = new Map<KnownDomain, SheetColumn[]>(KNOWN_DOMAINS.map((d) => [d, []]));
  const counts = new Map<KnownDomain, number>();
  const notes: string[] = [];
  const add = (domain: KnownDomain, column: SheetColumn) => {
    const list = columns.get(domain)!;
    if (!list.some((c) => c.name === column.name)) list.push(column);
    if (!counts.has(domain)) counts.set(domain, column.data.length / column.components);
  };

  const d = ref.descriptor;
  if (d.kind === 'mesh') {
    const m = d.data;
    counts.set('point', m.points.length / 3);
    counts.set('corner', m.cornerPoints.length);
    counts.set('face', m.faceSizes.length);
    const stored = (
      domain: KnownDomain,
      name: string,
      type: AttributeType,
      data: ArrayLike<number>,
    ) => add(domain, { name, type, components: componentsOf(type), data, from: 'stored' });
    stored('point', 'P', 'float3', m.points);
    for (const l of m.pointLayers) stored('point', l.name, l.type, l.data);
    stored('corner', 'point', 'int', m.cornerPoints);
    for (const l of m.cornerLayers) stored('corner', l.name, l.type, l.data);
    if (m.cornerNormals) stored('corner', 'N', 'float3', m.cornerNormals);
    stored('face', 'corners', 'int', m.faceSizes);
    for (const l of m.faceLayers) stored('face', l.name, l.type, l.data);
    if (m.vertexGroups.length > 0) notes.push(`vertex groups: ${m.vertexGroups.join(', ')}`);
  }

  const set = ref.attributeKey ? read(ref.attributeKey) : null;
  for (const [attrName, a] of Object.entries(set ?? {}))
    if (!isKnownDomain(a.domain))
      notes.push(`${attrName} is on the '${a.domain}' domain, which the sheet cannot show`);
  for (const domain of KNOWN_DOMAINS) for (const c of storeColumnsAt(set, domain)) add(domain, c);

  if (!columns.get('corner')!.some((c) => c.name === UV_MAP)) {
    const uv = readMeshUVs(ref);
    if (uv.status === 'ok' && uv.attribute.kind === 'resident') {
      const layer = attributeAt(read(uv.attribute.key), UV_MAP, 'corner');
      if (layer)
        add('corner', {
          name: UV_MAP,
          type: layer.type,
          components: componentsOf(layer.type),
          data: layer.data,
          from: 'uv',
        });
    } else if (uv.status === 'ok' && uv.attribute.kind === 'not-derivable') {
      notes.push(`UVs not shown: ${uv.attribute.why}`);
    } else if (uv.status === 'loading') {
      notes.push('UVs are still loading');
    }
  }

  const domains = KNOWN_DOMAINS.filter((dm) => columns.get(dm)!.length > 0).map((domain) => ({
    domain,
    count: counts.get(domain) ?? 0,
    columns: columns.get(domain)!,
  }));
  return { status: 'ok', name, domains, notes };
}
