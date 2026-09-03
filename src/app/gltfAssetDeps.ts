// The set of DAG nodes that a mounted glTF asset's per-child render layers
// actually depend on — the SUBSCRIPTION scope for GltfAssetR (B13/H48).
//
// Why this exists: GltfAssetR must re-derive its per-child TRS overrides and its
// baked-channel samplers whenever the nodes feeding them change (the H40
// boundary-pair: a manual GltfChild edit must re-apply, never freeze). The naive
// way is to subscribe to the WHOLE node table (`useDagStore(s => s.state.nodes)`)
// — but that ref changes on EVERY dispatch (ops.ts applySetParam returns a fresh
// `nodes`), so editing an UNRELATED node re-renders the heavy asset and re-walks
// all N nodes twice. On a 700-node import that is the "edit anything → the imported
// model re-renders" cost (H48 4th occurrence).
//
// This collector returns ONLY the nodes the two layer-derivations read:
//   - childOverridesForAsset → `GltfChild` nodes with this `assetRef`
//   - bakedChannelSamplersForAsset → `KeyframeChannelVec3` nodes scoped to this
//     asset by `nodeNameMap` (childName → target agreement, BLOCK-2), AND
//     (#888) the `GltfAsset` → `GltfSkeleton` → `AnimationClip` chain that
//     enumerator now walks to reach a retargeted clip
//
// 🔴 THE #888 ADDITION IS NOT OPTIONAL POLISH — IT IS THE H40 PAIR. The
// enumerator is shared by the renderer (which passes THIS collector's output)
// and the read-side resolver (which passes the WHOLE node table). Teaching the
// enumerator to walk an edge without widening the subscription here would give
// the read side a clip band and the renderer nothing: the gizmo/NPanel would
// show a bone moving and the viewport would not, which is precisely the
// displayed-≠-rendered split the shared enumerator exists to prevent — and it
// would be silent, because both surfaces would still be "working".
// Subscribed with zustand `shallow`, the returned array is referentially equal
// across an unrelated edit (the DAG uses structural sharing: ops.ts:278-282 keeps
// every unchanged node's ref identical), so GltfAssetR does NOT re-render. A
// relevant edit flips exactly one element's ref → shallow detects it → re-render →
// the layers re-derive and re-apply (H40 freeze guard preserved).
//
// REF: src/viewport/SceneFromDAG.tsx (GltfAssetR subscription), bakedGltfChannels.ts
//      (bakedChannelSamplersForAsset — same node selection), [[H48]] [[B13]] [[H40]].

import type { Node } from '../core/dag/types';

/**
 * The nodes whose params drive GltfAssetR's per-child TRS/material override
 * layers and baked-channel samplers for ONE asset. A SUPERSET is safe (the
 * downstream helpers re-filter); the contract is only that any node whose change
 * could alter those layers is present, so its ref-flip triggers a re-render.
 *
 * @param nodes        the DAG node table (read-only).
 * @param assetRef     the asset's storage handle (GltfAssetValue.assetRef).
 * @param nodeNameMap  the asset's childName → dagId map (BLOCK-2 membership scope).
 */
export function gltfAssetDepNodes(
  nodes: Readonly<Record<string, Node>>,
  assetRef: string,
  nodeNameMap: Readonly<Record<string, string>>,
): Node[] {
  // The set of THIS asset's GltfChild dagIds — the membership scope for material
  // channels (#188), which target a child dagId DIRECTLY (no childName, unlike the
  // transform channels above whose asset scope is nodeNameMap[childName]===target).
  const childIds = new Set(Object.values(nodeNameMap));
  const out: Node[] = [];

  // #888 — the clip-band chain: GltfAsset → GltfSkeleton → AnimationClip.
  // Collected in its own pass because it is a WALK (each hop needs the previous
  // hop's id), not a predicate over one node. Three small passes over the table
  // stay well inside the budget this collector exists to protect: the cost it
  // was written to avoid is re-deriving the layers on every unrelated edit, not
  // the walk itself.
  const assetNode = Object.values(nodes).find(
    (n) => n.type === 'GltfAsset' && (n.params as { assetRef?: unknown }).assetRef === assetRef,
  );
  if (assetNode) {
    // The asset itself: its `skins[].jointKeys` is the bone-index → childName
    // spine the enumerator reads, and its `nodeNameMap` is the membership scope.
    // A re-import that changes either must re-derive the band.
    out.push(assetNode);
    const edgeTo = (n: Node, socket: string): string | null => {
      const s = (n.inputs as Record<string, unknown> | undefined)?.[socket];
      if (!s) return null;
      const one = (Array.isArray(s) ? s[0] : s) as { node?: unknown } | undefined;
      return typeof one?.node === 'string' ? one.node : null;
    };
    const skeletonIds = new Set<string>();
    for (const n of Object.values(nodes)) {
      if (n.type === 'GltfSkeleton' && edgeTo(n, 'asset') === assetNode.id) {
        skeletonIds.add(n.id);
        out.push(n);
      }
    }
    if (skeletonIds.size > 0) {
      for (const n of Object.values(nodes)) {
        const boundTo = n.type === 'AnimationClip' ? edgeTo(n, 'skeleton') : null;
        if (boundTo !== null && skeletonIds.has(boundTo)) out.push(n);
      }
    }
  }

  for (const node of Object.values(nodes)) {
    if (node.type === 'GltfChild') {
      const p = node.params as { assetRef?: unknown };
      if (p.assetRef === assetRef) out.push(node);
      continue;
    }
    if (node.type === 'KeyframeChannelVec3') {
      const p = node.params as { childName?: unknown; target?: unknown; paramPath?: unknown };
      if (
        typeof p.childName === 'string' &&
        typeof p.target === 'string' &&
        (p.paramPath === 'position' || p.paramPath === 'rotation' || p.paramPath === 'scale') &&
        nodeNameMap[p.childName] === p.target
      ) {
        out.push(node);
      }
      continue;
    }
    // #188 (v0.7 Phase 3) — material channels. A `materials.<slot>.<lobe>.<field>`
    // channel (KeyframeChannelNumber for scalars, KeyframeChannelColor for hex
    // colours) targets a GltfChild dagId directly. Subscribe it so editing the
    // channel re-renders this asset (the H40 freeze-guard) and the per-frame
    // overlay sees it. A SUPERSET is safe — `directChannelNodesForTarget` re-filters
    // with the H105 layer-wired guard downstream; here we only need the ref-flip.
    if (node.type === 'KeyframeChannelNumber' || node.type === 'KeyframeChannelColor') {
      const p = node.params as { target?: unknown; paramPath?: unknown };
      if (
        typeof p.target === 'string' &&
        childIds.has(p.target) &&
        typeof p.paramPath === 'string' &&
        p.paramPath.startsWith('materials.')
      ) {
        out.push(node);
      }
    }
  }
  return out;
}
