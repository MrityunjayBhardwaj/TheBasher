// MenuBar — Blender-style File / Edit / Select / View menus.
//
// Sits ABOVE Chrome in Layout. Uses `<details><summary>` for popovers — no
// library, accessible by default, dismiss-on-blur via document listener.
// Hotkeys are owned by KeyboardShortcuts.tsx; menu items mirror them.
//
// V1 stays clean: every action funnels through existing helpers
// (boot.ts for project ops, useDagStore.dispatch for ops, hydrate for the
// reset-to-default seam).
//
// REF: THESIS.md §11, §15, §17.

import { useEffect, useRef, useState } from 'react';
import { buildDefaultDagState } from '../core/project';
import { useDagStore } from '../core/dag/store';
import { useProjectStore } from '../core/project/store';
import {
  createNewProject,
  deleteProject,
  duplicateCurrentProject,
  listAllProjectMetadata,
  renameCurrentProject,
  saveCurrent,
  switchProject,
} from './boot';
import type { ProjectMetadata } from '../core/project/io';
import {
  dispatchApplyTransform,
  isTransformAnimated,
  type ApplyMask,
} from './animate/dispatchApplyTransform';
import { useTimeStore } from './stores/timeStore';
import { snapshotCameraFromOrbit } from './character/cameraFromView';
import { frameAll, frameSelected } from './character/framing';
import { exportDagJson } from './exportDag';
import { renderImageWithFeedback } from './renderImageAction';
import { useEditorStore, type SpaceType } from './stores/editorStore';
import { useSelectionStore } from './stores/selectionStore';
import { useViewportStore, type ShadingMode } from './stores/viewportStore';
import { useChromeStore } from './stores/chromeStore';
import { openImportPicker, openGltfFilePicker } from './asset/importPicker';
import { downloadSceneBundle, openSceneFilePicker } from './sceneFileActions';
import { useFlyoutSide } from './menu/useFlyoutSide';

// ---------------------------------------------------------------------------
// Popover primitives — minimal, no library.
// ---------------------------------------------------------------------------

interface MenuProps {
  label: string;
  testId: string;
  children: React.ReactNode;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  /** Hover-switch: pointer entered this top-level button — switch to this menu
   *  IFF some menu is already open (standard menubar behaviour; the parent
   *  no-ops when nothing is open so the first menu still requires a click). */
  onHover: () => void;
}

function Menu({ label, testId, children, open, onOpen, onClose, onHover }: MenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  return (
    <div ref={ref} className="relative" data-testid={testId}>
      <button
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${label} menu`}
        onClick={() => (open ? onClose() : onOpen())}
        onMouseEnter={onHover}
        data-testid={`${testId}-button`}
        className={`rounded px-2 py-1 text-[11px] uppercase tracking-wide focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
          open ? 'bg-muted text-accent' : 'text-fg/70 hover:bg-muted/60 hover:text-fg'
        }`}
      >
        {label}
      </button>
      {open ? (
        <div
          role="menu"
          aria-label={`${label} menu`}
          data-testid={`${testId}-panel`}
          className="absolute left-0 top-full z-40 mt-0.5 w-[260px] overflow-hidden rounded border border-border bg-bg shadow-lg"
          onClick={onClose}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

interface ItemProps {
  label: string;
  shortcut?: string;
  onSelect: () => void | Promise<void>;
  disabled?: boolean;
  testId?: string;
}

function Item({ label, shortcut, onSelect, disabled, testId }: ItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={() => void onSelect()}
      data-testid={testId}
      className="flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-[11px] text-fg/80 hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-40 disabled:hover:bg-transparent"
    >
      <span>{label}</span>
      {shortcut ? (
        <span aria-hidden className="font-mono text-[10px] text-fg/40">
          {shortcut}
        </span>
      ) : null}
    </button>
  );
}

const SUBMENU_WIDTH = 220;

function Submenu({
  label,
  children,
  testId,
}: {
  label: string;
  children: React.ReactNode;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  // Edge-aware placement: opens to the right by default, flips left when the
  // right viewport edge would be crossed (UX #5 — a right-side menu's submenu
  // ran off-screen; shared with AddMenu via useFlyoutSide, H91 family).
  const { containerRef, style: flyoutStyle } = useFlyoutSide<HTMLDivElement>(open, SUBMENU_WIDTH);
  return (
    <div
      ref={containerRef}
      className="relative"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid={testId}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-[11px] text-fg/80 hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        <span>{label}</span>
        <span aria-hidden className="font-mono text-[10px] text-fg/40">
          ▸
        </span>
      </button>
      {open ? (
        <div
          role="menu"
          aria-label={label}
          style={{ width: SUBMENU_WIDTH, ...flyoutStyle }}
          className="absolute top-0 z-50 -mt-1 overflow-hidden rounded border border-border bg-bg shadow-lg"
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

function Divider() {
  return <div className="h-px bg-border" />;
}

const cmdKeyLabel =
  typeof navigator !== 'undefined' && /Mac/.test(navigator.platform) ? '⌘' : 'Ctrl';

// ---------------------------------------------------------------------------
// Menu actions
// ---------------------------------------------------------------------------

function getTopLevelChildIds(): string[] {
  const dag = useDagStore.getState().state;
  const sceneRef = dag.outputs.scene;
  if (!sceneRef) return [];
  const sceneNode = dag.nodes[sceneRef.node];
  if (!sceneNode || !Array.isArray(sceneNode.inputs.children)) return [];
  return (sceneNode.inputs.children as { node: string }[]).map((c) => c.node);
}

async function onNewProject() {
  const name = window.prompt('New project name', 'Untitled');
  if (!name) return;
  await createNewProject(name.trim() || 'Untitled');
}

async function onDuplicate() {
  const current = useProjectStore.getState().current;
  if (!current) return;
  await duplicateCurrentProject(`${current.name} (copy)`);
}

async function onRename() {
  const current = useProjectStore.getState().current;
  if (!current) return;
  const next = window.prompt('Rename project', current.name);
  if (!next || next.trim() === current.name) return;
  await renameCurrentProject(next.trim());
}

async function onDelete() {
  const current = useProjectStore.getState().current;
  if (!current) return;
  const ok = window.confirm(`Delete project "${current.name}"? This can't be undone.`);
  if (!ok) return;
  await deleteProject(current.id);
}

// onExportDagJson moved to ./exportDag.ts (P6 W2 — TopToolbar shares the path)

function onExportGltf() {
  // Stub — full glTF export pipeline lands with the render graph (P4).
  // Acknowledged here so users discover the menu item; "coming soon"
  // beats a hidden capability.
  window.alert('glTF scene export lands with the render graph (P4).');
}

// File → Import… funnels through the shared `openImportPicker` (asset/
// importPicker.ts) — the SAME pipeline the Spline outliner footer's Import
// button uses, so the two affordances can never diverge (V34, one create path).

function onResetToDefault() {
  const ok = window.confirm(
    'Reset current project to the default scene? This clears the undo history.',
  );
  if (!ok) return;
  // hydrate is the documented V1 exception (project-load seam, mirrors
  // boot/switchProject). The undo stack resets along with the state — that's
  // the intended UX of "reset" (you don't want to undo a reset back into a
  // half-mutated old DAG).
  useDagStore.getState().hydrate(buildDefaultDagState());
}

function onSettings() {
  window.alert('Settings UI lands later. For now, behaviors live in the N panel and View menu.');
}

// ---------------------------------------------------------------------------
// MenuBar
// ---------------------------------------------------------------------------

type OpenMenu = null | 'file' | 'edit' | 'object' | 'select' | 'view';

// Left-to-right order of the top-level menus — drives ArrowLeft/ArrowRight
// keyboard navigation between them (standard menubar behaviour).
const MENU_ORDER = ['file', 'edit', 'object', 'select', 'view'] as const;

const APPLY_MASKS: { mask: ApplyMask; label: string }[] = [
  { mask: 'all', label: 'All Transforms' },
  { mask: 'location', label: 'Location' },
  { mask: 'rotation', label: 'Rotation' },
  { mask: 'scale', label: 'Scale' },
];

export function MenuBar() {
  const [open, setOpen] = useState<OpenMenu>(null);
  const close = () => setOpen(null);

  // Keyboard navigation across the open menu (standard ARIA menubar). Only
  // active once a menu is open (opened by click) — the menubar itself is not a
  // roving-tabindex widget. ArrowLeft/Right switch top-level menus; ArrowUp/
  // Down/Home/End move focus among the open panel's items. DOM-query based (no
  // child refs) — submenus are hover-only, so during keyboard use the open
  // panel exposes exactly its first-level items.
  function focusButton(id: (typeof MENU_ORDER)[number]): void {
    document.querySelector<HTMLElement>(`[data-testid="menu-${id}-button"]`)?.focus();
  }
  function onMenubarKeyDown(e: React.KeyboardEvent): void {
    if (open === null) return;
    const idx = MENU_ORDER.indexOf(open as (typeof MENU_ORDER)[number]);
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const delta = e.key === 'ArrowRight' ? 1 : -1;
      const next = MENU_ORDER[(idx + delta + MENU_ORDER.length) % MENU_ORDER.length];
      setOpen(next);
      focusButton(next);
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      const panel = document.querySelector(`[data-testid="menu-${open}-panel"]`);
      // Skip disabled items — they can't take focus, and landing on one would
      // strand the roving cursor (e.g. Edit ▸ Undo is disabled on a fresh scene).
      const items = panel
        ? Array.from(panel.querySelectorAll<HTMLElement>('button[role="menuitem"]:not([disabled])'))
        : [];
      if (items.length === 0) return;
      e.preventDefault();
      const cur = items.indexOf(document.activeElement as HTMLElement);
      let target = 0;
      if (e.key === 'ArrowDown') target = cur < 0 ? 0 : (cur + 1) % items.length;
      else if (e.key === 'ArrowUp')
        target = cur < 0 ? items.length - 1 : (cur - 1 + items.length) % items.length;
      else if (e.key === 'End') target = items.length - 1;
      items[target]?.focus();
    }
  }
  // Hover-switch: once any menu is open, pointing at a different top-level
  // button switches to it. No-op when nothing is open (the functional update
  // returns `cur` unchanged) so the first menu still requires a click.
  const hoverSwitch = (id: Exclude<OpenMenu, null>) => () =>
    setOpen((cur) => (cur !== null ? id : cur));

  // Reactive bits used inside menus.
  const dag = useDagStore((s) => s.state);
  const undoLen = useDagStore((s) => s.undoStack.length);
  const redoLen = useDagStore((s) => s.redoStack.length);
  const gridVisible = useViewportStore((s) => s.gridVisible);
  const axisWidgetVisible = useViewportStore((s) => s.axisWidgetVisible);
  const shading = useViewportStore((s) => s.shading);
  const setShading = useViewportStore((s) => s.setShading);
  const lookThrough = useViewportStore((s) => s.lookThroughCamera);
  const space = useEditorStore((s) => s.space);
  const setSpace = useEditorStore((s) => s.setSpace);
  const showFpsMeter = useChromeStore((s) => s.showFpsMeter);
  const currentProjectId = useProjectStore((s) => s.current?.id);
  const currentProjectUpdatedAt = useProjectStore((s) => s.current?.updatedAt);

  // Projects list for File ▸ Switch Project (UX backlog #4 — the "projects ▾"
  // dropdown left the top-right corner; its list now lives under File). Fetched
  // when the File menu opens and when the current project changes (new /
  // duplicate / rename / delete bumps id or updatedAt). Same read seam
  // ProjectsMenu used (listAllProjectMetadata).
  const [projects, setProjects] = useState<ProjectMetadata[]>([]);
  useEffect(() => {
    if (open !== 'file') return;
    let cancelled = false;
    void listAllProjectMetadata().then((p) => {
      if (!cancelled) setProjects(p);
    });
    return () => {
      cancelled = true;
    };
  }, [open, currentProjectId, currentProjectUpdatedAt]);

  // Distinct node types for the Select → By Type submenu.
  const distinctTypes = Array.from(new Set(Object.values(dag.nodes).map((n) => n.type))).sort();

  // Phase 151 — the Object ▸ Apply affordance. A single selected primitive
  // (BoxMesh/SphereMesh) is the only Apply target in Wave 2 (glTF-child = Wave 4).
  const selectedId = useSelectionStore((s) =>
    s.selectedNodeIds.size === 1 ? s.selectedNodeId : null,
  );
  const currentFrame = useTimeStore((s) => s.frame);
  const selectedNode = selectedId ? dag.nodes[selectedId] : undefined;
  const isPrimitive = selectedNode?.type === 'BoxMesh' || selectedNode?.type === 'SphereMesh';
  const applyAnimated = Boolean(
    selectedId && isPrimitive && isTransformAnimated(dag, selectedId, currentFrame),
  );
  const applyDisabled = !selectedId || !isPrimitive || applyAnimated;

  return (
    <div
      data-testid="menubar"
      role="menubar"
      aria-label="Menu bar"
      onKeyDown={onMenubarKeyDown}
      className="flex items-center gap-0.5 border-b border-border bg-bg px-2 py-1 font-mono text-fg"
    >
      <Menu
        label="File"
        testId="menu-file"
        open={open === 'file'}
        onOpen={() => setOpen('file')}
        onClose={close}
        onHover={hoverSwitch('file')}
      >
        <Item label="New Project…" onSelect={onNewProject} testId="menu-file-new" />
        <Submenu label="Switch Project" testId="menu-file-switch">
          {projects.length === 0 ? (
            <Item label="No projects" onSelect={() => {}} testId="menu-file-switch-empty" />
          ) : (
            projects.map((p) => (
              <Item
                key={p.id}
                label={`${p.id === currentProjectId ? '✓ ' : '   '}${p.name}`}
                onSelect={() => {
                  if (p.id !== currentProjectId) void switchProject(p.id);
                }}
                testId={`menu-file-switch-${p.id}`}
              />
            ))
          )}
        </Submenu>
        <Item label="Duplicate Current" onSelect={onDuplicate} testId="menu-file-duplicate" />
        <Item label="Rename Current…" onSelect={onRename} testId="menu-file-rename" />
        <Item label="Delete Current…" onSelect={onDelete} testId="menu-file-delete" />
        <Divider />
        <Item
          label="Save"
          shortcut={`${cmdKeyLabel}+S`}
          onSelect={() => saveCurrent()}
          testId="menu-file-save"
        />
        <Divider />
        <Item
          label="Render Image…"
          onSelect={() => void renderImageWithFeedback()}
          testId="menu-file-render-image"
        />
        <Item
          label="Export Scene as glTF…"
          onSelect={onExportGltf}
          testId="menu-file-export-gltf"
        />
        <Item label="Export DAG as JSON" onSelect={exportDagJson} testId="menu-file-export-json" />
        <Item
          label="Save Scene as .basher…"
          onSelect={() => void downloadSceneBundle()}
          testId="menu-file-save-bundle"
        />
        <Divider />
        <Item label="Open Scene…" onSelect={openSceneFilePicker} testId="menu-file-open-scene" />
        <Item label="Import glTF…" onSelect={openGltfFilePicker} testId="menu-file-import-gltf" />
        <Item label="Import Folder…" onSelect={openImportPicker} testId="menu-file-import" />
      </Menu>

      {/* No top-level "Add" menu: the floating viewport toolbar's prominent
          "+ Add" button (and Shift+A) is the SINGLE Add entry — both open the
          same addMenuStore AddMenu. A second menu-bar path was the redundant
          surface; one create affordance matches the Spline "one toolbar" target
          (UI-SPEC §5.7). Add is no longer "in two places". */}

      <Menu
        label="Edit"
        testId="menu-edit"
        open={open === 'edit'}
        onOpen={() => setOpen('edit')}
        onClose={close}
        onHover={hoverSwitch('edit')}
      >
        <Item
          label="Undo"
          shortcut={`${cmdKeyLabel}+Z`}
          disabled={undoLen === 0}
          onSelect={() => {
            useDagStore.getState().undo();
          }}
          testId="menu-edit-undo"
        />
        <Item
          label="Redo"
          shortcut={`${cmdKeyLabel}+Shift+Z`}
          disabled={redoLen === 0}
          onSelect={() => {
            useDagStore.getState().redo();
          }}
          testId="menu-edit-redo"
        />
        <Divider />
        <Item
          label="Reset to Default Scene…"
          onSelect={onResetToDefault}
          testId="menu-edit-reset"
        />
        <Item label="Settings…" onSelect={onSettings} testId="menu-edit-settings" />
      </Menu>

      <Menu
        label="Object"
        testId="menu-object"
        open={open === 'object'}
        onOpen={() => setOpen('object')}
        onClose={close}
        onHover={hoverSwitch('object')}
      >
        {/* Phase 151 — Apply ▸ {All / Location / Rotation / Scale}. Bakes the
            selected primitive's TRS into geometry → a BakedMesh (one undo). The
            whole submenu disables when no single primitive is selected OR its
            transform is animated (D-04). Ctrl+A stays select-all (D-03): no
            keyboard binding here. */}
        <Submenu label="Apply" testId="menu-object-apply">
          {applyAnimated ? (
            <div
              className="px-3 py-1.5 text-[11px] text-fg/40"
              data-testid="menu-object-apply-animated-msg"
            >
              Apply unavailable — transform is animated (#153/#149)
            </div>
          ) : null}
          {APPLY_MASKS.map(({ mask, label }) => (
            <Item
              key={mask}
              label={label}
              disabled={applyDisabled}
              onSelect={() => {
                if (selectedId) void dispatchApplyTransform(selectedId, mask);
              }}
              testId={`menu-object-apply-${mask}`}
            />
          ))}
        </Submenu>
      </Menu>

      <Menu
        label="Select"
        testId="menu-select"
        open={open === 'select'}
        onOpen={() => setOpen('select')}
        onClose={close}
        onHover={hoverSwitch('select')}
      >
        <Item
          label="All Top-Level"
          shortcut={`${cmdKeyLabel}+A`}
          onSelect={() => useSelectionStore.getState().selectAll(getTopLevelChildIds())}
          testId="menu-select-all"
        />
        <Item
          label="None"
          shortcut="Esc"
          onSelect={() => useSelectionStore.getState().clear()}
          testId="menu-select-none"
        />
        <Item
          label="Invert"
          onSelect={() => useSelectionStore.getState().invert(getTopLevelChildIds())}
          testId="menu-select-invert"
        />
        <Divider />
        <Submenu label="By Type" testId="menu-select-by-type">
          {distinctTypes.length === 0 ? (
            <div className="px-3 py-1.5 text-[11px] text-fg/40">no nodes</div>
          ) : (
            distinctTypes.map((t) => (
              <Item
                key={t}
                label={t}
                onSelect={() => {
                  const ids = Object.values(dag.nodes)
                    .filter((n) => n.type === t)
                    .map((n) => n.id);
                  useSelectionStore.getState().selectMany(ids);
                }}
                testId={`menu-select-by-type-${t}`}
              />
            ))
          )}
        </Submenu>
      </Menu>

      <Menu
        label="View"
        testId="menu-view"
        open={open === 'view'}
        onOpen={() => setOpen('view')}
        onClose={close}
        onHover={hoverSwitch('view')}
      >
        <Item
          label="Frame Selected"
          shortcut="F"
          onSelect={frameSelected}
          testId="menu-view-frame-selected"
        />
        <Item label="Frame All" shortcut="Home" onSelect={frameAll} testId="menu-view-frame-all" />
        <Divider />
        <Item
          label={lookThrough ? '✓ Look Through Camera' : '   Look Through Camera'}
          shortcut="0"
          onSelect={() => useViewportStore.getState().toggleLookThroughCamera()}
          testId="menu-view-look-through"
        />
        <Item
          label="Camera-from-View"
          shortcut={`${cmdKeyLabel}+Shift+C`}
          onSelect={() => snapshotCameraFromOrbit()}
          testId="menu-view-camera-from-view"
        />
        <Divider />
        <Item
          label={gridVisible ? 'Hide Grid' : 'Show Grid'}
          onSelect={() => useViewportStore.getState().toggleGridVisible()}
          testId="menu-view-toggle-grid"
        />
        <Item
          label={axisWidgetVisible ? 'Hide Axis Widget' : 'Show Axis Widget'}
          onSelect={() => useViewportStore.getState().toggleAxisWidgetVisible()}
          testId="menu-view-toggle-axis"
        />
        {/* Dev-only: the FPS/ms overlay is a dev tool (default OFF for a clean
            canvas). Hidden entirely in production, where FpsMeter never renders. */}
        {import.meta.env.DEV ? (
          <Item
            label={showFpsMeter ? '✓ Show FPS Meter' : '   Show FPS Meter'}
            onSelect={() => useChromeStore.getState().toggleShowFpsMeter()}
            testId="menu-view-toggle-fps"
          />
        ) : null}
        <Divider />
        <Submenu label="Shading" testId="menu-view-shading">
          {(['studio', 'wireframe', 'rendered'] as ShadingMode[]).map((s) => (
            <Item
              key={s}
              label={`${s === shading ? '✓ ' : '   '}${s.charAt(0).toUpperCase() + s.slice(1)}`}
              onSelect={() => setShading(s)}
              testId={`menu-view-shading-${s}`}
            />
          ))}
        </Submenu>
        <Submenu label="Editor Space" testId="menu-view-space">
          {(
            [
              { value: 'view3d', label: '3D Viewport' },
              { value: 'uv', label: 'UV Editor' },
            ] as { value: SpaceType; label: string }[]
          ).map((s) => (
            <Item
              key={s.value}
              label={`${s.value === space ? '✓ ' : '   '}${s.label}`}
              onSelect={() => setSpace(s.value)}
              testId={`menu-view-space-${s.value}`}
            />
          ))}
        </Submenu>
      </Menu>
    </div>
  );
}
