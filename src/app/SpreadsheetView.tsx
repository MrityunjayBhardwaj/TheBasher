// SpreadsheetView — the Spreadsheet editor space: every attribute of the selected node's mesh,
// one domain at a time, read-only (#1556). Blender's Spreadsheet editor and Houdini's Geometry
// Spreadsheet pane both show the evaluated geometry of what is selected this way.
//
// It owns no geometry logic: `attributeSheetOf` says what there is. Selection is the app's own,
// so selecting in the outliner, the viewport or the Graph space changes what it shows, and an
// edit to the graph is in the next draw. Only the rows on screen are drawn, so a mesh of
// hundreds of thousands of faces scrolls as one of six.
//
// File-rooted V8: src/app/. Read-only surface — never touches the DAG.

import { type ReactNode, useMemo, useState } from 'react';
import { useDagStore } from '../core/dag/store';
import { attributeSheetOf, type SheetColumn, type SheetDomain } from './attributeSheet';
import { useSelectionStore } from './stores/selectionStore';
import { uiEvaluatorCache } from './uiEvaluatorCache';

const ROW = 20;
const OVERSCAN = 10;
const AXES = ['x', 'y', 'z', 'w'];

/** One cell per number: a column of several numbers per element splits by axis. */
function cellsOf(c: SheetColumn): { label: string; at: (i: number) => number }[] {
  if (c.components === 1) return [{ label: c.name, at: (i) => c.data[i] }];
  return Array.from({ length: c.components }, (_, k) => ({
    label: `${c.name}.${AXES[k] ?? k}`,
    at: (i: number) => c.data[i * c.components + k],
  }));
}

const show = (type: string, v: number | undefined) =>
  v === undefined ? '' : type.startsWith('int') ? String(v) : v.toFixed(3);

export function SpreadsheetView(): ReactNode {
  const state = useDagStore((s) => s.state);
  const primary = useSelectionStore((s) => s.primaryNodeId);
  const sheet = useMemo(() => attributeSheetOf(state, primary, uiEvaluatorCache), [state, primary]);
  const [picked, setPicked] = useState<SheetDomain['domain']>('point');
  const [scroll, setScroll] = useState({ top: 0, height: 400 });

  if (sheet.status === 'none') {
    return (
      <div data-testid="sheet-view" className="flex h-full w-full flex-col bg-bg">
        <div className="border-b border-border bg-muted/30 px-3 py-1.5 text-[11px] font-medium text-fg">
          Spreadsheet
        </div>
        <p data-testid="sheet-none" className="p-4 text-[12px] text-fg-dim">
          {sheet.why}
        </p>
      </div>
    );
  }

  const domain = sheet.domains.find((d) => d.domain === picked) ?? sheet.domains[0];
  const cells = domain ? domain.columns.flatMap((c) => cellsOf(c).map((x) => ({ ...x, c }))) : [];
  const first = Math.max(0, Math.floor(scroll.top / ROW) - OVERSCAN);
  const last = domain
    ? Math.min(domain.count, Math.ceil((scroll.top + scroll.height) / ROW) + OVERSCAN)
    : 0;
  const rows = Array.from({ length: Math.max(0, last - first) }, (_, k) => first + k);

  return (
    <div data-testid="sheet-view" className="flex h-full w-full flex-col bg-bg text-[11px]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-muted/30 px-3 py-1.5 text-fg-dim">
        <span className="font-medium text-fg">Spreadsheet</span>
        <span data-testid="sheet-name" className="text-fg">
          {sheet.name}
        </span>
        <span className="flex-1" />
        {sheet.domains.map((d) => (
          <button
            key={d.domain}
            type="button"
            data-testid={`sheet-domain-${d.domain}`}
            data-active={d.domain === domain?.domain || undefined}
            onClick={() => {
              setPicked(d.domain);
              setScroll((s) => ({ ...s, top: 0 }));
            }}
            className={`rounded border px-2 py-0.5 tabular-nums ${
              d.domain === domain?.domain
                ? 'border-border-strong text-fg'
                : 'border-border hover:border-border-strong'
            }`}
          >
            {d.domain[0].toUpperCase() + d.domain.slice(1)} {d.count.toLocaleString()}
          </button>
        ))}
      </div>
      {sheet.notes.length > 0 && (
        <div data-testid="sheet-notes" className="border-b border-border px-3 py-1 text-fg-dim">
          {sheet.notes.join(' · ')}
        </div>
      )}
      {domain && (
        <div
          data-testid="sheet-table"
          className="relative flex-1 overflow-auto font-mono"
          style={{ minHeight: 0 }}
          ref={(el) => {
            if (el && el.clientHeight !== scroll.height)
              setScroll((s) => ({ ...s, height: el.clientHeight }));
          }}
          onScroll={(e) =>
            setScroll({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })
          }
        >
          <table className="tabular-nums" style={{ borderCollapse: 'collapse' }}>
            <thead className="sticky top-0 z-10 bg-bg-2">
              <tr style={{ height: ROW }}>
                <th className="border-b border-r border-border px-2 text-right text-fg-dim">#</th>
                {cells.map((x) => (
                  <th
                    key={x.label}
                    data-testid={`sheet-col-${x.label}`}
                    title={`${x.c.type}, from ${
                      x.c.from === 'stored'
                        ? 'the stored mesh'
                        : x.c.from === 'store'
                          ? 'the attribute store'
                          : 'the UV read'
                    }`}
                    className="border-b border-r border-border px-2 text-right font-medium text-fg"
                  >
                    {x.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {first > 0 && <tr style={{ height: first * ROW }} />}
              {rows.map((i) => (
                <tr key={i} data-sheet-row={i} style={{ height: ROW }}>
                  <td className="border-r border-border px-2 text-right text-fg-dim">{i}</td>
                  {cells.map((x) => (
                    <td key={x.label} className="border-r border-border px-2 text-right text-fg">
                      {show(x.c.type, x.at(i))}
                    </td>
                  ))}
                </tr>
              ))}
              {domain.count > last && <tr style={{ height: (domain.count - last) * ROW }} />}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
