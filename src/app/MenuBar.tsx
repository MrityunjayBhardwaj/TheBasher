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
  renameCurrentProject,
  saveCurrent,
} from './boot';
import { addPrimitive } from './AddMenu';
import { snapshotCameraFromOrbit } from './character/cameraFromView';
import { frameAll, frameSelected } from './character/framing';
import { exportDagJson } from './exportDag';
import { useEditorStore, type SpaceType } from './stores/editorStore';
import { useModeStore, type Mode } from './stores/modeStore';
import { useSelectionStore } from './stores/selectionStore';
import { useViewportStore, type ShadingMode } from './stores/viewportStore';
import type { PrimitiveKind } from './addPrimitives';
import { inputFilesToFiles } from './asset/ingestReaders';
import { importGltfFromOpfs, ingestGltfFolder, type IngestFile } from './asset/importGltf';
import { ingestSingleFile } from './asset/importCommon';
import { routeImportByExtension } from './asset/importBvhFbx';
import { useAssetErrorStore, formatAssetError } from './stores/assetErrorStore';

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
}

function Menu({ label, testId, children, open, onOpen, onClose }: MenuProps) {
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
  return (
    <div
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
          className="absolute left-full top-0 z-50 -mt-1 w-[220px] overflow-hidden rounded border border-border bg-bg shadow-lg"
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

/** Programmatically click the Chrome ProjectsMenu toggle so File → Open
 *  surfaces the same panel users get from the chrome's "projects ▾"
 *  button. Avoids re-implementing list/switch/delete in the menu bar. */
function onOpenProjects() {
  const btn = document.querySelector(
    '[data-testid="projects-menu-toggle"]',
  ) as HTMLButtonElement | null;
  btn?.click();
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

/** True iff any picked file is a glTF container (the folder-import trigger). */
function hasGltfEntry(files: readonly IngestFile[]): boolean {
  return files.some((f) => {
    const lower = f.relativePath.toLowerCase();
    return lower.endsWith('.gltf') || lower.endsWith('.glb');
  });
}

/**
 * File → Import… — Phase 7.9 (#110, glTF) extended by Phase 7.14 (#111,
 * BVH/FBX). Accepts all four importable formats through ONE entry (D-04).
 *
 * Programmatic hidden `<input type="file" webkitdirectory multiple>`:
 * directory pickers ship in Chromium/Firefox/Safari natively
 * (RESEARCH §1), so no `showDirectoryPicker` fallback is needed and no
 * mid-handler branch picks between APIs. The directory picker is kept (do NOT
 * regress multi-file glTF #82, whose `.bin`/textures siblings live alongside
 * the `.gltf` in a folder); a lone `.bvh`/`.fbx` placed in a folder routes
 * through the single-file path. The drag-drop affordance (AssetDropZone)
 * additionally accepts a bare lone-file BVH/FBX without a folder.
 *
 * Funnels onchange → `inputFilesToFiles` (Wave B reader) → either
 * `ingestGltfFolder`+`importGltfFromOpfs` (glTF folder) or
 * `ingestSingleFile`+`routeImportByExtension` (single motion file). Same
 * shared chokepoint as the AssetDropZone drop path (B12).
 *
 * folderName derivation: the picked-folder root segment of the first
 * file's `webkitRelativePath`. The `slash < 0` fallback (a `webkit-
 * directory` picker yielding a single root-level file) uses basename-
 * without-extension so the OPFS layout matches the drop single-file
 * layout (`user-imports/<basename>/<basename>.glb`) — checker C5
 * dedup parity across drop vs picker.
 *
 * Failures route to `useAssetErrorStore` (V14/silent-failure fix), NOT
 * `console.error`.
 */
function onImport(): void {
  const input = document.createElement('input');
  input.type = 'file';
  (input as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true;
  input.multiple = true;
  input.accept = '.gltf,.glb,.bvh,.fbx';
  input.style.display = 'none';
  document.body.appendChild(input);

  input.onchange = () => {
    void (async () => {
      try {
        if (!input.files || input.files.length === 0) return;
        const ingestFiles = await inputFilesToFiles(input.files);
        if (ingestFiles.length === 0) return;
        // Derive folderName from the picked-folder root segment of the
        // first file's webkitRelativePath. The lone-file edge case
        // (slash < 0 — directory picker yielding a single root-level
        // file) falls back to basename-without-ext so the OPFS layout
        // matches the AssetDropZone single-file drop (checker C5):
        // user-imports/<basename>/<basename>.<ext>.
        const first = ingestFiles[0].relativePath;
        const slash = first.indexOf('/');
        let folderName: string;
        if (slash > 0) {
          folderName = first.slice(0, slash);
        } else {
          const dot = first.lastIndexOf('.');
          folderName = dot > 0 ? first.slice(0, dot) : first;
        }
        // glTF (possibly multi-file) → folder ingest. A lone .bvh/.fbx (no
        // glTF in the set) → single-file ingest + extension routing (D-04).
        if (hasGltfEntry(ingestFiles)) {
          const entryPath = await ingestGltfFolder(ingestFiles, folderName);
          await importGltfFromOpfs(entryPath);
        } else if (ingestFiles.length === 1) {
          const entryPath = await ingestSingleFile(ingestFiles[0], folderName);
          await routeImportByExtension(entryPath);
        } else {
          // No glTF entry and not a lone file — let ingestGltfFolder surface
          // the "no glTF/glb" banner (its existing error path).
          await ingestGltfFolder(ingestFiles, folderName);
        }
      } catch (err) {
        useAssetErrorStore.getState().report('menu-import', formatAssetError(err));
      } finally {
        input.remove();
      }
    })();
  };

  input.click();
}

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

type OpenMenu = null | 'file' | 'add' | 'edit' | 'select' | 'view';

const ADD_GROUPS: {
  label: string;
  testId: string;
  items: { kind: PrimitiveKind; label: string }[];
}[] = [
  {
    label: 'Mesh',
    testId: 'menu-add-mesh',
    items: [
      { kind: 'Cube', label: 'Cube' },
      { kind: 'Sphere', label: 'UV Sphere' },
    ],
  },
  {
    label: 'Light',
    testId: 'menu-add-light',
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
    testId: 'menu-add-camera',
    items: [
      { kind: 'PerspectiveCamera', label: 'Perspective' },
      { kind: 'OrthographicCamera', label: 'Orthographic' },
    ],
  },
  {
    label: 'Empty',
    testId: 'menu-add-empty',
    items: [
      { kind: 'Group', label: 'Group' },
      { kind: 'Transform', label: 'Transform' },
    ],
  },
];

export function MenuBar() {
  const [open, setOpen] = useState<OpenMenu>(null);
  const close = () => setOpen(null);

  // Reactive bits used inside menus.
  const dag = useDagStore((s) => s.state);
  const undoLen = useDagStore((s) => s.undoStack.length);
  const redoLen = useDagStore((s) => s.redoStack.length);
  const gridVisible = useViewportStore((s) => s.gridVisible);
  const axisWidgetVisible = useViewportStore((s) => s.axisWidgetVisible);
  const shading = useViewportStore((s) => s.shading);
  const setShading = useViewportStore((s) => s.setShading);
  const space = useEditorStore((s) => s.space);
  const setSpace = useEditorStore((s) => s.setSpace);
  const mode = useModeStore((s) => s.mode);
  const setMode = useModeStore((s) => s.setMode);

  // Distinct node types for the Select → By Type submenu.
  const distinctTypes = Array.from(new Set(Object.values(dag.nodes).map((n) => n.type))).sort();

  return (
    <div
      data-testid="menubar"
      role="menubar"
      aria-label="Menu bar"
      className="flex items-center gap-0.5 border-b border-border bg-bg px-2 py-1 font-mono text-fg"
    >
      <Menu
        label="File"
        testId="menu-file"
        open={open === 'file'}
        onOpen={() => setOpen('file')}
        onClose={close}
      >
        <Item label="New Project…" onSelect={onNewProject} testId="menu-file-new" />
        <Item label="Open…" onSelect={onOpenProjects} testId="menu-file-open" />
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
          label="Export Scene as glTF…"
          onSelect={onExportGltf}
          testId="menu-file-export-gltf"
        />
        <Item label="Export DAG as JSON" onSelect={exportDagJson} testId="menu-file-export-json" />
        <Divider />
        <Item label="Import…" onSelect={onImport} testId="menu-file-import" />
      </Menu>

      <Menu
        label="Add"
        testId="menu-add"
        open={open === 'add'}
        onOpen={() => setOpen('add')}
        onClose={close}
      >
        {ADD_GROUPS.map((g) => (
          <Submenu key={g.label} label={g.label} testId={g.testId}>
            {g.items.map((item) => (
              <Item
                key={item.kind}
                label={item.label}
                onSelect={() => addPrimitive(item.kind)}
                testId={`menu-add-item-${item.kind}`}
              />
            ))}
          </Submenu>
        ))}
        <Divider />
        <Item
          label="Open Add Menu (Shift+A)"
          shortcut="⇧A"
          onSelect={() => {
            const slot = document.querySelector(
              '[data-testid="viewport-slot"]',
            ) as HTMLElement | null;
            if (slot) {
              const r = slot.getBoundingClientRect();
              import('./stores/addMenuStore').then((m) => {
                m.useAddMenuStore.getState().openAt(r.left + r.width / 2, r.top + r.height / 2);
              });
            }
          }}
          testId="menu-add-open"
        />
      </Menu>

      <Menu
        label="Edit"
        testId="menu-edit"
        open={open === 'edit'}
        onOpen={() => setOpen('edit')}
        onClose={close}
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
        label="Select"
        testId="menu-select"
        open={open === 'select'}
        onOpen={() => setOpen('select')}
        onClose={close}
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
        <Divider />
        <Submenu label="Set Mode" testId="menu-view-mode">
          {(['edit', 'run', 'animate', 'director'] as Mode[]).map((m) => (
            <Item
              key={m}
              label={`${m === mode ? '✓ ' : '   '}${m.charAt(0).toUpperCase() + m.slice(1)}`}
              onSelect={() => setMode(m)}
              testId={`menu-view-mode-${m}`}
            />
          ))}
        </Submenu>
      </Menu>
    </div>
  );
}
