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

  // Clamp position so the menu doesn't escape the viewport edges.
  const W = 220;
  const cx = Math.min(x, window.innerWidth - W - 8);
  const cy = Math.min(y, window.innerHeight - 320);
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
          <li
            key={g.label}
            role="none"
            className="relative"
            onMouseEnter={() => setActiveGroup(g.label)}
            onMouseLeave={() => setActiveGroup((cur) => (cur === g.label ? null : cur))}
          >
            <button
              type="button"
              role="menuitem"
              data-testid={`add-menu-${g.label.toLowerCase()}`}
              aria-haspopup="menu"
              aria-expanded={activeGroup === g.label}
              className={`flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-[11px] ${
                activeGroup === g.label ? 'bg-muted text-accent' : 'text-fg/80 hover:bg-muted'
              }`}
            >
              <span>{g.label}</span>
              <span aria-hidden className="font-mono text-[10px] text-fg/40">▸</span>
            </button>
            {activeGroup === g.label ? (
              <div
                role="menu"
                aria-label={g.label}
                data-testid={`add-menu-${g.label.toLowerCase()}-panel`}
                className="absolute left-full top-0 z-[101] -mt-1 w-[200px] overflow-hidden rounded border border-border bg-bg shadow-lg"
              >
                {g.items.map((item) => (
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
        ))}
      </ul>
    </div>
  );
}
