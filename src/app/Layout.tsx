// Layout owns the CSS-grid named regions. Mode toggling NEVER changes which
// React component tree owns the viewport — V8/K1 step 6 ("Canvas mounts ONCE,
// never on mode switch"). The grid template + region visibility shifts via
// data attributes; the Canvas DOM node stays put.
//
// REF: THESIS.md §11, §17, krama K1.

import { AssetDropZone } from './AssetDropZone';
import { Chrome } from './Chrome';
import { Inspector } from './Inspector';
import { Library } from './Library';
import { MenuBar } from './MenuBar';
import { NodeList } from './NodeList';
import { NPanel } from './NPanel';
import { RightDrawer } from './RightDrawer';
import { SceneTree } from './SceneTree';
import { Timebar } from './Timebar';
import { TransformToolbar } from './TransformToolbar';
import { UVEditor } from './UVEditor';
import { Viewport } from '../viewport/Viewport';
import { useAddMenuStore } from './stores/addMenuStore';
import { useEditorStore } from './stores/editorStore';
import { useModeStore } from './stores/modeStore';

export function Layout() {
  const mode = useModeStore((s) => s.mode);
  const space = useEditorStore((s) => s.space);
  return (
    <div
      data-testid="layout"
      data-mode={mode}
      data-space={space}
      className="grid h-full w-full bg-bg text-fg"
      style={{
        gridTemplateColumns:
          mode === 'simple'
            ? '0 0 1fr 0 320px'
            : mode === 'pro'
              ? '220px 220px 1fr 320px 320px'
              : '180px 0 1fr 280px 280px',
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
      <div style={{ gridArea: 'menu' }}>
        <MenuBar />
      </div>
      <div style={{ gridArea: 'chrome' }}>
        <Chrome />
      </div>
      <div style={{ gridArea: 'toolbar' }}>
        <TransformToolbar />
      </div>

      <div
        style={{
          gridArea: 'library',
          display: mode === 'simple' ? 'none' : 'flex',
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
          display: mode === 'pro' ? 'block' : 'none',
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
          <AssetDropZone>
            <Viewport />
          </AssetDropZone>
          {/* NPanel is HTML, NOT R3F — overlays the viewport via DOM. */}
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
          display: mode === 'simple' ? 'none' : 'block',
        }}
      >
        <Inspector />
      </div>

      <div
        style={{
          gridArea: 'drawer',
          display: mode === 'pro' ? 'none' : 'block',
        }}
      >
        <RightDrawer />
      </div>

      <div style={{ gridArea: 'timeline' }} data-testid="timeline-slot">
        <Timebar />
      </div>
    </div>
  );
}
