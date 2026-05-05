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
import { NodeList } from './NodeList';
import { RightDrawer } from './RightDrawer';
import { Viewport } from '../viewport/Viewport';
import { useModeStore } from './stores/modeStore';

export function Layout() {
  const mode = useModeStore((s) => s.mode);
  return (
    <div
      data-testid="layout"
      data-mode={mode}
      className="grid h-full w-full bg-bg text-fg"
      style={{
        gridTemplateColumns:
          mode === 'simple'
            ? '0 0 1fr 0 320px'
            : mode === 'pro'
              ? '220px 220px 1fr 320px 320px'
              : '180px 0 1fr 280px 280px',
        gridTemplateRows: 'auto 1fr auto',
        gridTemplateAreas: `
          "chrome chrome chrome chrome chrome"
          "library tree viewport inspector drawer"
          "timeline timeline timeline timeline timeline"
        `,
      }}
    >
      <div style={{ gridArea: 'chrome' }}>
        <Chrome />
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

      {/* tree slot reserved for P1 scene-tree projection */}
      <div
        style={{
          gridArea: 'tree',
          display: mode === 'pro' ? 'block' : 'none',
        }}
        className="border-r border-border bg-muted/20 text-xs text-fg/40"
        data-testid="tree-slot"
      >
        <header className="border-b border-border px-3 py-2 font-mono uppercase tracking-wide text-fg/70">
          tree
        </header>
        <div className="p-4">scene tree (P1)</div>
      </div>

      <div
        style={{ gridArea: 'viewport' }}
        className="relative overflow-hidden"
        data-testid="viewport-slot"
      >
        <AssetDropZone>
          <Viewport />
        </AssetDropZone>
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

      <div
        style={{ gridArea: 'timeline' }}
        className="border-t border-border bg-muted/30 text-xs text-fg/40"
        data-testid="timeline-slot"
      >
        <div className="px-3 py-1 font-mono">timeline · empty (lands in P3)</div>
      </div>
    </div>
  );
}
