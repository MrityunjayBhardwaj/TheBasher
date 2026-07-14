// CurvePointRows — the numeric control-point editor in the Curve inspector section (#321).
//
// NOT OperatorStackRows. The rows LOOK similar, and that similarity is a trap: a stack row
// is a NODE (it has an id, a mute flag, an order field, and clicking it selects that node).
// A curve point is none of those — it is an element of an array param, with no identity of
// its own beyond its index. Sharing the stack component here would mean inventing a mute
// and an id a point doesn't have. The shared thing across the two is a flexbox row, which
// is not an abstraction worth a component.
//
// Every edit goes through curvePointCommands.ts — the SAME commit layer the viewport handles
// (#322) use — so typing a coordinate and dragging the point in 3D produce identical ops AND
// the same sub-selection bookkeeping (an insert or delete re-indexes the points after it; if
// the panel skipped that, deleting a row would silently slide the viewport's point selection
// onto a different point). One dispatchAtomic per edit = one undo entry.
//
// A row also SELECTS its point (#322): the row and the viewport handle are two views of one
// thing, so clicking either highlights the handle and mounts the point gizmo on it — the
// panel and the viewport can't disagree about which point you are editing.
//
// REF: src/app/curvePointCommands.ts (the commit layer) + src/app/curvePoints.ts (the pure
//      op-builders); src/app/CurvePointHandles.tsx (the viewport twin); src/nodes/Curve.ts
//      (MIN_CURVE_POINTS); issues #321, #322.

import { useDagStore } from '../core/dag/store';
import { curvePointsOf } from './curvePoints';
import { deleteCurvePoint, insertCurvePoint, moveCurvePoint } from './curvePointCommands';
import { useCurveSelectionStore } from './stores/curveSelectionStore';
import { MIN_CURVE_POINTS } from '../nodes/Curve';
import type { Vec3 } from '../nodes/types';

const BTN =
  'rounded border border-border px-1.5 py-0.5 text-fg hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-40 disabled:hover:border-border disabled:hover:text-fg';

const AXES = ['x', 'y', 'z'] as const;

export function CurvePointRows({ nodeId }: { nodeId: string }) {
  const state = useDagStore((s) => s.state);
  const selectedCurve = useCurveSelectionStore((s) => s.nodeId);
  const selectedIndex = useCurveSelectionStore((s) => s.pointIndex);
  const points = curvePointsOf(state, nodeId);
  if (!points) return null;

  const atLimit = points.length <= MIN_CURVE_POINTS;

  function onAxis(index: number, axis: 0 | 1 | 2, raw: string) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    const p = points![index];
    const next: Vec3 = [axis === 0 ? n : p[0], axis === 1 ? n : p[1], axis === 2 ? n : p[2]];
    moveCurvePoint(nodeId, index, next);
  }

  return (
    <div data-testid="curve-points" className="flex flex-col gap-1 text-xs">
      {points.map((p, i) => {
        const selected = selectedCurve === nodeId && selectedIndex === i;
        return (
          <div
            key={i}
            data-testid={`curve-point-row-${i}`}
            data-selected={selected ? 'true' : undefined}
            onPointerDown={() => useCurveSelectionStore.getState().selectPoint(nodeId, i)}
            className={`flex items-center gap-1 rounded border px-1 py-0.5 ${
              selected ? 'border-accent' : 'border-border'
            }`}
          >
            <span className="w-4 shrink-0 text-fg/60">{i}</span>
            {AXES.map((axis, a) => (
              <input
                key={axis}
                type="number"
                step={0.1}
                value={p[a]}
                aria-label={`Point ${i} ${axis}`}
                data-testid={`curve-point-${i}-${axis}`}
                onChange={(e) => onAxis(i, a as 0 | 1 | 2, e.target.value)}
                className="w-full min-w-0 rounded border border-border bg-bg-2 px-1 py-0.5 text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
              />
            ))}
            <button
              type="button"
              data-testid={`curve-point-insert-${i}`}
              onClick={() => insertCurvePoint(nodeId, i)}
              className={BTN}
              title="Insert a point after this one"
            >
              +
            </button>
            <button
              type="button"
              data-testid={`curve-point-delete-${i}`}
              disabled={atLimit}
              onClick={() => deleteCurvePoint(nodeId, i)}
              className={BTN}
              title={atLimit ? 'A path needs at least two points' : 'Delete this point'}
            >
              ✕
            </button>
          </div>
        );
      })}
    </div>
  );
}
