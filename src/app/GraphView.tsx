// GraphView — the Graph editor space: the live scene drawn as nodes and wires, read-only (#1675,
// the first slice of the §16 node view #1563). Opened from its Graph button (space switcher and
// toolbar) or View ▸ Editor Space; the app still starts in the 3D View and Tab never lands here.
//
// It owns no graph logic: `sceneGraphOf` says what to draw and `layoutGraph` where. Selection is
// the app's own (`useSelectionStore`), so clicking a node here selects it in the outliner,
// inspector and viewport, and selecting there lights its lineage up here.
//
// File-rooted V8: src/app/. Read-only surface — never touches the DAG.

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDagStore } from '../core/dag/store';
import type { NodeId } from '../core/dag/types';
import { type GraphNode, layoutGraph, sceneGraphOf } from './sceneGraph';
import { useSelectionStore } from './stores/selectionStore';

const W = 230;
const HEAD = 40;
const ROW = 18;
const PAD = 8;
const LAYOUT = { width: W, colGap: 90, rowGap: 16 };

// One colour per kind of node, so the eye can follow geometry into objects into the scene.
const KIND: Record<string, { color: string; label: string }> = {
  geo: { color: '#4fb38a', label: 'Geometry' },
  mod: { color: '#3e9fc4', label: 'Modifier' },
  rig: { color: '#c9707f', label: 'Rig' },
  obj: { color: '#d6a04a', label: 'Object' },
  grp: { color: '#7d859b', label: 'Group' },
  anim: { color: '#e3cf5b', label: 'Animation' },
  con: { color: '#a585e0', label: 'Constraint' },
  data: { color: '#7fb6e8', label: 'Camera / light' },
  out: { color: '#ededf2', label: 'Scene / render' },
};
function kindOf(type: string): keyof typeof KIND {
  if (type === 'Object') return 'obj';
  if (type === 'Group' || type === 'Collection') return 'grp';
  if (type === 'Scene' || type === 'RenderOutput' || type === 'TimeSource') return 'out';
  if (type === 'CameraData' || type === 'LightData') return 'data';
  if (
    type.startsWith('KeyframeChannel') ||
    type === 'Track' ||
    type === 'Strip' ||
    type === 'ParamDriver'
  )
    return 'anim';
  if (type === 'Skeleton' || type === 'PoseLayer') return 'rig';
  if (type.endsWith('Modifier') || type.endsWith('Op')) return 'mod';
  if (/To$|^Follow|Constraint|Copy|Limit/.test(type)) return 'con';
  return 'geo';
}

const nodeHeight = (n: GraphNode) =>
  HEAD + Math.max(n.inputs.length, n.outputs.length - 1, 0) * ROW + PAD;
const inY = (n: GraphNode, socket: string, ref: boolean) =>
  HEAD + n.inputs.findIndex((r) => r.socket === socket && r.ref === ref) * ROW + ROW / 2 - 2;
const outY = (n: GraphNode, socket: string) => 20 + n.outputs.indexOf(socket) * ROW;
// Long names keep both ends: imported tiles often differ only in their last characters.
const clip = (s: string, n: number) =>
  s.length > n ? s.slice(0, Math.ceil(n / 2) - 1) + '…' + s.slice(s.length - Math.floor(n / 2)) : s;

export function GraphView(): ReactNode {
  const state = useDagStore((s) => s.state);
  const primary = useSelectionStore((s) => s.primaryNodeId);
  const select = useSelectionStore((s) => s.select);
  const [showHidden, setShowHidden] = useState(false);

  const graph = useMemo(() => sceneGraphOf(state, { showHidden }), [state, showHidden]);
  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);
  const layout = useMemo(
    () =>
      layoutGraph(
        graph.nodes.map((n) => ({ id: n.id, height: nodeHeight(n) })),
        graph.wires,
        LAYOUT,
      ),
    [graph],
  );

  // Lineage of the selected node: everything that feeds it and everything it changes.
  const lit = useMemo(() => {
    if (!primary || !byId.has(primary)) return null;
    const up = new Set<NodeId>([primary]);
    const down = new Set<NodeId>([primary]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const w of graph.wires) {
        if (up.has(w.to) && !up.has(w.from)) {
          up.add(w.from);
          grew = true;
        }
        if (down.has(w.from) && !down.has(w.to)) {
          down.add(w.to);
          grew = true;
        }
      }
    }
    return { up, down };
  }, [primary, byId, graph]);

  const svgRef = useRef<SVGSVGElement>(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const fit = useCallback(() => {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r || r.width === 0 || layout.width === 0) return;
    const m = 24;
    const k = Math.min((r.width - 2 * m) / layout.width, (r.height - 2 * m) / layout.height, 1.2);
    setView({
      k,
      x: (r.width - layout.width * k) / 2,
      y: Math.max(m, (r.height - layout.height * k) / 2),
    });
  }, [layout]);
  // Fit when the space opens (it mounts then) and whenever the graph's shape changes.
  const shapeKey = `${graph.nodes.length}:${graph.wires.length}`;
  useEffect(() => {
    fit();
  }, [shapeKey, fit]);

  // Wheel zoom at the cursor. Attached by hand: React's onWheel is passive and cannot preventDefault.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = svg.getBoundingClientRect();
      const cx = e.clientX - r.left;
      const cy = e.clientY - r.top;
      setView((v) => {
        const k = Math.min(3, Math.max(0.05, v.k * Math.exp(-e.deltaY * 0.0015)));
        return { k, x: cx - (cx - v.x) * (k / v.k), y: cy - (cy - v.y) * (k / v.k) };
      });
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, []);

  const drag = useRef<{
    x: number;
    y: number;
    vx: number;
    vy: number;
    node: NodeId | null;
    moved: boolean;
  } | null>(null);
  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    const node =
      (e.target as Element).closest('[data-graph-node]')?.getAttribute('data-graph-node') ?? null;
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, node, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
    if (d.moved) setView((v) => ({ ...v, x: d.vx + dx, y: d.vy + dy }));
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d && !d.moved) select(d.node);
  };

  const refCount = graph.wires.filter((w) => w.ref).length;
  return (
    <div data-testid="graph-view" className="flex h-full w-full flex-col bg-bg">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border bg-muted/30 px-3 py-1.5 text-[11px] text-fg-dim">
        <span className="font-medium text-fg">Graph</span>
        <span data-testid="graph-view-counts" className="tabular-nums">
          {graph.nodes.length} nodes · {graph.wires.length - refCount} wires · {refCount} references
          {graph.omitted > 0 ? ` · ${graph.omitted} hidden` : ''}
        </span>
        <span className="flex-1" />
        <label className="flex cursor-pointer items-center gap-1.5">
          <input
            id="graph-view-show-hidden"
            data-testid="graph-view-show-hidden"
            type="checkbox"
            checked={showHidden}
            onChange={(e) => setShowHidden(e.target.checked)}
          />
          Show hidden
        </label>
        <button
          type="button"
          data-testid="graph-view-fit"
          onClick={fit}
          className="rounded border border-border px-2 py-0.5 text-fg hover:border-border-strong"
        >
          Fit
        </button>
      </div>
      <div className="relative flex-1" style={{ minHeight: 0 }}>
        <svg
          ref={svgRef}
          data-testid="graph-view-canvas"
          className="h-full w-full cursor-grab touch-none select-none"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          role="img"
          aria-label={`Scene graph: ${graph.nodes.length} nodes`}
        >
          <defs>
            <pattern id="graph-view-dots" width="24" height="24" patternUnits="userSpaceOnUse">
              <circle cx="1" cy="1" r="1" fill="#2a2a33" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#graph-view-dots)" />
          <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
            {graph.wires.map((w, i) => {
              const a = byId.get(w.from)!;
              const b = byId.get(w.to)!;
              const pa = layout.pos.get(w.from)!;
              const pb = layout.pos.get(w.to)!;
              const x1 = pa.x + W;
              const y1 = pa.y + outY(a, w.fromSocket);
              const x2 = pb.x;
              const y2 = pb.y + inY(b, w.toSocket, w.ref);
              const dx = Math.max(40, Math.abs(x2 - x1) * 0.45);
              // A reference takes the colour of the node that holds it: the channel or
              // constraint acting, or the constraint reading its aim.
              const holder = w.fromSocket === 'out' ? b : a;
              const on =
                lit &&
                ((lit.up.has(w.from) && lit.up.has(w.to)) ||
                  (lit.down.has(w.from) && lit.down.has(w.to)));
              return (
                <path
                  key={i}
                  d={`M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`}
                  fill="none"
                  stroke={w.ref ? KIND[kindOf(holder.type)].color : '#5b6478'}
                  strokeWidth={on ? 2.4 : w.ref ? 1.8 : 1.4}
                  strokeDasharray={w.ref ? '5 4' : undefined}
                  opacity={lit && !on ? 0.1 : 1}
                />
              );
            })}
            {graph.nodes.map((n) => {
              const p = layout.pos.get(n.id)!;
              const h = nodeHeight(n);
              const color = KIND[kindOf(n.type)].color;
              const selected = n.id === primary;
              const dim = lit ? !(lit.up.has(n.id) || lit.down.has(n.id)) : false;
              return (
                <g
                  key={n.id}
                  data-graph-node={n.id}
                  data-selected={selected || undefined}
                  transform={`translate(${p.x},${p.y})`}
                  opacity={dim ? 0.18 : n.hidden ? 0.55 : 1}
                  className="cursor-pointer"
                >
                  <title>{`${n.name}\n${n.type} · ${n.id}${n.hidden ? '\nhidden' : ''}`}</title>
                  <rect
                    width={W}
                    height={h}
                    rx={5}
                    fill="#1c1c22"
                    stroke={selected ? '#f0c75e' : '#2a2a33'}
                    strokeWidth={selected ? 2 : 1}
                  />
                  <rect width={W} height={4} rx={2} fill={color} />
                  <text x={10} y={19} fontSize={12.5} fontWeight={600} fill="#ededf2">
                    {clip(n.name, 30)}
                  </text>
                  <text x={10} y={33} fontSize={10.5} fill="#9b9ca6">
                    {clip(n.type, 34)}
                  </text>
                  {n.inputs.map((r) => {
                    const y = inY(n, r.socket, r.ref);
                    return (
                      <g key={`${r.ref ? 'r' : 'w'}:${r.socket}`}>
                        <circle
                          cx={0}
                          cy={y}
                          r={4}
                          fill={r.ref ? '#e3cf5b' : '#5b6478'}
                          stroke="#111114"
                          strokeWidth={1.5}
                        />
                        <text
                          x={10}
                          y={y + 3.5}
                          fontSize={10.5}
                          fill="#9b9ca6"
                          fontFamily="ui-monospace, Menlo, monospace"
                        >
                          {r.count > 1 ? `${r.socket} ×${r.count}` : r.socket}
                        </text>
                      </g>
                    );
                  })}
                  {n.outputs.map((s) => {
                    const y = outY(n, s);
                    return (
                      <g key={`o:${s}`}>
                        <circle
                          cx={W}
                          cy={y}
                          r={4}
                          fill={color}
                          stroke="#111114"
                          strokeWidth={1.5}
                        />
                        {s !== 'out' && (
                          <text
                            x={W - 10}
                            y={y + 3.5}
                            fontSize={10.5}
                            textAnchor="end"
                            fill="#9b9ca6"
                            fontFamily="ui-monospace, Menlo, monospace"
                          >
                            {s}
                          </text>
                        )}
                      </g>
                    );
                  })}
                </g>
              );
            })}
          </g>
        </svg>
        <div className="pointer-events-none absolute bottom-2 left-3 flex flex-wrap gap-x-3 gap-y-1 rounded border border-border bg-bg-2/90 px-2 py-1 text-[10px] text-fg-dim">
          {Object.values(KIND).map((k) => (
            <span key={k.label} className="flex items-center gap-1">
              <i className="inline-block h-2 w-2 rounded-sm" style={{ background: k.color }} />
              {k.label}
            </span>
          ))}
          <span className="flex items-center gap-1">
            <i
              className="inline-block w-3 border-t-2 border-dashed"
              style={{ borderColor: '#e3cf5b' }}
            />
            Reference by id
          </span>
        </div>
      </div>
    </div>
  );
}
