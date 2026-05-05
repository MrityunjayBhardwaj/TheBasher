// Wave F lays the real R3F Canvas on top of this; for now ship a placeholder
// that occupies the slot so Wave E layout tests have a target. The Canvas
// will replace the contents WITHOUT remounting this wrapper (V8/K1 step 6).

export function Viewport() {
  return (
    <div
      data-testid="viewport-canvas-host"
      className="flex h-full w-full items-center justify-center bg-black/60 font-mono text-xs text-fg/30"
    >
      viewport (Canvas mounts in Wave F)
    </div>
  );
}
