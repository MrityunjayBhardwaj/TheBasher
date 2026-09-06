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
//     enumerator now walks to reach a retargeted clip, AND (#901) a
//     `RetargetClip` on that rig TOGETHER WITH ITS OPERANDS — the source clip,
//     that clip's own `Skeleton`, and the `BoneNameMap`
//
// 🔴 THE #888 ADDITION IS NOT OPTIONAL POLISH — IT IS THE H40 PAIR. The
// enumerator is shared by the renderer (which passes THIS collector's output)
// and the read-side resolver (which passes the WHOLE node table). Teaching the
// enumerator to walk an edge without widening the subscription here would give
// the read side a clip band and the renderer nothing: the gizmo/NPanel would
// show a bone moving and the viewport would not, which is precisely the
// displayed-≠-rendered split the shared enumerator exists to prevent — and it
// would be silent, because both surfaces would still be "working".
// 🔴 AND #901 IS THE SAME PAIR, MEASURED THE HARD WAY. A `RetargetClip`'s keys
// are not in its params — they are the relationship, resolved from its operands.
// The first version of #901 taught the enumerator to resolve it and stopped
// there, and the warning above came true EXACTLY as written: every unit test
// passed (they hand in the whole node table), and the rendered rig did not move
// at all. Observed in a browser on a real Tripo character with a real Kimodo
// clip — the graph was perfect and the skin was frozen. So the walk goes one
// hop further here: an operand whose ref cannot flip is an edit the viewport
// will never see.
//
// Subscribed with zustand `shallow`, the returned array is referentially equal
// across an unrelated edit (the DAG uses structural sharing: ops.ts:278-282 keeps
// every unchanged node's ref identical), so GltfAssetR does NOT re-render. A
// relevant edit flips exactly one element's ref → shallow detects it → re-render →
// the layers re-derive and re-apply (H40 freeze guard preserved).
//
// REF: src/viewport/SceneFromDAG.tsx (GltfAssetR subscription), bakedGltfChannels.ts
//      (bakedChannelSamplersForAsset — same node selection), [[H48]] [[B13]] [[H40]].

import type { Node } from '../core/dag/types';
import { importedChildDataId, importedChildOf, isImportedChildMaterialPath } from './importedChild';

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
  // The set of THIS asset's child dagIds — the membership scope for material
  // channels (#188), which target a node id DIRECTLY (no childName, unlike the
  // transform channels above whose asset scope is nodeNameMap[childName]===target).
  //
  // #389 — BOTH HALVES, and the data half is the one that actually matters here. A
  // material channel authored through the split road targets the node that OWNS the
  // param, which is the `GltfData`; the Object ids from `nodeNameMap` no longer match a
  // single material channel. Keeping them is not redundancy — a transform channel still
  // names the Object, and a superset is the contract of this collector.
  const childIds = new Set(Object.values(nodeNameMap));
  for (const objectId of Object.values(nodeNameMap)) {
    const dataId = importedChildDataId(nodes, objectId);
    if (dataId) childIds.add(dataId);
  }
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
      // #901 — a RetargetClip's OPERANDS, collected as they are discovered. The
      // ids are gathered first and resolved after the sweep because an operand
      // can sit anywhere in the table, including before its consumer.
      const operandIds = new Set<string>();
      for (const n of Object.values(nodes)) {
        const boundTo =
          n.type === 'AnimationClip' || n.type === 'RetargetClip' ? edgeTo(n, 'skeleton') : null;
        if (boundTo === null || !skeletonIds.has(boundTo)) continue;
        out.push(n);
        if (n.type !== 'RetargetClip') continue;
        const mapId = edgeTo(n, 'boneMap');
        if (mapId) operandIds.add(mapId);
        const sourceId = edgeTo(n, 'sourceClip');
        if (!sourceId) continue;
        operandIds.add(sourceId);
        // …and the SOURCE clip's own rig: its keyframes are indices into that
        // skeleton, so editing the rig changes what the retarget produces.
        const sourceNode = nodes[sourceId];
        const sourceRigId = sourceNode ? edgeTo(sourceNode, 'skeleton') : null;
        if (sourceRigId) operandIds.add(sourceRigId);
      }
      // The source clip normally hangs off a DIFFERENT rig than this asset's, so
      // the walk above excluded it — but nothing forbids the two coinciding, and
      // a node listed twice would make `shallow` compare a longer array against a
      // shorter one on an unrelated edit. Dedupe by identity rather than assume.
      const already = new Set(out);
      for (const id of operandIds) {
        const n = nodes[id];
        if (n && !already.has(n)) out.push(n);
      }
    }
  }

  for (const [nodeId, node] of Object.entries(nodes)) {
    // #389 — asked through the one module that knows how an imported child is spelled,
    // rather than by testing the node type here. Iterating entries rather than values is
    // what that costs: the question is about a node's IDENTITY in the table, not about
    // the object in hand, and it stays answerable when the child becomes a pair.
    const child = importedChildOf(nodes, nodeId);
    if (child) {
      if (child.assetRef === assetRef) {
        out.push(node);
        // #389 — and its DATA half, which is where the captured materials now live. Without
        // this the collector subscribes the pose and not the material: recolouring an
        // imported mesh would flip no ref this asset watches, so `GltfAssetR` would not
        // re-render and the clone would keep painting the old colour until something else
        // happened to re-render it. That is the H40 freeze this collector exists to prevent,
        // arrived at through the half that did not exist when it was written.
        const dataId = importedChildDataId(nodes, nodeId);
        if (dataId && nodes[dataId]) out.push(nodes[dataId]);
      }
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
    // #188 (v0.7 Phase 3) — material channels. A `material.<lobe>.<field>` or
    // `materialSlots.<slot>.<lobe>.<field>` channel (KeyframeChannelNumber for scalars,
    // KeyframeChannelColor for hex colours) targets the child's data node directly
    // (#389 — it was `materials.<slot>.…` on the fused node). Subscribe it so editing the
    // channel re-renders this asset (the H40 freeze-guard) and the per-frame
    // overlay sees it. A SUPERSET is safe — `directChannelNodesForTarget` re-filters
    // with the H105 layer-wired guard downstream; here we only need the ref-flip.
    if (node.type === 'KeyframeChannelNumber' || node.type === 'KeyframeChannelColor') {
      const p = node.params as { target?: unknown; paramPath?: unknown };
      if (
        typeof p.target === 'string' &&
        childIds.has(p.target) &&
        isImportedChildMaterialPath(p.paramPath)
      ) {
        out.push(node);
      }
    }
  }
  return out;
}
