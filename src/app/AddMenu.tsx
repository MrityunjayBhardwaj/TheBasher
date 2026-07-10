// AddMenu — Blender-style nested context menu for inserting primitives.
//
// Two trigger paths:
//   - Right-click on the 3D viewport (handled in Layout via onContextMenu).
//   - Shift+A keyboard (handled in KeyboardShortcuts.tsx) → opens at
//     viewport center as a sensible fallback.
//
// Spawning chain (V1 + V8 clean):
//   - reads `useThreeRef` for the OrbitControls target so the new
//     primitive lands where the user is looking.
//   - dispatches one atomic Op chain via `useDagStore.dispatchAtomic`.
//   - selects the new node so the gizmo + Inspector immediately bind.
//
// Rendered at App level via fixed positioning so it overlays the entire
// page without being clipped by Layout's grid cells.

import { useEffect, useRef, useState } from 'react';
import { useDagStore } from '../core/dag/store';
import { buildAddPrimitiveOps, type PrimitiveKind } from './addPrimitives';
import { useThreeRef } from './character/threeRef';
import { useAddMenuStore } from './stores/addMenuStore';
import { useSelectionStore } from './stores/selectionStore';
import { useFlyoutSide } from './menu/useFlyoutSide';

interface MenuGroup {
  label: string;
  items: { kind: PrimitiveKind; label: string }[];
}

const GROUPS: MenuGroup[] = [
  {
    label: 'Mesh',
    items: [
      { kind: 'Cube', label: 'Cube' },
      { kind: 'Sphere', label: 'UV Sphere' },
    ],
  },
  {
    label: 'Light',
    items: [
      { kind: 'DirectionalLight', label: 'Sun (Directional)' },
      { kind: 'PointLight', label: 'Point' },
      { kind: 'SpotLight', label: 'Spot' },
      { kind: 'AreaLight', label: 'Area' },
      { kind: 'AmbientLight', label: 'Ambient' },
    ],
  },
  {
    label: 'Camera',
    items: [
      { kind: 'PerspectiveCamera', label: 'Perspective' },
      { kind: 'OrthographicCamera', label: 'Orthographic' },
    ],
  },
  {
    label: 'Empty',
    items: [
      { kind: 'Group', label: 'Group' },
      { kind: 'Transform', label: 'Transform' },
      // #296 — a Null controller: a transformable scene object you grab with the
      // gizmo; a driver reads its transform channels to drive other params.
      { kind: 'Null', label: 'Null (Controller)' },
    ],
  },
  {
    // #294 (Inc 3) — the compute-node vocabulary (Inc 1) as clickable sources. These
    // feed ParamDrivers via the pull rail; without a menu entry the driver bind picker
    // is empty on a fresh scene.
    label: 'Compute',
    items: [
      { kind: 'Math', label: 'Math' },
      { kind: 'Fit', label: 'Fit' },
      { kind: 'Clamp', label: 'Clamp' },
      { kind: 'Mix', label: 'Mix' },
      { kind: 'CurveRemap', label: 'Curve Remap' },
      { kind: 'Noise', label: 'Noise' },
      // Vector (Vector3 rail) — build/break a vector, vector arithmetic.
      { kind: 'MakeVec3', label: 'Make Vec3' },
      { kind: 'VecBreak3', label: 'Break Vec3' },
      { kind: 'Vec3Math', label: 'Vec3 Math' },
      // Stateful — output trails its input over time (Epic 2, #297).
      { kind: 'Lag', label: 'Lag' },
    ],
  },
  {
    // Epic 2 — the Solver meta-op: a sub-network cooked every frame with a Prev_Frame
    // feedback + seed (Houdini Solver SOP). Wire the sub-network's output into the
    // Solver's `body`; PrevFrame/SolverInput are the loop's feedback + live-input leaves.
    label: 'Solver',
    items: [
      { kind: 'Solver', label: 'Solver' },
      { kind: 'PrevFrame', label: 'Prev Frame' },
      { kind: 'SolverInput', label: 'Solver Input' },
    ],
  },
];

function spawnPosition(): [number, number, number] {
  const target = useThreeRef.getState().controlsTarget;
  if (!target) return [0, 0, 0];
  return [target.x, target.y, target.z];
}

export function addPrimitive(kind: PrimitiveKind): void {
  const dag = useDagStore.getState();
  const result = buildAddPrimitiveOps(dag.state, kind, spawnPosition());
  if (!result) return;
  dag.dispatchAtomic(result.ops, 'user', result.description);
  // Auto-select the new node so the gizmo binds immediately — Blender
  // does the same: Shift+A → object appears + selected + gizmo active.
  useSelectionStore.getState().select(result.newNodeId);
}

const SUBMENU_WIDTH = 200;

/** One Add-menu group row + its edge-aware flyout submenu. Extracted so the
 *  flyout-placement hook runs per group (UX #5 — the submenu flips to the left
 *  when opening right would cross the viewport edge; shared via useFlyoutSide
 *  with MenuBar, H91 family). */
function AddMenuGroup({
  group,
  active,
  onActivate,
  onDeactivate,
  close,
}: {
  group: MenuGroup;
  active: boolean;
  onActivate: () => void;
  onDeactivate: () => void;
  close: () => void;
}) {
  const { containerRef, style: flyoutStyle } = useFlyoutSide<HTMLLIElement>(active, SUBMENU_WIDTH);
  return (
    <li
      ref={containerRef}
      role="none"
      className="relative"
      onMouseEnter={onActivate}
      onMouseLeave={onDeactivate}
    >
      <button
        type="button"
        role="menuitem"
        data-testid={`add-menu-${group.label.toLowerCase()}`}
        aria-haspopup="menu"
        aria-expanded={active}
        className={`flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-[11px] ${
          active ? 'bg-muted text-accent' : 'text-fg/80 hover:bg-muted'
        }`}
      >
        <span>{group.label}</span>
        <span aria-hidden className="font-mono text-[10px] text-fg/40">
          ▸
        </span>
      </button>
      {active ? (
        <div
          role="menu"
          aria-label={group.label}
          data-testid={`add-menu-${group.label.toLowerCase()}-panel`}
          style={{ width: SUBMENU_WIDTH, ...flyoutStyle }}
          className="absolute top-0 z-[101] -mt-1 overflow-hidden rounded border border-border bg-bg shadow-lg"
        >
          {group.items.map((item) => (
            <button
              key={item.kind}
              type="button"
              role="menuitem"
              data-testid={`add-menu-item-${item.kind}`}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] text-fg/80 hover:bg-muted"
              onClick={() => {
                addPrimitive(item.kind);
                close();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </li>
  );
}

export function AddMenu() {
  const open = useAddMenuStore((s) => s.open);
  const x = useAddMenuStore((s) => s.x);
  const y = useAddMenuStore((s) => s.y);
  const close = useAddMenuStore((s) => s.close);
  const ref = useRef<HTMLDivElement | null>(null);
  const [activeGroup, setActiveGroup] = useState<string | null>(null);

  // Click-outside / Escape dismiss.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);

  // Reset hover-active group every time the menu opens.
  useEffect(() => {
    if (open) setActiveGroup(null);
  }, [open]);

  if (!open) return null;

  // Clamp the root position so the menu stays fully on-screen on BOTH axes.
  // Math.max(8, …) guards the LOWER bound (a right-click near the top/left edge
  // must not push the menu off the top/left) as well as the upper bound (near
  // the bottom/right). MENU_H is a conservative height estimate covering the
  // header + all groups so the menu's bottom never falls below the viewport.
  const W = 220;
  const MENU_H = 320;
  const cx = Math.max(8, Math.min(x, window.innerWidth - W - 8));
  const cy = Math.max(8, Math.min(y, window.innerHeight - MENU_H));
  return (
    <div
      ref={ref}
      data-testid="add-menu"
      className="fixed z-[100] overflow-visible rounded border border-border bg-bg/95 font-mono text-xs text-fg shadow-lg backdrop-blur"
      style={{ left: cx, top: cy, width: W }}
    >
      <header className="border-b border-border px-3 py-1.5 text-[10px] uppercase tracking-wide text-fg/50">
        Add
      </header>
      <ul role="menu" aria-label="Add primitive" className="flex flex-col">
        {GROUPS.map((g) => (
          <AddMenuGroup
            key={g.label}
            group={g}
            active={activeGroup === g.label}
            onActivate={() => setActiveGroup(g.label)}
            onDeactivate={() => setActiveGroup((cur) => (cur === g.label ? null : cur))}
            close={close}
          />
        ))}
      </ul>
    </div>
  );
}
