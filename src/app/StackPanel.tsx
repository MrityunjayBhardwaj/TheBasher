// StackPanel — one panel that draws any stack the translator builds, and edits it (#1817).
//
// Whatever lane it shows (modifiers, constraints, materials, effects), it reads the same tree
// (`stackOf`) and writes through the same edits (`planStackEdit`), so the lanes look and behave
// alike, and the panel holds nothing of its own but which groups are open:
//   - rows read in apply order, first applied on top (the user's decision, 2026-11-09): a node's
//     main input is drawn above it; every other input is a group under it that opens and closes,
//     and says how many rows it holds while closed;
//   - a "same as" row jumps to the node's full row, opening what it sits in;
//   - a template opens in place, and says that an edit inside reaches every instance;
//   - a row shows its mute when its type has one, and any param a wired input overrides;
//   - add, delete, move, drag into or out of a group, reorder a list's routes, mute and make
//     unique each run one edit, and a refused edit says why on the panel.
//
// It grows out of `OperatorStackRows.tsx` (#312), the shared row of the four stacks today: the
// same look and buttons, over a tree instead of a list. #1818 moves those stacks onto it.
//
// REF: issue #1817 and the mockup on #1815; src/app/stackPanelModel.ts; src/app/stackEdit.ts.

import { useEffect, useMemo, useState, type DragEvent, type ReactNode } from 'react';
import { useDagStore } from '../core/dag/store';
import type { NodeRef } from '../core/dag/types';
import { useSelectionStore } from './stores/selectionStore';
import { planStackEdit, type StackEdit, type StackPlace } from './stackEdit';
import {
  emptySockets,
  freshId,
  groupLabel,
  nameOf,
  offersAt,
  openPaths,
  rowCount,
  rowView,
  stackObjectOf,
  type Offer,
} from './stackPanelModel';
import { stackOf, type StackGroup, type StackNodeRow, type StackRow } from './stackTree';

const BTN =
  'rounded border border-border px-1.5 py-0.5 text-fg hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-40 disabled:hover:border-border disabled:hover:text-fg';
const CHIP =
  'rounded border border-dashed border-border px-1.5 py-0.5 text-fg-dim hover:border-accent hover:text-accent';

export interface StackPanelProps {
  /** The output whose stack this is: it draws last, as what is applied last. */
  readonly output: NodeRef;
  /** Prefixes every data-testid. */
  readonly testIdPrefix?: string;
  /**
   * Show one lane of `output`: only the groups on this socket of the top row, which itself is not
   * drawn. The view stays rooted at `output`, so a row can still go on top of the lane's top row.
   */
  readonly lane?: string;
}

/** The Constraint Stack card: the constraints lane of the selected object, or of a selected step's. */
export function ConstraintStackCard({ nodeId }: { readonly nodeId: string }) {
  const object = useDagStore((s) => stackObjectOf(s.state, nodeId));
  const output = useMemo(() => ({ node: object, socket: 'out' }), [object]);
  return <StackPanel output={output} lane="constraints" testIdPrefix="constraint-chain" />;
}

/** The key a template row's inside opens and closes by. */
const insideKey = (row: StackNodeRow) => `${row.key}:inside`;

export function StackPanel({ output, testIdPrefix = 'stack', lane }: StackPanelProps) {
  const state = useDagStore((s) => s.state);
  const selectedNodeId = useSelectionStore((s) => s.selectedNodeId);
  const select = useSelectionStore((s) => s.select);
  const rows = useMemo(() => stackOf(state, output), [state, output]);
  const paths = useMemo(() => openPaths(rows), [rows]);

  // Groups are open and template insides closed until a person says otherwise: `flipped` holds
  // the keys they have toggled away from that.
  const [flipped, setFlipped] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ place: StackPlace; offers: Offer[]; at: string } | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);

  const isOpen = (key: string, byDefault: boolean) => flipped.has(key) !== byDefault;
  const toggle = (key: string) =>
    setFlipped((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  useEffect(() => {
    if (!focus) return;
    const el = document.querySelector(`[data-row-key="${CSS.escape(focus)}"]`);
    (el as HTMLElement | null)?.scrollIntoView?.({ block: 'nearest' });
    setFocus(null);
  }, [focus]);

  const p = testIdPrefix;

  function run(edit: StackEdit, what: string) {
    const now = useDagStore.getState().state;
    const plan = planStackEdit(now, output, edit);
    if (!plan.ok) {
      setNotice(plan.reason);
      return;
    }
    setNotice(null);
    setMenu(null);
    if (plan.ops.length > 0) useDagStore.getState().dispatchAtomic(plan.ops, 'user', what);
  }

  function openMenu(place: StackPlace, at: string) {
    if (menu?.at === at) return setMenu(null);
    const offers = offersAt(useDagStore.getState().state, output, place);
    setNotice(offers.length === 0 ? 'Nothing can go there.' : null);
    setMenu(offers.length > 0 ? { place, offers, at } : null);
  }

  function add(type: string) {
    if (!menu) return;
    const now = useDagStore.getState().state;
    const nodeId = freshId(now, type);
    // The selection stays where it is, as the old stacks' "+ Add" leaves it: selecting the new
    // node would move the inspector to it, and the panel out from under the person's hand.
    run({ kind: 'add', nodeId, nodeType: type, place: menu.place }, 'stack: add');
  }

  /** Shows a node's full row: opens every group it sits in, selects it and scrolls to it. */
  function jumpTo(nodeId: string) {
    const path = paths.get(nodeId) ?? [];
    setFlipped((prev) => {
      const next = new Set(prev);
      for (const key of path) {
        const byDefault = !key.endsWith(':inside');
        if (next.has(key) === byDefault) {
          if (byDefault) next.delete(key);
          else next.add(key);
        }
      }
      return next;
    });
    select(nodeId);
    setFocus(nodeId);
  }

  const dropOn = (place: StackPlace) => ({
    onDragOver: (e: DragEvent) => {
      if (dragging) e.preventDefault();
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      const row = dragging ?? e.dataTransfer?.getData('text/plain');
      setDragging(null);
      if (row) run({ kind: 'regroup', row, place }, 'stack: move into group');
    },
  });

  function menuFor(at: string): ReactNode {
    if (menu?.at !== at) return null;
    return (
      <div
        data-testid={`${p}-menu`}
        className="ml-4 flex flex-wrap gap-1 rounded border border-border bg-bg-2 p-1"
      >
        {menu.offers.map((o) => (
          <button
            key={o.type}
            type="button"
            data-testid={`${p}-offer-${o.type}`}
            className={BTN}
            onClick={() => add(o.type)}
          >
            {o.label}
          </button>
        ))}
      </div>
    );
  }

  function renderGroup(owner: StackNodeRow, group: StackGroup, named: string | null): ReactNode {
    // Under a name, every row is the named object's: shown, not edited here.
    const under = named ?? (group.reference ? (group.rows[0]?.nodeId ?? null) : null);
    const open = isOpen(group.key, true);
    const list = group.index !== null;
    const routes = list ? owner.groups.filter((g) => g.socket === group.socket).length : 0;
    return (
      <div key={group.key} className="ml-3 border-l border-border pl-1.5">
        <div
          data-testid={`${p}-group-${group.key}`}
          className="flex items-center gap-1 text-fg-dim"
          {...(named ? {} : dropOn({ route: { owner: owner.key, socket: group.socket } }))}
        >
          <button
            type="button"
            data-testid={`${p}-toggle-${group.key}`}
            aria-expanded={open}
            onClick={() => toggle(group.key)}
            className="flex-1 truncate text-left hover:text-fg"
          >
            {open ? '▾' : '▸'} {groupLabel(group)}
            <span> · {group.wireType}</span>
            {group.reference ? <span> · by name ({group.reference})</span> : null}
            {group.active ? <span className="text-accent"> · active</span> : null}
            {open ? null : (
              <span data-testid={`${p}-count-${group.key}`}>
                {' '}
                · {rowCount(group.rows)} node{rowCount(group.rows) === 1 ? '' : 's'}
              </span>
            )}
          </button>
          {list && !named ? (
            <>
              <button
                type="button"
                data-testid={`${p}-route-up-${group.key}`}
                className={BTN}
                disabled={group.index === 0}
                title="Earlier in the list"
                onClick={() =>
                  run(
                    {
                      kind: 'reorderRoutes',
                      row: owner.key,
                      socket: group.socket,
                      from: group.index!,
                      to: group.index! - 1,
                    },
                    'stack: reorder routes',
                  )
                }
              >
                ▲
              </button>
              <button
                type="button"
                data-testid={`${p}-route-down-${group.key}`}
                className={BTN}
                disabled={group.index === routes - 1}
                title="Later in the list"
                onClick={() =>
                  run(
                    {
                      kind: 'reorderRoutes',
                      row: owner.key,
                      socket: group.socket,
                      from: group.index!,
                      to: group.index! + 1,
                    },
                    'stack: reorder routes',
                  )
                }
              >
                ▼
              </button>
            </>
          ) : null}
        </div>
        {open ? renderRun(group.rows, under) : null}
      </div>
    );
  }

  function renderNode(
    row: StackNodeRow,
    run_: readonly StackRow[],
    index: number,
    named: string | null,
  ): ReactNode {
    const editable = named === null;
    const view = rowView(state, row);
    const active = row.nodeId === selectedNodeId;
    const empty = emptySockets(state, row);
    const inside = row.template ? isOpen(insideKey(row), false) : false;
    const addAt = `${row.key}:above`;
    return (
      <div key={row.key} className="flex flex-col gap-0.5">
        <div
          data-testid={`${p}-row-${row.key}`}
          data-row-key={row.nodeId}
          draggable={editable}
          onDragStart={(e) => {
            setDragging(row.key);
            e.dataTransfer?.setData('text/plain', row.key);
          }}
          onDragEnd={() => setDragging(null)}
          {...(editable ? dropOn({ above: row.key }) : {})}
          className={`group flex items-center gap-1 rounded border px-1 py-0.5 ${
            active ? 'border-accent bg-bg-2' : 'border-border'
          }`}
        >
          <button
            type="button"
            onClick={() => select(row.nodeId)}
            className={`flex-1 truncate text-left ${view.muted ? 'text-fg/60 line-through' : 'text-fg'}`}
            title={`${view.name} · ${view.type}`}
          >
            {view.name}
            {view.name !== view.type ? <span className="text-fg-dim"> · {view.type}</span> : null}
            {view.tag ? <span className="text-fg-dim"> [{view.tag}]</span> : null}
          </button>
          {named === row.nodeId ? (
            <button
              type="button"
              data-testid={`${p}-goto-${row.key}`}
              className={BTN}
              title={`Edit ${view.name} on its own`}
              onClick={() => select(row.nodeId)}
            >
              go to
            </button>
          ) : null}
          {editable && view.muted !== null ? (
            <button
              type="button"
              data-testid={`${p}-mute-${row.key}`}
              aria-pressed={view.muted}
              className={BTN}
              title={view.muted ? 'Un-mute (re-enable)' : 'Mute (bypass)'}
              onClick={() => run({ kind: 'mute', row: row.key }, 'stack: mute')}
            >
              {view.muted ? '◌' : '●'}
            </button>
          ) : null}
          {/* The edits stay out of the way until a person points at the row or selects it, and a
              row this stack only reaches by a name has none: it is edited on its own object. */}
          {editable ? (
            <span
              className={`items-center gap-1 ${active ? 'flex' : 'hidden group-hover:flex group-focus-within:flex'}`}
            >
              {/* Drawn in apply order, so ▲ is earlier: one place further from the output, which
                  is a higher index in the edit's run (0 = the row the output reads). */}
              <button
                type="button"
                data-testid={`${p}-up-${row.key}`}
                className={BTN}
                disabled={index === run_.length - 1}
                title="Move up (applied earlier)"
                onClick={() => run({ kind: 'move', row: row.key, to: index + 1 }, 'stack: move')}
              >
                ▲
              </button>
              <button
                type="button"
                data-testid={`${p}-down-${row.key}`}
                className={BTN}
                disabled={index === 0}
                title="Move down (applied later)"
                onClick={() => run({ kind: 'move', row: row.key, to: index - 1 }, 'stack: move')}
              >
                ▼
              </button>
              <button
                type="button"
                data-testid={`${p}-add-${row.key}`}
                className={BTN}
                title="Add after this row (applied next)"
                onClick={() => openMenu({ above: row.key }, addAt)}
              >
                +
              </button>
              <button
                type="button"
                data-testid={`${p}-remove-${row.key}`}
                className={BTN}
                title="Remove"
                onClick={() => run({ kind: 'delete', row: row.key }, 'stack: delete')}
              >
                ✕
              </button>
            </span>
          ) : null}
        </div>
        {menuFor(addAt)}
        {/* On a line of their own: in a panel as narrow as the inspector, the row's own line
            truncates, and an influence cut off at the edge is an influence nobody reads. */}
        {view.influence !== null ? (
          <p data-testid={`${p}-influence-${row.key}`} className="ml-4 text-fg-dim">
            influence {view.influence}
          </p>
        ) : null}
        {row.usedBy.length > 0 ? (
          <p data-testid={`${p}-usedby-${row.key}`} className="ml-4 truncate text-fg-dim">
            used by {row.usedBy.map((id) => nameOf(state, id)).join(', ')}
          </p>
        ) : null}
        {view.exposed.length > 0 ? (
          <p data-testid={`${p}-exposed-${row.key}`} className="ml-4 text-fg-dim">
            {view.exposed.map((o) => `${o.param} ${o.value}`).join(' · ')}
          </p>
        ) : null}
        {view.overridden.map((o) => (
          <p
            key={o.param}
            data-testid={`${p}-overridden-${row.key}-${o.param}`}
            className="ml-4 text-fg-dim"
          >
            {o.param} {o.value} → overridden by input
          </p>
        ))}
        {row.template ? (
          <div className="ml-3 flex flex-col gap-0.5">
            <div className="flex items-center gap-1 text-fg-dim">
              <button
                type="button"
                data-testid={`${p}-toggle-${insideKey(row)}`}
                aria-expanded={inside}
                className="flex-1 truncate text-left hover:text-fg"
                onClick={() => toggle(insideKey(row))}
              >
                {inside ? '▾' : '▸'} inside
                {row.template.locked ? ' · locked' : ''}
                {inside ? null : ` · ${rowCount(row.template.inside)} nodes`}
              </button>
              {editable && row.template.instances > 1 ? (
                <button
                  type="button"
                  data-testid={`${p}-unique-${row.key}`}
                  className={BTN}
                  title="Give this instance its own copy of the template"
                  onClick={() => run({ kind: 'makeUnique', row: row.key }, 'stack: make unique')}
                >
                  make unique
                </button>
              ) : null}
            </div>
            {inside ? (
              <>
                <p data-testid={`${p}-template-notice-${row.key}`} className="text-warn">
                  ⚠ edits here change the template → all {row.template.instances} instance
                  {row.template.instances === 1 ? '' : 's'}
                </p>
                <div className="border-l border-border pl-1.5">
                  {renderRun(row.template.inside, named)}
                </div>
              </>
            ) : null}
          </div>
        ) : null}
        {row.groups.map((g) => renderGroup(row, g, named))}
        {editable && active && empty.length > 0 ? (
          <div className="ml-3 flex flex-wrap items-center gap-1">
            {empty.map((socket) => {
              const at = `${row.key}:${socket}:route`;
              return (
                <span key={socket} className="contents">
                  <button
                    type="button"
                    data-testid={`${p}-empty-${row.key}-${socket}`}
                    className={CHIP}
                    title={`Add something into "${socket}"`}
                    onClick={() => openMenu({ route: { owner: row.key, socket } }, at)}
                    {...dropOn({ route: { owner: row.key, socket } })}
                  >
                    + {socket}
                  </button>
                  {menuFor(at)}
                </span>
              );
            })}
          </div>
        ) : null}
      </div>
    );
  }

  /**
   * A flat run in apply order: what is applied first on top, read top to bottom as a person reads
   * (the user's decision, 2026-11-09, as Blender's Modifier and Constraint tabs list them). The tree
   * holds a run output-first, so it is drawn reversed, and each row keeps its index in the tree's
   * order, which is what the edits speak.
   */
  function renderRun(list: readonly StackRow[], named: string | null = null): ReactNode {
    const applied = list.map((row, i) => ({ row, i })).reverse();
    return (
      <div className="flex flex-col gap-0.5">
        {applied.map(({ row, i }) =>
          row.kind === 'node' ? (
            renderNode(row, list, i, named)
          ) : (
            <div
              key={row.key}
              data-testid={`${p}-same-${row.key}`}
              className="flex items-center gap-1 rounded border border-dashed border-border px-1 py-0.5 text-fg-dim"
            >
              <button
                type="button"
                data-testid={`${p}-jump-${row.key}`}
                className="flex-1 truncate text-left hover:text-fg"
                title="Show the full row"
                onClick={() => jumpTo(row.nodeId)}
              >
                ⤷ {nameOf(state, row.nodeId)} = same node, shown in full elsewhere
              </button>
              {named ? null : (
                <button
                  type="button"
                  data-testid={`${p}-remove-${row.key}`}
                  className={BTN}
                  title="Stop reading it here"
                  onClick={() => run({ kind: 'delete', row: row.key }, 'stack: delete')}
                >
                  ✕
                </button>
              )}
            </div>
          ),
        )}
      </div>
    );
  }

  function renderLane(socket: string): ReactNode {
    const top = rows[0];
    if (top?.kind !== 'node') return null;
    const groups = top.groups.filter((g) => g.socket === socket);
    const at = `${top.key}:${socket}:route`;
    return (
      <>
        {groups.map((g) => (
          <div key={g.key} className="flex flex-col gap-0.5">
            {renderRun(g.rows)}
          </div>
        ))}
        {groups.length === 0 ? (
          <>
            <button
              type="button"
              data-testid={`${p}-empty-${top.key}-${socket}`}
              className={`${CHIP} self-start`}
              onClick={() => openMenu({ route: { owner: top.key, socket } }, at)}
              {...dropOn({ route: { owner: top.key, socket } })}
            >
              + add
            </button>
            {menuFor(at)}
          </>
        ) : null}
      </>
    );
  }

  return (
    <div data-testid={`${p}-panel`} className="flex flex-col gap-1 text-xs">
      {notice ? (
        <p
          data-testid={`${p}-notice`}
          role="status"
          className="rounded border border-border-strong bg-warn/10 px-1.5 py-1 text-warn"
        >
          {notice}
        </p>
      ) : null}
      {rows.length === 0 ? <p className="px-1 py-0.5 text-fg/60">Nothing to show.</p> : null}
      {lane ? renderLane(lane) : renderRun(rows)}
    </div>
  );
}
