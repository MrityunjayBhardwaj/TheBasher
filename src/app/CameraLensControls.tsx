// UX #12 slice 1 — the camera inspector's Lens control.
//
// Authors a camera node's lens as ONE cohesive control instead of raw param
// rows: focal length (mm) + sensor size for a PerspectiveCamera (with the
// resulting FOV shown as a derived readout, Blender-style), or zoom for an
// OrthographicCamera, plus near/far clipping for both. Every edit dispatches a
// `setParam` Op (V1/V8 — the inspector mutates the DAG only through ops), so it
// saves, undoes, and feeds the live viewport + the offscreen render like any
// creative datum (V34/V37): `fov` already flows to EditorViewCamera (look-
// through), CameraHelpers (frustum), and renderToImage (production camera).
//
// Routed under the Camera section (inspectorSections.ts); the generic ParamRows
// for that section are suppressed in NPanel because this control owns the lens
// params. Mirrors SceneEnvironmentControls (UX #9).
//
// REF: src/app/cameraLens.ts (focal↔fov math); src/app/activeCamera.ts
//      (pose read); vyapti V34/V37. Mirrors NPanel BooleanField row layout.

import { useDagStore } from '../core/dag/store';
import { DEFAULT_SENSOR_MM, focalLengthFromFov, fovFromFocalLength } from './cameraLens';
import { autoKeyCommit, routeAnimatedGrab } from './animate/autoKeyCommit';
import { ParamDiamond } from './ParamDiamond';

const ROW = 'flex items-center justify-between gap-2 px-3 py-1.5 text-[11px] text-fg/80';
const LABEL = 'font-mono text-fg/60';
const NUM =
  'w-16 rounded border border-border bg-muted px-1.5 py-0.5 text-right text-[10px] text-fg/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent';

/** Round to at most `places` decimals, dropping trailing zeros (43.5, not 43.50). */
function round(n: number, places = 1): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

export function CameraLensControls({ nodeId }: { nodeId: string }) {
  const node = useDagStore((s) => s.state.nodes[nodeId]);
  const dispatch = useDagStore((s) => s.dispatch);
  const dispatchAtomic = useDagStore((s) => s.dispatchAtomic);

  if (!node) return null;
  const params = (node.params ?? {}) as {
    fov?: number;
    sensorSize?: number;
    near?: number;
    far?: number;
    zoom?: number;
    dofEnabled?: boolean;
    focusDistance?: number;
    fStop?: number;
  };
  const isOrtho = node.type === 'OrthographicCamera';

  const dofEnabled = params.dofEnabled ?? false;
  const focusDistance = params.focusDistance ?? 5;
  const fStop = params.fStop ?? 2.8;

  const near = params.near ?? 0.1;
  const far = params.far ?? 1000;

  const setParam = (paramPath: string, value: unknown, label: string) =>
    dispatch({ type: 'setParam', nodeId, paramPath, value }, 'user', label);

  // #190 — camera params (fov/near/far) are animatable, so the lens control must
  // honor Auto-Key like every inspector ParamRow: re-route an ANIMATED param
  // through the shared seam (transient hold / keyframe) BEFORE the raw setParam,
  // then autoKeyCommit (Auto-Key ON → key it at the playhead). For an un-animated
  // param with Auto-Key OFF this is byte-identical to the prior bare setParam.
  const commitParam = (paramPath: string, value: unknown, label: string) => {
    if (routeAnimatedGrab(nodeId, paramPath, value)) return;
    setParam(paramPath, value, label);
    autoKeyCommit(nodeId, paramPath, value);
  };

  // --- Perspective lens (focal length + sensor → derived FOV) ----------------
  const fov = params.fov ?? 45;
  const sensor = params.sensorSize ?? DEFAULT_SENSOR_MM;
  const focal = round(focalLengthFromFov(fov, sensor));

  const onFocal = (mm: number) => {
    if (!Number.isFinite(mm) || mm <= 0) return;
    // Focal length is the lens; recompute (and clamp) the stored FOV from it.
    // FOV is the keyable param, so route through the autoKey-aware commit.
    commitParam('fov', fovFromFocalLength(mm, sensor), 'set camera focal length');
  };

  const onSensor = (mm: number) => {
    if (!Number.isFinite(mm) || mm <= 0) return;
    // Blender semantics: changing the sensor (body) keeps the mounted LENS
    // (focal length) fixed and re-derives the FOV. One atomic edit so undo is
    // a single step and the focal-length readout doesn't jump.
    const keptFocal = focalLengthFromFov(fov, sensor);
    const newFov = fovFromFocalLength(keptFocal, mm);
    dispatchAtomic(
      [
        { type: 'setParam', nodeId, paramPath: 'sensorSize', value: mm },
        { type: 'setParam', nodeId, paramPath: 'fov', value: newFov },
      ],
      'user',
      'set camera sensor',
    );
    // The sensor edit re-derives FOV; key the FOV too so Auto-Key follows it.
    autoKeyCommit(nodeId, 'fov', newFov);
  };

  return (
    <div className="flex flex-col" data-testid={`inspector-camera-${nodeId}`}>
      {isOrtho ? (
        <label className={ROW}>
          <span className={LABEL}>zoom</span>
          <input
            type="number"
            step={1}
            min={0}
            value={params.zoom ?? 50}
            data-testid={`inspector-camera-zoom-${nodeId}`}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n) && n > 0) setParam('zoom', n, 'set camera zoom');
            }}
            className={NUM}
          />
        </label>
      ) : (
        <>
          <label className={ROW}>
            <span className={LABEL}>focal length</span>
            <span className="flex items-center gap-1">
              <input
                type="number"
                step={1}
                min={1}
                value={focal}
                data-testid={`inspector-camera-focal-${nodeId}`}
                onChange={(e) => onFocal(Number(e.target.value))}
                className={NUM}
              />
              <span className="text-[10px] text-fg/40">mm</span>
            </span>
          </label>
          <label className={ROW}>
            <span className={LABEL}>sensor</span>
            <span className="flex items-center gap-1">
              <input
                type="number"
                step={1}
                min={1}
                value={round(sensor)}
                data-testid={`inspector-camera-sensor-${nodeId}`}
                onChange={(e) => onSensor(Number(e.target.value))}
                className={NUM}
              />
              <span className="text-[10px] text-fg/40">mm</span>
            </span>
          </label>
          {/* FOV is the stored param but presented as a derived readout — a
              director sets the lens, not the angle (Blender). The diamond keys it
              (#190): FOV is the keyable camera param the resolver overlays. */}
          <div className={ROW}>
            <span className="flex items-center gap-1">
              <ParamDiamond nodeId={nodeId} paramPath="fov" value={fov} />
              <span className={LABEL}>field of view</span>
            </span>
            <span
              className="font-mono text-[10px] text-fg/40"
              data-testid={`inspector-camera-fov-${nodeId}`}
            >
              {round(fov)}°
            </span>
          </div>

          {/* Depth of field — real bokeh in the viewport AND the still render
              (cameraDof.ts derives the CoC, V34/V37 parity). */}
          <label className="flex cursor-pointer items-center justify-between gap-2 px-3 py-1.5 text-[11px] text-fg/80">
            <span className={LABEL}>depth of field</span>
            <input
              type="checkbox"
              checked={dofEnabled}
              data-testid={`inspector-camera-dof-${nodeId}`}
              onChange={(e) => setParam('dofEnabled', e.target.checked, 'toggle depth of field')}
              className="h-3.5 w-3.5 accent-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            />
          </label>
          {dofEnabled ? (
            <>
              <label className={ROW}>
                <span className={LABEL}>focus distance</span>
                <input
                  type="number"
                  step={0.1}
                  min={0}
                  value={focusDistance}
                  data-testid={`inspector-camera-focus-${nodeId}`}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (Number.isFinite(n) && n > 0)
                      setParam('focusDistance', n, 'set focus distance');
                  }}
                  className={NUM}
                />
              </label>
              <label className={ROW}>
                <span className={LABEL}>aperture f-stop</span>
                <span className="flex items-center gap-1">
                  <span className="text-[10px] text-fg/40">f/</span>
                  <input
                    type="number"
                    step={0.1}
                    min={0.1}
                    value={fStop}
                    data-testid={`inspector-camera-fstop-${nodeId}`}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      if (Number.isFinite(n) && n > 0) setParam('fStop', n, 'set aperture f-stop');
                    }}
                    className={NUM}
                  />
                </span>
              </label>
            </>
          ) : null}
        </>
      )}

      {/* Clipping — common to both projections. near/far are keyable camera
          params (#190): the diamond keys them and edits route through autoKey. */}
      <label className={ROW}>
        <span className="flex items-center gap-1">
          <ParamDiamond nodeId={nodeId} paramPath="near" value={near} />
          <span className={LABEL}>clip near</span>
        </span>
        <input
          type="number"
          step={0.1}
          min={0}
          value={near}
          data-testid={`inspector-camera-near-${nodeId}`}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n) && n > 0) commitParam('near', n, 'set camera near clip');
          }}
          className={NUM}
        />
      </label>
      <label className={ROW}>
        <span className="flex items-center gap-1">
          <ParamDiamond nodeId={nodeId} paramPath="far" value={far} />
          <span className={LABEL}>clip far</span>
        </span>
        <input
          type="number"
          step={10}
          min={0}
          value={far}
          data-testid={`inspector-camera-far-${nodeId}`}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n) && n > 0) commitParam('far', n, 'set camera far clip');
          }}
          className={NUM}
        />
      </label>
    </div>
  );
}
