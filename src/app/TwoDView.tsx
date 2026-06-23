// TwoDView — the unified 2D View that fills the center pane when the editor
// space is '2d' (Blender's Image Editor: one 2D area, a header selector picks
// what it shows). Hosts two modes as tabs:
//
//   - UV            → the UV layout + texture backdrop (UVEditor).
//   - Render Result → the most-recent still render / AI edit (RenderResultView).
//
// Both panes stay MOUNTED; the inactive one is display:none so each pane's
// canvas + store subscriptions survive a mode switch (same discipline as the
// 3D↔2D space toggle and the TimelineDrawer dock). Active mode lives in
// twoDViewStore (persisted).
//
// File-rooted V8: src/app/. Read-only surface — never touches the DAG.

import { UVEditor } from './UVEditor';
import { RenderResultView } from './RenderResultView';
import { type TwoDViewMode, useTwoDViewStore } from './stores/twoDViewStore';

export function TwoDView() {
  const mode = useTwoDViewStore((s) => s.mode);
  const setMode = useTwoDViewStore((s) => s.setMode);

  return (
    <div data-testid="twodview" className="flex h-full w-full flex-col bg-bg">
      <div
        data-testid="twodview-tab-strip"
        role="tablist"
        aria-label="2D View tabs"
        className="flex items-stretch border-b border-border bg-muted/30 text-[11px]"
      >
        <TabButton id="uv" label="UV" active={mode === 'uv'} onClick={() => setMode('uv')} />
        <TabButton
          id="render"
          label="Render Result"
          active={mode === 'render'}
          onClick={() => setMode('render')}
        />
      </div>
      <div className="relative flex-1" style={{ minHeight: 0 }}>
        <div
          data-testid="twodview-uv-pane"
          data-active={mode === 'uv'}
          className="absolute inset-0"
          style={{ display: mode === 'uv' ? 'block' : 'none' }}
        >
          <UVEditor />
        </div>
        <div
          data-testid="twodview-render-pane"
          data-active={mode === 'render'}
          className="absolute inset-0"
          style={{ display: mode === 'render' ? 'block' : 'none' }}
        >
          <RenderResultView />
        </div>
      </div>
    </div>
  );
}

function TabButton({
  id,
  label,
  active,
  onClick,
}: {
  id: TwoDViewMode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      data-testid={`twodview-tab-${id}`}
      data-active={active}
      onClick={onClick}
      className={`flex items-center border-r border-border px-3 py-1.5 font-mono uppercase tracking-wide focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
        active ? 'bg-accent/15 text-accent' : 'text-fg/50 hover:text-fg/80'
      }`}
    >
      {label}
    </button>
  );
}
