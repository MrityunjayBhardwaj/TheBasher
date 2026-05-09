// Layout owns the CSS-grid named regions. Mode toggling NEVER changes which
// React component tree owns the viewport — V8/K1 step 6 ("Canvas mounts ONCE,
// never on mode switch"). The grid template + region visibility shifts via
// data attributes; the Canvas DOM node stays put.
//
// Per D-UX-5 (UI-SPEC §3.2): density axis dropped. One canonical layout. The
// only mode-induced grid change is Director (D-UX-9) — chrome regions collapse
// to 0 width. Per-panel collapse for the non-Director case will be wired
// through chromeStore in W2/W3 (R4 ToolRail / R5 LeftSidebar). For W1 the
// non-Director layout is the previous "pro" density: full chrome visible.
//
// REF: THESIS.md §11, §17; krama K1; docs/UI-SPEC.md §3.1, §3.2, §3.5.

import { AssetDropZone } from './AssetDropZone';
import { Chrome } from './Chrome';
import { DiffBar } from './DiffBar';
import { Inspector } from './Inspector';
import { Library } from './Library';
import { MenuBar } from './MenuBar';
import { NodeList } from './NodeList';
import { NPanel } from './NPanel';
import { RightDrawer } from './RightDrawer';
import { SceneTree } from './SceneTree';
import { TimelineDrawer } from '../timeline/TimelineDrawer';
import { TransformToolbar } from './TransformToolbar';
import { UVEditor } from './UVEditor';
import { Viewport } from '../viewport/Viewport';
import { useAddMenuStore } from './stores/addMenuStore';
import { useEditorStore } from './stores/editorStore';
import { useModeStore } from './stores/modeStore';

export function Layout() {
  const mode = useModeStore((s) => s.mode);
  const space = useEditorStore((s) => s.space);
  const isDirector = mode === 'director';
  return (
    <div
      data-testid="layout"
      data-mode={mode}
      data-space={space}
      className="grid h-full w-full bg-bg text-fg"
      style={{
        // Director (D-UX-9) collapses chrome to 0; otherwise full chrome.
        // Per-panel collapse via chromeStore lands in W2/W3.
        gridTemplateColumns: isDirector
          ? '0 0 1fr 0 0'
          : '180px 220px 1fr 280px 280px',
        gridTemplateRows: 'auto auto auto 1fr auto',
        gridTemplateAreas: `
          "menu menu menu menu menu"
          "chrome chrome chrome chrome chrome"
          "toolbar toolbar toolbar toolbar toolbar"
          "library tree viewport inspector drawer"
          "timeline timeline timeline timeline timeline"
        `,
      }}
    >
      <div style={{ gridArea: 'menu', display: isDirector ? 'none' : 'block' }}>
        <MenuBar />
      </div>
      <div style={{ gridArea: 'chrome', display: isDirector ? 'none' : 'block' }}>
        <Chrome />
      </div>
      <div style={{ gridArea: 'toolbar', display: isDirector ? 'none' : 'block' }}>
        <TransformToolbar />
      </div>

      <div
        style={{
          gridArea: 'library',
          display: isDirector ? 'none' : 'flex',
          flexDirection: 'column',
          minHeight: 0,
        }}
      >
        <Library />
        <NodeList />
      </div>

      <div
        style={{
          gridArea: 'tree',
          display: isDirector ? 'none' : 'block',
        }}
        data-testid="tree-slot"
      >
        <SceneTree />
      </div>

      <div
        style={{ gridArea: 'viewport' }}
        className="relative overflow-hidden"
        data-testid="viewport-slot"
        onContextMenu={(e) => {
          // RMB click (without drag) → Blender-style Add menu. RMB drag
          // still pans via OrbitControls — the browser only fires
          // contextmenu when there was no drag motion. preventDefault
          // suppresses the native menu so ours wins.
          e.preventDefault();
          useAddMenuStore.getState().openAt(e.clientX, e.clientY);
        }}
      >
        {/* Space toggle uses display:none so the Canvas DOM node stays
            mounted while the user is in the UV editor — K1 step 6 (Canvas
            mounts ONCE; never on space switch — same discipline as mode
            switch). Returning to view3d is instant; GPU state preserved. */}
        <div
          style={{
            display: space === 'view3d' ? 'block' : 'none',
            position: 'absolute',
            inset: 0,
          }}
          data-testid="view3d-slot"
        >
          <DiffBar />
          <AssetDropZone>
            <Viewport />
          </AssetDropZone>
          {/* NPanel is HTML, NOT R3F — overlays the viewport via DOM.
              Removed in W7 per D-UX-8 (corrected); functions absorbed into R8. */}
          <NPanel />
        </div>
        <div
          style={{
            display: space === 'uv' ? 'block' : 'none',
            position: 'absolute',
            inset: 0,
          }}
          data-testid="uv-slot"
        >
          <UVEditor />
        </div>
      </div>

      <div
        style={{
          gridArea: 'inspector',
          display: isDirector ? 'none' : 'block',
        }}
      >
        <Inspector />
      </div>

      <div
        style={{
          gridArea: 'drawer',
          display: isDirector ? 'none' : 'flex',
          flexDirection: 'column',
          minHeight: 0,
        }}
      >
        <RightDrawer />
      </div>

      {/* Timeline is mode-gated (D-UX-1) — visible only in Animate. The
          subtree stays mounted (V11 Canvas-mounts-once analog: store
          subscriptions and DOM stay; CSS hides). */}
      <div
        style={{ gridArea: 'timeline', display: mode === 'animate' ? 'block' : 'none' }}
        data-testid="timeline-slot"
      >
        <TimelineDrawer />
      </div>
    </div>
  );
}
