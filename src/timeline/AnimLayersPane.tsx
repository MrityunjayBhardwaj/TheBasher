// AnimLayersPane — the drawer's Anim Layers tab: the selected character's pose layers as rows, with a
// lane for each across the time ruler and the playhead running through them (#1956, design board 14d).
//
// A CONTAINER, not a row. The rows show each layer as it is today (name, blend mode, weight, solo,
// mute) and the selected layer's settings are the shared param rows (`ParamRow`), so editing one here
// is editing the layer itself: one source, two views. (Keying the weight from its row does nothing
// yet anywhere, #1958; it is the shared row's to wire, not this tab's.) The parts of the
// shared layer row being built on its own track (an influence slider in the row, the key dot, the
// keyed weight curve drawn in the lane, per-bone values) are NOT drawn here; a lane says plainly
// whether its weight is keyed instead of drawing a curve it does not have.
//
// The footer's three edits are roads that exist: + Add Layer and Delete are the shared stack edit on
// the Object's pose lane, Bake down is the agent's bake verb at the selected layer (animLayersModel).
//
// V8: reads DAG state through subscribed selectors; mutates only through dispatchAtomic and the
// mutator seam. The selected row is this pane's own, so picking one never moves the inspector.
//
// REF: issue #1956; design board 14d; src/timeline/animLayersModel.ts.

import { useMemo, useState, type ReactNode } from 'react';
import { useDagStore } from '../core/dag/store';
import { useSelectionStore } from '../app/stores/selectionStore';
import { useTimeStore } from '../app/stores/timeStore';
import { useNotificationStore } from '../app/stores/notificationStore';
import { dispatchMutatorFromUI } from '../app/animate/dispatchMutator';
import { ParamRow } from '../app/NPanel';
import { nodeDisplayName } from '../app/sceneTreeWalk';
import { useTimelineSpan } from './timelineSpan';
import {
  addLayerPlan,
  animLayersView,
  bakeDownArgs,
  deleteLayerPlan,
  filterLayerRows,
  type AnimLayerRow,
} from './animLayersModel';

/** The row column's width, as the board draws it. */
export const ANIM_LAYERS_ROW_COLUMN_PX = 360;
/** The gap the lanes keep at the right edge. */
const LANE_RIGHT_PX = 12;
const RULER_PX = 26;
const ROW_PX = 40;
/** The settings a layer is edited by, in the order the row reads them. */
const LAYER_SETTINGS = ['name', 'mode', 'weight', 'solo', 'mute'] as const;

const FOOTER_BTN =
  'h-[22px] rounded border border-border px-2 text-fg hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:cursor-not-allowed disabled:text-fg-dim disabled:hover:bg-transparent';

const MODE_LABEL: Record<string, string> = { override: 'Override', additive: 'Add', ik: 'IK' };

/** Where along the lanes a time falls, 0..1. */
export function laneFraction(seconds: number, span: number): number {
  if (!(span > 0)) return 0;
  return Math.min(1, Math.max(0, seconds / span));
}

/** A CSS left for a fraction of the lane width (the lanes start after the row column). */
const laneLeft = (t: number) =>
  `calc(${ANIM_LAYERS_ROW_COLUMN_PX}px + (100% - ${ANIM_LAYERS_ROW_COLUMN_PX + LANE_RIGHT_PX}px) * ${t})`;

export function AnimLayersPane() {
  const state = useDagStore((s) => s.state);
  const selectedId = useSelectionStore((s) => s.selectedNodeId);
  const seconds = useTimeStore((s) => s.seconds);
  const { span } = useTimelineSpan();
  const view = useMemo(() => animLayersView(state, selectedId), [state, selectedId]);
  const [filter, setFilter] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const rows = useMemo(() => filterLayerRows(view.rows, filter), [view.rows, filter]);
  const all = [...view.rows, ...(view.base ? [view.base] : [])];
  // The picked row, while it is still a row here; else the top layer, else the base.
  const current = all.find((r) => r.id === picked) ?? all[0] ?? null;

  if (view.empty !== null || view.subject === null) {
    return (
      <div
        data-testid="anim-layers-empty"
        data-reason={view.empty ?? 'nothing-selected'}
        className="flex flex-1 flex-col items-center justify-center gap-1 p-4 text-xs text-fg-dim"
      >
        {view.empty === 'not-a-character' && selectedId ? (
          <>
            <span>{nodeDisplayName(state.nodes, selectedId)} has no pose layers.</span>
            <span>Pose layers sit on a character’s armature: select a character to see them.</span>
          </>
        ) : (
          <span>Select a character to see its pose layers.</span>
        )}
      </div>
    );
  }
  const subject = view.subject;
  const t = laneFraction(seconds, span);

  const run = (
    ops: Parameters<ReturnType<typeof useDagStore.getState>['dispatchAtomic']>[0],
    label: string,
  ) => useDagStore.getState().dispatchAtomic(ops, 'user', label);

  function onAdd() {
    const plan = addLayerPlan(useDagStore.getState().state, subject);
    if (!plan.ok) return setNotice(plan.reason);
    setNotice(null);
    run(plan.ops, 'add pose layer');
    setPicked(plan.nodeId);
  }

  function onDelete() {
    if (!current) return;
    const plan = deleteLayerPlan(useDagStore.getState().state, subject, current.id);
    if (!plan.ok) return setNotice(plan.reason);
    setNotice(null);
    run(plan.ops, 'delete pose layer');
    setPicked(null);
  }

  function onBakeDown() {
    if (!current) return;
    const args = bakeDownArgs(useDagStore.getState().state, subject, current.id);
    if (!args) return setNotice('Pick a layer above the base to bake down.');
    const res = dispatchMutatorFromUI('mutator.animate.bakePose', args, 'bake down pose layers');
    if (!res.ok) {
      setNotice(`Could not bake down: ${res.reason}`);
      return;
    }
    setNotice(null);
    useNotificationStore.getState().notify({
      severity: 'info',
      message: `Baked ${current.name} and the layers under it into a new base; they are muted, not removed.`,
    });
    setPicked(null);
  }

  const lanesHeight = RULER_PX + (rows.length + 1) * ROW_PX;
  const canDelete = current !== null && !current.locked;
  const canBake = current !== null && current.kind === 'layer' && !current.locked;

  return (
    <div data-testid="anim-layers" className="flex min-w-0 flex-1 flex-col text-xs">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-3">
        <span data-testid="anim-layers-subject" className="font-semibold text-fg">
          {nodeDisplayName(state.nodes, subject)}
        </span>
        <span className="text-fg-dim">pose layers · top row applied last</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="relative" style={{ height: lanesHeight }}>
          {/* The ruler row: the filter over the rows, the time ruler over the lanes. */}
          <div
            className="absolute left-0 top-0 flex items-center border-b border-r border-border px-2.5"
            style={{ width: ANIM_LAYERS_ROW_COLUMN_PX, height: RULER_PX }}
          >
            <input
              type="text"
              data-testid="anim-layers-filter"
              aria-label="Filter layers"
              placeholder="Filter layers"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="h-5 w-full rounded border border-border bg-bg px-2 text-[11.5px] text-fg focus-visible:border-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            />
          </div>
          <Ruler span={span} />

          {rows.map((row, i) => (
            <LayerBand
              key={row.id}
              row={row}
              top={RULER_PX + i * ROW_PX}
              selected={current?.id === row.id}
              onPick={() => setPicked(row.id)}
            />
          ))}
          <BaseBand
            base={view.base}
            source={view.source}
            top={RULER_PX + rows.length * ROW_PX}
            selected={view.base !== null && current?.id === view.base.id}
            onPick={() => view.base && setPicked(view.base.id)}
            emptyNote={
              view.rows.length === 0
                ? 'No layers above the base yet: + Add Layer puts one on top.'
                : rows.length === 0
                  ? 'No layer matches the filter.'
                  : null
            }
          />

          <div
            data-testid="anim-layers-playhead"
            data-t={t.toFixed(4)}
            aria-hidden="true"
            className="pointer-events-none absolute top-0 w-0.5 bg-fg"
            style={{ left: laneLeft(t), height: lanesHeight }}
          />
        </div>

        {current ? <LayerSettings row={current} /> : null}
      </div>

      <div className="flex h-8 shrink-0 items-center justify-between gap-2 border-t border-border bg-bg-2 px-2.5">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            data-testid="anim-layers-add"
            className={FOOTER_BTN}
            disabled={!view.canAdd}
            title="A new layer on top: applied last, over everything under it"
            onClick={onAdd}
          >
            + Add Layer
          </button>
          <button
            type="button"
            data-testid="anim-layers-bake"
            className={FOOTER_BTN}
            disabled={!canBake}
            title="Bake this layer and the ones under it into keys on a new base; they are muted, not removed"
            onClick={onBakeDown}
          >
            Bake down
          </button>
          <button
            type="button"
            data-testid="anim-layers-delete"
            className={FOOTER_BTN}
            disabled={!canDelete}
            title={current?.locked ? 'The base is locked' : 'Delete the selected layer'}
            onClick={onDelete}
          >
            Delete
          </button>
        </div>
        {notice ? (
          <span data-testid="anim-layers-notice" role="status" className="truncate text-warn">
            {notice}
          </span>
        ) : (
          <span className="truncate text-fg-dim">Pick a row to edit its layer below.</span>
        )}
      </div>
    </div>
  );
}

function Ruler({ span }: { span: number }) {
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  return (
    <div
      data-testid="anim-layers-ruler"
      className="absolute top-0 border-b border-border"
      style={{ left: ANIM_LAYERS_ROW_COLUMN_PX, right: LANE_RIGHT_PX, height: RULER_PX }}
    >
      {ticks.map((f) => (
        <span
          key={f}
          className="absolute top-2 font-mono text-[10.5px] tabular-nums text-fg-dim"
          style={f === 1 ? { right: 3 } : { left: f === 0 ? 3 : `${f * 100}%` }}
        >
          {(span * f).toFixed(1)}
        </span>
      ))}
    </div>
  );
}

function Band({
  testId,
  top,
  height = ROW_PX,
  selected,
  head,
  lane,
}: {
  testId: string;
  top: number;
  height?: number;
  selected: boolean;
  head: ReactNode;
  lane: ReactNode;
}) {
  return (
    <>
      <div
        className={`absolute inset-x-0 border-b border-border/40 ${selected ? 'bg-accent/10' : ''}`}
        style={{ top, height }}
      />
      <div
        data-testid={testId}
        data-selected={selected}
        className="absolute left-0 flex items-center gap-1.5 overflow-hidden border-r border-border px-2.5"
        style={{ top, height, width: ANIM_LAYERS_ROW_COLUMN_PX }}
      >
        {head}
      </div>
      <div
        className="absolute flex items-center overflow-hidden pl-2.5"
        style={{ top, height, left: ANIM_LAYERS_ROW_COLUMN_PX, right: LANE_RIGHT_PX }}
      >
        {lane}
      </div>
    </>
  );
}

function LayerBand({
  row,
  top,
  selected,
  onPick,
}: {
  row: AnimLayerRow;
  top: number;
  selected: boolean;
  onPick: () => void;
}) {
  return (
    <Band
      testId={`anim-layers-row-${row.id}`}
      top={top}
      selected={selected}
      head={
        <button
          type="button"
          onClick={onPick}
          aria-pressed={selected}
          className={`flex h-[30px] min-w-0 flex-1 items-center gap-2 rounded px-1.5 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
            selected ? 'bg-muted text-fg ring-1 ring-accent' : 'text-fg hover:bg-muted'
          }`}
        >
          <span className="w-4 shrink-0 text-center text-fg-dim" aria-hidden="true">
            {row.kind === 'rig' ? '⛓' : '⌖'}
          </span>
          <span className={`min-w-0 flex-1 truncate ${row.mute ? 'text-fg-dim line-through' : ''}`}>
            {row.name}
          </span>
          {row.kind === 'layer' ? (
            <>
              <span className="font-mono text-[10.5px] tabular-nums text-fg-dim">
                {(row.weight ?? 1).toFixed(2)}
              </span>
              <span className="font-mono text-[10.5px] text-fg-dim">
                {MODE_LABEL[row.mode ?? 'override'] ?? row.mode}
              </span>
              {row.solo ? (
                <span
                  data-testid={`anim-layers-solo-${row.id}`}
                  className="text-[10.5px] text-warn"
                >
                  solo
                </span>
              ) : null}
              {row.mute ? (
                <span
                  data-testid={`anim-layers-muted-${row.id}`}
                  className="text-[10.5px] text-warn"
                >
                  muted
                </span>
              ) : null}
            </>
          ) : (
            <span className="text-[10.5px] text-fg-dim">Rig</span>
          )}
        </button>
      }
      lane={
        <span
          data-testid={`anim-layers-lane-${row.id}`}
          data-keyed={row.weightKeys > 0}
          className="truncate text-[11px] text-fg-dim"
        >
          {row.kind === 'rig'
            ? 'A Rig: the layers it holds are inside it.'
            : row.weightKeys > 0
              ? `Weight keyed (${row.weightKeys} key${row.weightKeys === 1 ? '' : 's'}): its curve isn’t drawn in this lane yet; Curves shows it.`
              : `Weight ${(row.weight ?? 1).toFixed(2)}, not keyed over time yet.`}
        </span>
      }
    />
  );
}

function BaseBand({
  base,
  source,
  top,
  selected,
  onPick,
  emptyNote,
}: {
  base: AnimLayerRow | null;
  source: string | null;
  top: number;
  selected: boolean;
  onPick: () => void;
  emptyNote: string | null;
}) {
  const label = base
    ? `Base · ${base.name}`
    : source
      ? `Source · ${source}`
      : 'Nothing poses it yet';
  return (
    <Band
      testId="anim-layers-base"
      top={top}
      selected={selected}
      head={
        <button
          type="button"
          onClick={onPick}
          disabled={!base}
          aria-pressed={selected}
          className="flex h-[30px] min-w-0 flex-1 items-center gap-2 rounded border border-dashed border-border px-1.5 text-left text-fg/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:cursor-default"
          style={{
            background:
              'repeating-linear-gradient(135deg, rgba(255,255,255,0.02) 0 6px, rgba(255,255,255,0.05) 6px 12px)',
          }}
        >
          <span className="w-4 shrink-0 text-center" aria-hidden="true">
            🔒
          </span>
          <span className="min-w-0 flex-1 truncate">{label}</span>
          <span className="font-mono text-[10.5px] text-fg-dim">locked</span>
        </button>
      }
      lane={
        <span className="truncate text-[11px] text-fg-dim">
          {emptyNote ??
            (base
              ? 'The character’s own motion, read off the rest pose. A bind replaces it.'
              : 'What the layers above play on.')}
        </span>
      }
    />
  );
}

/** The selected layer's settings: the shared param rows, so an edit here is the layer's own. */
function LayerSettings({ row }: { row: AnimLayerRow }) {
  const params = useDagStore(
    (s) => (s.state.nodes[row.id]?.params ?? null) as Record<string, unknown> | null,
  );
  if (!params) return null;
  return (
    <div data-testid="anim-layers-settings" className="border-t border-border bg-bg-2 py-1">
      <div className="flex items-center gap-2 px-3 py-1 text-[11px] text-fg-dim">
        <span className="font-semibold text-fg">{row.name}</span>
        <span>— selected {row.kind === 'rig' ? 'Rig' : 'layer'}</span>
      </div>
      {row.kind === 'layer' ? (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2">
            {LAYER_SETTINGS.filter((key) => key in params).map((key) => (
              <ParamRow key={key} nodeId={row.id} paramPath={key} value={params[key]} />
            ))}
          </div>
          <p className="px-3 py-1 text-[11px] text-fg-dim">
            The bones this layer holds and their values aren’t listed here yet.
          </p>
        </>
      ) : (
        <p className="px-3 py-1 text-[11px] text-fg-dim">
          Open it in Nodes to see the layers inside.
        </p>
      )}
    </div>
  );
}
