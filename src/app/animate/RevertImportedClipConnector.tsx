// RevertImportedClipConnector — the "revert to imported clip" affordance for a
// baked glTF bone (issue #121, the P7.12 D3 UI follow-on). The NPanel inspector
// renders this when a GltfChild is selected; the button appears ONLY when the
// bone actually has baked KeyframeChannel nodes (the copy-on-write edit layer).
//
// Clicking it dispatches `dispatchRevertGltfChannel` → deletes the bone's baked
// node(s) → the resolver's presence-based pick falls back to the imported clip
// on BOTH surfaces (renderer C2 + gizmo/NPanel C3), as ONE undo. This is the
// missing production caller for the D3 revert (which until now was only reached
// programmatically / in e2e).
//
// V8: reads DAG state via a SUBSCRIBED selector (so the button appears on bake
// and disappears on revert) and mutates ONLY through the Op/mutator seam
// (`dispatchRevertGltfChannel`). The baked-channel detection reuses the SAME
// deterministic id (`gltfChannelDagId`) the bake mutator writes and the revert
// deletes — one source of the key, never a parallel derivation.
//
// REF: issue #121, #108 D3; `dispatchMutator.ts` (`dispatchRevertGltfChannel`);
//      `gltfImportChain.ts` (`gltfChannelDagId`); [[V26]] (the bone's key).

import { useDagStore } from '../../core/dag/store';
import { gltfChannelDagId } from '../../core/import/gltfImportChain';
import { dispatchRevertGltfChannel } from './dispatchMutator';

const COMPONENTS = ['position', 'rotation', 'scale'] as const;

export function RevertImportedClipConnector({
  assetRef,
  childName,
}: {
  assetRef: string;
  childName: string;
}) {
  // Subscribed boolean: any of the bone's deterministic baked-channel ids
  // present ⇒ the bone is edited (baked). Flips to false the frame the revert
  // deletes them, so the button hides itself.
  const isBaked = useDagStore((s) =>
    COMPONENTS.some((c) => Boolean(s.state.nodes[gltfChannelDagId(assetRef, childName, c)])),
  );
  if (!isBaked) return null;
  return (
    <div className="border-t border-border bg-muted/30 px-3 py-2">
      <button
        type="button"
        data-testid="revert-imported-clip"
        onClick={() => dispatchRevertGltfChannel({ assetRef, childName })}
        className="w-full rounded border border-border px-2 py-1 text-[11px] text-fg/80 hover:bg-muted hover:text-fg"
        title="Delete this bone's edited keyframes and restore the imported animation"
      >
        Revert to imported clip
      </button>
    </div>
  );
}
