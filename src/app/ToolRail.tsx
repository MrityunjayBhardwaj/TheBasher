// ToolRail — vertical icon column on the left edge of the editor (R4
// per UI-SPEC §5.4). Holds the four primary tool buttons (Select /
// Translate / Rotate / Scale) plus side-effect actions (Add / Light /
// Camera / Group).
//
// Tools vs actions: clicking a tool sets `editorStore.activeTool` (and
// translate/rotate/scale propagate to gizmoStore.mode for the existing
// TransformControls wiring). Actions don't change activeTool — they fire
// a one-shot side effect (Add opens the AddMenu, etc.). Light / Camera
// / Group surfaces don't exist yet in v0.5 so they render disabled with
// a TODO marker; W3+ will wire them as those features land.
//
// Collapse: chromeStore.toolRailCollapsed. When collapsed, the rail
// shrinks to a single `›` expand button. Layout owns the grid column
// width (32px expanded / 0 collapsed); ToolRail itself just renders the
// content.
//
// Director-mode hiding is owned by Layout (display:none on the grid
// slot), not by this component. ToolRail keeps the same DOM tree across
// all modes so its collapse state survives mode toggles.
//
// V8 file-rooted: src/app/. Mutates only UI projection stores
// (editorStore, chromeStore, addMenuStore). Never the DAG.
//
// REF: docs/UI-SPEC.md §5.4, §3.2, §6.2; THESIS.md §11, §17.

import type { ReactNode } from 'react';
import { useAddMenuStore } from './stores/addMenuStore';
import { useChromeStore } from './stores/chromeStore';
import { useEditorStore, type ActiveTool } from './stores/editorStore';

interface ToolDef {
  readonly id: ActiveTool;
  readonly icon: string;
  readonly label: string;
  readonly shortcut: string;
}

const TOOLS: readonly ToolDef[] = [
  { id: 'select', icon: '↖', label: 'Select', shortcut: 'Q' },
  { id: 'translate', icon: '✥', label: 'Translate', shortcut: 'W' },
  { id: 'rotate', icon: '⟲', label: 'Rotate', shortcut: 'E' },
  { id: 'scale', icon: '⤢', label: 'Scale', shortcut: 'R' },
];

interface ActionDef {
  readonly id: 'add' | 'light' | 'camera' | 'group';
  readonly icon: string;
  readonly label: string;
  readonly shortcut: string;
  readonly enabled: boolean;
}

const ACTIONS: readonly ActionDef[] = [
  { id: 'add', icon: '+', label: 'Add', shortcut: 'A', enabled: true },
  { id: 'light', icon: '✦', label: 'Light', shortcut: 'L', enabled: false },
  { id: 'camera', icon: '⌖', label: 'Camera', shortcut: 'C', enabled: false },
  { id: 'group', icon: '⛓', label: 'Group', shortcut: 'G', enabled: false },
];

function openAddMenuAtRailCenter(): void {
  // Open near the rail so the menu doesn't fly to a stale viewport
  // position. Falls back to viewport center if the rail isn't mounted.
  const rail = document.querySelector('[data-testid="tool-rail"]') as HTMLElement | null;
  if (rail) {
    const r = rail.getBoundingClientRect();
    useAddMenuStore.getState().openAt(r.right + 8, r.top + 32);
    return;
  }
  useAddMenuStore.getState().openAt(window.innerWidth / 2, window.innerHeight / 2);
}

function ToolButton({
  active,
  title,
  ariaLabel,
  testId,
  onClick,
  children,
  disabled,
}: {
  active: boolean;
  title: string;
  ariaLabel: string;
  testId: string;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
}): ReactNode {
  const base =
    'flex h-8 w-8 items-center justify-center rounded text-base font-mono transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent';
  let state: string;
  if (disabled) {
    state = 'text-fg-mute cursor-not-allowed';
  } else if (active) {
    state = 'bg-bg-1 text-accent';
  } else {
    state = 'text-fg-dim hover:bg-bg-1 hover:text-fg';
  }
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      data-testid={testId}
      title={title}
      aria-label={ariaLabel}
      className={`${base} ${state}`}
    >
      {children}
    </button>
  );
}

export function ToolRail(): ReactNode {
  const collapsed = useChromeStore((s) => s.toolRailCollapsed);
  const toggleCollapsed = useChromeStore((s) => s.toggleToolRail);
  const activeTool = useEditorStore((s) => s.activeTool);
  const setActiveTool = useEditorStore((s) => s.setActiveTool);

  if (collapsed) {
    return (
      <div
        data-testid="tool-rail"
        data-collapsed="true"
        role="toolbar"
        aria-orientation="vertical"
        aria-label={`Tool rail — ${activeTool ?? 'no tool'}`}
        className="flex h-full w-8 flex-col items-center border-r border-border bg-bg/95 py-1"
      >
        <button
          type="button"
          onClick={toggleCollapsed}
          data-testid="tool-rail-toggle"
          title="Expand tool rail"
          aria-label="Expand tool rail"
          className="flex h-6 w-6 items-center justify-center rounded text-fg-dim hover:bg-bg-1 hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          ›
        </button>
      </div>
    );
  }

  return (
    <div
      data-testid="tool-rail"
      data-collapsed="false"
      role="toolbar"
      aria-orientation="vertical"
      aria-label={`Tool rail — ${activeTool ?? 'no tool'}`}
      className="flex h-full w-8 flex-col items-center gap-1 border-r border-border bg-bg/95 py-1"
    >
      <button
        type="button"
        onClick={toggleCollapsed}
        data-testid="tool-rail-toggle"
        title="Collapse tool rail"
        aria-label="Collapse tool rail"
        className="flex h-6 w-6 items-center justify-center rounded text-fg-dim hover:bg-bg-1 hover:text-fg"
      >
        ‹
      </button>
      <div className="my-1 h-px w-5 bg-border" />
      {TOOLS.map((t) => (
        <ToolButton
          key={t.id}
          active={activeTool === t.id}
          title={`${t.label} (${t.shortcut})`}
          ariaLabel={`${t.label} tool`}
          testId={`tool-rail-${t.id}`}
          onClick={() => setActiveTool(t.id)}
        >
          {t.icon}
        </ToolButton>
      ))}
      <div className="my-1 h-px w-5 bg-border" />
      {ACTIONS.map((a) => (
        <ToolButton
          key={a.id}
          active={false}
          title={
            a.enabled
              ? `${a.label} (${a.shortcut})`
              : `${a.label} — coming in a later wave`
          }
          ariaLabel={a.id === 'add' ? 'Add node menu' : `${a.label} action`}
          testId={`tool-rail-${a.id}`}
          onClick={a.id === 'add' ? openAddMenuAtRailCenter : () => {}}
          disabled={!a.enabled}
        >
          {a.icon}
        </ToolButton>
      ))}
    </div>
  );
}
