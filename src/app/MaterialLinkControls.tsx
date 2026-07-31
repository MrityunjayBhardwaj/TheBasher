// MaterialLinkControls — the material data-block row (#394 S3d-c).
//
// Blender's material data-block field, in the position Blender puts it: at the top of the
// Material properties, above everything the material actually contains. It answers one
// question — WHERE does this node's material come from? — and offers the three acts that
// change the answer: pick an existing Material node, mint a new one, or unlink.
//
// ── WHAT THE ROW SAYS, AND WHY THAT IS THE WHOLE POINT ─────────────────────────────
//
// Before this row, "these three cubes share a material" was invisible: it was true, or
// not, and nothing on screen distinguished the two. The user count is what makes sharing
// a FACT the surface states rather than a coincidence the user has to remember. It is
// read-only on purpose — the count is a property of the graph, and the way to change it
// is to link or unlink, which is the rest of this row.
//
// ── THE BASE ROWS BELOW IT STAY EDITABLE, AND THAT IS RULED ────────────────────────
//
// The stage text said base rows should go read-only under a linked material, reusing the
// driven-param treatment. That is wrong and the measurement was already in the tree:
// disconnecting restores the authored param untouched, so the base is a FALLBACK, not
// dead state — and a covered value that a single click can uncover must be LABELLED, not
// locked, or an authoring road is put out of reach. The labelling is `suppliedBy`, which
// ships; this row is the affordance that makes the label's promise real, because "unlink"
// is the click that uncovers it.
//
// ── OFFER == ACCEPT ────────────────────────────────────────────────────────────────
//
// Every action is offered exactly when its builder would accept it, by asking the builder
// itself rather than re-deriving the condition: the row does not render at all for a node
// with no `material` socket, and unlink is absent when there is nothing to unlink. The
// picker's candidates come from the registry, so a future material producer joins it
// without a change here.
//
// REF: src/app/materialLink.ts (every builder + the entry-0 read); src/nodes/materialSocket.ts
//      (socket supersedes param, wholesale); src/app/MaterialStackControls.tsx (the
//      operators composed OVER whatever this row selects); src/app/NPanel.tsx (renders
//      this at the head of the 'material' section). Issues #394, #510, #525.

import { useDagStore } from '../core/dag/store';
import { useSelectionStore } from './stores/selectionStore';
import {
  buildLinkMaterialOps,
  buildNewMaterialOps,
  buildUnlinkMaterialOps,
  hasMaterialSocket,
  materialCandidates,
  materialUserCount,
  resolveMaterialLink,
} from './materialLink';
import { nodeDisplayName } from './sceneTreeWalk';

const BTN =
  'rounded border border-border px-1.5 py-0.5 text-fg hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent';

export function MaterialLinkControls({ nodeId }: { nodeId: string }) {
  const state = useDagStore((s) => s.state);
  const select = useSelectionStore((s) => s.select);

  // Nodes that declare the 'material' section without taking a material over an edge —
  // the Material node itself, the scene-band override, the glTF pair, scatter, and
  // `BakedData`, whose material arrives with its baked payload. There is no pointer to
  // show and no link to make, so the row is absent rather than empty. Same split as the
  // stack panel: the section table gates on declaration, the component on possession,
  // because possession here needs the registry and `SectionCtx` deliberately has none.
  if (!hasMaterialSocket(state, nodeId)) return null;

  const linkedId = resolveMaterialLink(state, nodeId);
  const candidates = materialCandidates(state);
  const users = linkedId ? materialUserCount(state, linkedId) : 0;

  function dispatch(ops: ReturnType<typeof buildUnlinkMaterialOps>, label: string) {
    if (ops) useDagStore.getState().dispatchAtomic(ops, 'user', label);
  }

  function onPick(materialNodeId: string) {
    if (!materialNodeId) return;
    dispatch(
      buildLinkMaterialOps(useDagStore.getState().state, nodeId, materialNodeId),
      'link material',
    );
  }

  function onNew() {
    const res = buildNewMaterialOps(useDagStore.getState().state, nodeId);
    if (!res) return;
    useDagStore.getState().dispatchAtomic(res.ops, 'user', 'new material');
  }

  function onUnlink() {
    dispatch(buildUnlinkMaterialOps(useDagStore.getState().state, nodeId), 'unlink material');
  }

  const linkedNode = linkedId ? state.nodes[linkedId] : null;

  return (
    <div data-testid="material-link" className="flex flex-col gap-1 text-xs">
      <div className="flex items-center gap-1">
        <select
          data-testid="material-link-picker"
          className="min-w-0 flex-1 rounded border border-border bg-bg-2 px-1 py-0.5 text-fg"
          value={linkedId ?? ''}
          onChange={(e) => onPick(e.target.value)}
        >
          {/* The empty entry is a LABEL for the unlinked state, not an action: picking it
              is ignored (`onPick` returns early) because unlinking has its own button and
              two roads to one act is how they drift apart. */}
          <option value="">— this node's own material —</option>
          {candidates.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
        <button type="button" className={BTN} data-testid="material-link-new" onClick={onNew}>
          New Material
        </button>
        {linkedId && (
          <button
            type="button"
            className={BTN}
            data-testid="material-link-unlink"
            onClick={onUnlink}
            title="Unlink — fall back to this node's own material"
          >
            ✕
          </button>
        )}
      </div>
      {linkedId && linkedNode ? (
        <p data-testid="material-link-status" className="px-1 text-fg/60">
          linked ·{' '}
          <button
            type="button"
            className="underline hover:text-accent"
            data-testid="material-link-goto"
            onClick={() => select(linkedId)}
          >
            {nodeDisplayName(linkedNode)}
          </button>{' '}
          · <span data-testid="material-link-users">{users}</span> {users === 1 ? 'user' : 'users'}
        </p>
      ) : (
        <p data-testid="material-link-status" className="px-1 text-fg/60">
          inline · not shared
        </p>
      )}
    </div>
  );
}
