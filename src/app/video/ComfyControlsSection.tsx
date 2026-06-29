// ComfyControlsSection — the ComfyUIWorkflow SOURCE-section renderer for the Controls
// panel (Inc 3 Slice D, the headline). It derives the animatable manifest from the
// node's imported workflow (importComfyGraph — never stored, so it can't go stale
// against the json) and renders EVERY param:
//
//   - SCHEDULABLE → an animatable row: a value field routed through the ONE shared
//     animatable seam (useAnimatableField — evaluated read + read-only-while-playing
//     gate + single-write edit) + a <ParamDiamond/> ([[H104]] — a custom control MUST
//     wire the diamond explicitly or its params are silently un-keyable). The channel
//     TYPE is chosen by the manifest valueKind in the dispatch seam (float/int →
//     KeyframeChannelNumber, string → KeyframeChannelText, image → KeyframeChannelImage)
//     — NOT inferValueType (which mis-types a string prompt as a colour). The channel
//     targets the ComfyUIWorkflow node directly at paramPath `comfy:<nodeId>.<input>`.
//   - STRUCTURAL → a read-only row + a "preview-only" note (design §7.4 — a structural
//     param can't be a per-frame schedule; it is shown, never silently dropped).
//
// The read path is DONE (Slice C): the decode resolves each schedulable param at the
// playhead via the render-identical resolveEvaluatedParam (H40), so an authored key
// shows in the composite for free. The un-animated value field writes the authored
// literal back into the stored graph json (setComfyLiteral) → the decode re-renders
// (its cache key folds the graph + resolved values).
//
// REF: docs/COMFYUI-KEYFRAME-COMPILER-DESIGN.md §6.3/§6.4/§7.4; src/core/comfy/
//      comfyGraph.ts (importComfyGraph + comfyParamPath); src/app/animate/
//      useAnimatableField.ts + src/app/ParamDiamond.tsx (the H104 seam); vyapti
//      V57/V81; hetvabhasa H104/H95.

import { useMemo, useState } from 'react';
import { useDagStore } from '../../core/dag/store';
import type { NodeId } from '../../core/dag/types';
import {
  comfyParamPath,
  importComfyGraph,
  type ComfyApiJson,
  type ComfyGraphMeta,
  type ComfyParam,
} from '../../core/comfy/comfyGraph';
import {
  BASHER_CONTROLLER_TYPE,
  comfyControllerPath,
  hasBasherControllers,
  isScalarControllerKind,
  scanBasherControllers,
  type BasherControllerDecl,
} from '../../core/comfy/basherControllers';
import { ParamDiamond } from '../ParamDiamond';
import { useAnimatableField } from '../animate/useAnimatableField';
import {
  comfyImageBindingKey,
  listProjectImages,
  listProjectVideos,
  setComfyImageBinding,
  uploadImageAndBind,
  uploadMediaAndBind,
} from './comfyImageBinding';
import { compileComfyBatch } from './compileComfyBatch';

/** Write a comfy param's authored literal back into the stored graph json (the
 *  un-animated source write): clone `params.graph`, substitute the one input, and
 *  setParam the whole graph (one atomic). The decode reads `params.graph` per frame,
 *  so this re-renders (its cache key folds the json). A wired input or a missing node
 *  is a no-op. */
function setComfyLiteral(
  comfyNodeId: NodeId,
  nodeId: string,
  inputName: string,
  value: number | string,
): void {
  const node = useDagStore.getState().state.nodes[comfyNodeId];
  const gp = (node?.params as { graph?: { apiJson?: ComfyApiJson; meta?: ComfyGraphMeta } })?.graph;
  if (!gp?.apiJson) return;
  const next = structuredClone(gp) as { apiJson: ComfyApiJson; meta?: ComfyGraphMeta };
  const target = next.apiJson[nodeId];
  if (!target || !target.inputs || Array.isArray(target.inputs[inputName])) return;
  (target.inputs as Record<string, number | string | boolean>)[inputName] = value;
  useDagStore
    .getState()
    .dispatchAtomic(
      [{ type: 'setParam', nodeId: comfyNodeId, paramPath: 'graph', value: next }],
      'user',
      `set ${nodeId}.${inputName}`,
    );
}

export function ComfySourceSection({ nodeId }: { nodeId: NodeId }) {
  // Subscribe to the node so an edited literal / controller re-derives the surface.
  const graphParam = useDagStore(
    (s) => (s.state.nodes[nodeId]?.params as { graph?: unknown } | undefined)?.graph,
  );
  const apiJson = (graphParam as { apiJson?: ComfyApiJson } | null | undefined)?.apiJson;

  // DISPATCH (docs/COMFYUI-BASHER-NODES.md), mirroring the render-time dispatch: a
  // workflow that declares basher_controller nodes shows the CONTROLLER CONTRACT rows
  // (the author's named knobs only) — NOT the inferred manifest. Otherwise the legacy
  // inference manifest (Mode B).
  const controllerMode = useMemo(() => !!apiJson && hasBasherControllers(apiJson), [apiJson]);
  const controllers = useMemo<readonly BasherControllerDecl[]>(
    () => (apiJson ? scanBasherControllers(apiJson) : []),
    [apiJson],
  );
  const params = useMemo<readonly ComfyParam[]>(() => {
    const gp = graphParam as { apiJson?: ComfyApiJson; meta?: ComfyGraphMeta } | null | undefined;
    if (!gp?.apiJson) return [];
    const meta: ComfyGraphMeta = gp.meta ?? {
      name: 'workflow',
      importedAt: '',
      fps: 30,
      frames: 1,
    };
    return importComfyGraph(gp.apiJson, meta).params;
  }, [graphParam]);

  if (controllerMode) {
    return (
      <div data-testid={`comfy-controls-${nodeId}`} className="flex flex-col">
        {controllers.map((c) =>
          !isScalarControllerKind(c.kind) ? (
            <ComfyMediaControllerRow key={c.nodeId} comfyNodeId={nodeId} decl={c} />
          ) : c.kind === 'bool' ? (
            <ComfyControllerBoolRow key={c.nodeId} comfyNodeId={nodeId} decl={c} />
          ) : (
            <ComfyControllerScalarRow key={c.nodeId} comfyNodeId={nodeId} decl={c} />
          ),
        )}
        <RenderCoherentClipButton comfyNodeId={nodeId} />
      </div>
    );
  }

  if (params.length === 0) {
    return (
      <p className="px-3 py-2 text-[11px] text-mute" data-testid={`comfy-controls-empty-${nodeId}`}>
        No workflow imported.
      </p>
    );
  }

  return (
    <div data-testid={`comfy-controls-${nodeId}`} className="flex flex-col">
      {params.map((p) =>
        p.scheduleHint !== 'schedulable' ? (
          <ComfyStructuralRow key={`${p.nodeId}.${p.inputName}`} comfyNodeId={nodeId} param={p} />
        ) : p.valueKind === 'image' ? (
          <ComfyImageParamRow key={`${p.nodeId}.${p.inputName}`} comfyNodeId={nodeId} param={p} />
        ) : p.valueKind === 'video' ? (
          <ComfyVideoParamRow key={`${p.nodeId}.${p.inputName}`} comfyNodeId={nodeId} param={p} />
        ) : (
          <ComfyParamRow key={`${p.nodeId}.${p.inputName}`} comfyNodeId={nodeId} param={p} />
        ),
      )}
      <RenderCoherentClipButton comfyNodeId={nodeId} />
    </div>
  );
}

/** Write a basher_controller's default back into the stored graph json: set its
 *  `values_json` to `[value]` (the resting value scanBasherControllers reads as the
 *  default) + frame_count 1. The render bake reads the controller via the same
 *  resolveEvaluatedParam, so an un-animated edit flows to the coherent clip. Mirrors
 *  setComfyLiteral, but targets the controller node's own payload. */
function setControllerDefault(
  comfyNodeId: NodeId,
  controllerNodeId: string,
  value: number | string | boolean,
): void {
  const node = useDagStore.getState().state.nodes[comfyNodeId];
  const gp = (node?.params as { graph?: { apiJson?: ComfyApiJson; meta?: ComfyGraphMeta } })?.graph;
  if (!gp?.apiJson) return;
  const next = structuredClone(gp) as { apiJson: ComfyApiJson; meta?: ComfyGraphMeta };
  const target = next.apiJson[controllerNodeId];
  if (!target || target.class_type !== BASHER_CONTROLLER_TYPE || !target.inputs) return;
  const inputs = target.inputs as Record<string, number | string | boolean>;
  inputs.values_json = JSON.stringify([value]);
  inputs.frame_count = 1;
  useDagStore
    .getState()
    .dispatchAtomic(
      [{ type: 'setParam', nodeId: comfyNodeId, paramPath: 'graph', value: next }],
      'user',
      `set controller ${controllerNodeId}`,
    );
}

/** "Render coherent clip" — the COMPILED batched path (Inc 4). Bakes the keyframes
 *  over the node's frame range into ONE batched workflow, submits it as a single
 *  batch, and stitches the result into a project video MediaClip. Distinct from the
 *  live per-frame preview (which the scrub already shows): coherent render is a
 *  deliberate, heavier action. Disabled while in flight; outcome → app-root toast. */
function RenderCoherentClipButton({ comfyNodeId }: { comfyNodeId: NodeId }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      data-testid={`comfy-render-clip-${comfyNodeId}`}
      title="Compile the keyframes into one batched workflow and render a coherent clip"
      onClick={async () => {
        setBusy(true);
        try {
          await compileComfyBatch(comfyNodeId);
        } finally {
          setBusy(false);
        }
      }}
      className="m-2 rounded border border-line bg-bg-2 px-2 py-1 text-[11px] text-fg hover:border-accent disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
    >
      {busy ? 'Rendering…' : '🎬 Render coherent clip'}
    </button>
  );
}

/** A short, stable label for a comfy param row: `class.input` (e.g. KSampler.cfg). */
function paramLabel(p: ComfyParam): string {
  return `${p.classType}.${p.inputName}`;
}

/** A schedulable comfy param — an animatable row. The value field routes through the
 *  shared animatable seam; the ParamDiamond keys it (the channel type is chosen by
 *  valueKind in the dispatch seam — H104). Numeric kinds get a number input; string/
 *  image kinds get a text input. */
function ComfyParamRow({ comfyNodeId, param }: { comfyNodeId: NodeId; param: ComfyParam }) {
  const isNumber = param.valueKind === 'float' || param.valueKind === 'int';
  const base = param.literal as number | string;
  const paramPath = comfyParamPath(param.nodeId, param.inputName);
  const { effective, readOnly, onEdit } = useAnimatableField<number | string>(
    comfyNodeId,
    paramPath,
    base,
    (next) => setComfyLiteral(comfyNodeId, param.nodeId, param.inputName, next),
  );
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    if (isNumber) {
      const n = parseFloat(draft);
      if (Number.isFinite(n)) onEdit(n);
    } else {
      onEdit(draft);
    }
    setDraft(null);
  };
  const display = isNumber ? String(effective) : (effective as string);
  const key = `${param.nodeId}-${param.inputName}`;
  return (
    <div
      data-testid={`comfy-param-row-${comfyNodeId}-${key}`}
      className="flex items-center gap-1 border-b border-line px-2 py-1 text-[11px]"
    >
      <span
        className="flex-1 truncate text-mute"
        title={`comfy:${param.nodeId}.${param.inputName}`}
      >
        {paramLabel(param)}
      </span>
      <input
        type={isNumber ? 'number' : 'text'}
        value={draft ?? display}
        readOnly={readOnly}
        data-testid={`comfy-param-input-${comfyNodeId}-${key}`}
        onFocus={() => setDraft(display)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit();
            (e.target as HTMLInputElement).blur();
          }
        }}
        className={`${isNumber ? 'w-16 text-right' : 'w-32'} rounded border border-line bg-bg-2 px-1 text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent`}
      />
      <ParamDiamond
        nodeId={comfyNodeId}
        paramPath={paramPath}
        value={base}
        testid={`comfy-param-diamond-${comfyNodeId}-${key}`}
      />
    </div>
  );
}

/** An 'image'-valueKind comfy param (e.g. LoadImage.image) — the GENERIC image-input
 *  affordance (§7.1): pick an image already in this project from a dropdown, or upload
 *  a new one. NOT a typed server-side filename, NOT a ControlNet special case. The
 *  choice is stored as an OPFS path in the node's imageBindings map; the decode uploads
 *  the bytes + rewrites the input at /prompt time. "None" falls back to the authored
 *  literal (the workflow's own filename). */
function ComfyImageParamRow({ comfyNodeId, param }: { comfyNodeId: NodeId; param: ComfyParam }) {
  const key = comfyImageBindingKey(param.nodeId, param.inputName);
  // Select the stable `state` ref (changes only per dispatch) and memo the list, so
  // the selector never returns a fresh array per render (useSyncExternalStore churn).
  const state = useDagStore((s) => s.state);
  const images = useMemo(() => listProjectImages(state), [state]);
  const bound = useDagStore(
    (s) =>
      (s.state.nodes[comfyNodeId]?.params as { imageBindings?: Record<string, string> } | undefined)
        ?.imageBindings?.[key] ?? '',
  );
  const rowKey = `${param.nodeId}-${param.inputName}`;
  return (
    <div
      data-testid={`comfy-param-row-${comfyNodeId}-${rowKey}`}
      className="flex items-center gap-1 border-b border-line px-2 py-1 text-[11px]"
    >
      <span
        className="flex-1 truncate text-mute"
        title={`comfy:${param.nodeId}.${param.inputName}`}
      >
        {paramLabel(param)}
      </span>
      <select
        value={bound}
        data-testid={`comfy-param-input-${comfyNodeId}-${rowKey}`}
        onChange={(e) => setComfyImageBinding(comfyNodeId, key, e.target.value || null)}
        className="w-28 truncate rounded border border-line bg-bg-2 px-1 text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        <option value="">{`None · ${String(param.literal)}`}</option>
        {images.map((img) => (
          <option key={img.src} value={img.src}>
            {img.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        data-testid={`comfy-param-upload-${comfyNodeId}-${rowKey}`}
        title="Upload an image and bind it to this input"
        onClick={() => uploadImageAndBind(comfyNodeId, key)}
        className="rounded border border-line bg-bg-2 px-1 text-mute hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        ⬆
      </button>
    </div>
  );
}

/** A 'video'-valueKind comfy param (e.g. LoadVideo.file) — the GENERIC video-input
 *  affordance, the Mode-B mirror of the kind=video controller (docs/COMFYUI-BASHER-
 *  NODES.md): pick a project video from a dropdown, or upload a new one. The choice is
 *  stored as an OPFS path in the node's imageBindings map keyed `<nodeId>.file`; the
 *  compile path's applyComfyImageBindings uploads the bytes (the real container ext is
 *  kept by comfyUploadExt) + rewrites `inputs.file` at submit — FOR FREE, the same
 *  out-of-band media transport image bindings use. "None" keeps the authored filename.
 *  The bound video's frame count sets the batch N (the input media drives the length). */
function ComfyVideoParamRow({ comfyNodeId, param }: { comfyNodeId: NodeId; param: ComfyParam }) {
  const key = comfyImageBindingKey(param.nodeId, param.inputName);
  const state = useDagStore((s) => s.state);
  const videos = useMemo(() => listProjectVideos(state), [state]);
  const bound = useDagStore(
    (s) =>
      (s.state.nodes[comfyNodeId]?.params as { imageBindings?: Record<string, string> } | undefined)
        ?.imageBindings?.[key] ?? '',
  );
  const rowKey = `${param.nodeId}-${param.inputName}`;
  return (
    <div
      data-testid={`comfy-param-row-${comfyNodeId}-${rowKey}`}
      className="flex items-center gap-1 border-b border-line px-2 py-1 text-[11px]"
    >
      <span
        className="flex-1 truncate text-mute"
        title={`comfy:${param.nodeId}.${param.inputName}`}
      >
        {paramLabel(param)}
      </span>
      <select
        value={bound}
        data-testid={`comfy-param-input-${comfyNodeId}-${rowKey}`}
        onChange={(e) => setComfyImageBinding(comfyNodeId, key, e.target.value || null)}
        className="w-28 truncate rounded border border-line bg-bg-2 px-1 text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        <option value="">{`None · ${String(param.literal)}`}</option>
        {videos.map((v) => (
          <option key={v.src} value={v.src}>
            {v.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        data-testid={`comfy-param-upload-${comfyNodeId}-${rowKey}`}
        title="Upload a video and bind it to this input"
        onClick={() => uploadMediaAndBind(comfyNodeId, key, 'video')}
        className="rounded border border-line bg-bg-2 px-1 text-mute hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        ⬆
      </button>
    </div>
  );
}

/** A structural comfy param — read-only, with a "preview-only" note (§7.4: a topology/
 *  batch-shape param can't be a per-frame schedule, but it is shown, never dropped). */
function ComfyStructuralRow({ comfyNodeId, param }: { comfyNodeId: NodeId; param: ComfyParam }) {
  const key = `${param.nodeId}-${param.inputName}`;
  return (
    <div
      data-testid={`comfy-structural-row-${comfyNodeId}-${key}`}
      className="flex items-center gap-1 border-b border-line px-2 py-1 text-[11px]"
      title="Structural — changes graph topology / batch shape, so it can't be keyframed (preview-only)."
    >
      <span className="flex-1 truncate text-mute">{paramLabel(param)}</span>
      <span className="truncate text-fg/60">{String(param.literal)}</span>
      <span className="select-none text-[9px] uppercase tracking-wide text-fg/30">
        preview-only
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mode A — the basher_controller contract rows (the author's DECLARED knobs).
// ---------------------------------------------------------------------------

/** A scalar `basher_controller` (float/int/string) — a keyframeable row labelled with
 *  the author's declared NAME. The value field routes through the shared animatable
 *  seam (paramPath `controller:<nodeId>`); the ParamDiamond keys it via the controller
 *  first-key (channel type = the declared kind, H124). An un-animated edit writes the
 *  controller's default. Mirrors ComfyParamRow, sourced from a declared controller. */
function ComfyControllerScalarRow({
  comfyNodeId,
  decl,
}: {
  comfyNodeId: NodeId;
  decl: BasherControllerDecl;
}) {
  const isNumber = decl.kind === 'float' || decl.kind === 'int';
  const base = decl.defaultValue as number | string;
  const paramPath = comfyControllerPath(decl.nodeId);
  const { effective, readOnly, onEdit } = useAnimatableField<number | string>(
    comfyNodeId,
    paramPath,
    base,
    (next) => setControllerDefault(comfyNodeId, decl.nodeId, next),
  );
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    if (isNumber) {
      const n = parseFloat(draft);
      if (Number.isFinite(n)) onEdit(n);
    } else {
      onEdit(draft);
    }
    setDraft(null);
  };
  const display = isNumber ? String(effective) : (effective as string);
  return (
    <div
      data-testid={`comfy-controller-row-${comfyNodeId}-${decl.nodeId}`}
      className="flex items-center gap-1 border-b border-line px-2 py-1 text-[11px]"
    >
      <span className="flex-1 truncate text-fg" title={`controller:${decl.nodeId} (${decl.kind})`}>
        {decl.name}
      </span>
      <input
        type={isNumber ? 'number' : 'text'}
        value={draft ?? display}
        readOnly={readOnly}
        data-testid={`comfy-controller-input-${comfyNodeId}-${decl.nodeId}`}
        onFocus={() => setDraft(display)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit();
            (e.target as HTMLInputElement).blur();
          }
        }}
        className={`${isNumber ? 'w-16 text-right' : 'w-32'} rounded border border-line bg-bg-2 px-1 text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent`}
      />
      <ParamDiamond
        nodeId={comfyNodeId}
        paramPath={paramPath}
        value={base}
        testid={`comfy-controller-diamond-${comfyNodeId}-${decl.nodeId}`}
      />
    </div>
  );
}

/** A bool `basher_controller` — a constant toggle (bool isn't a keyframeable per-frame
 *  channel, so no diamond; it sets the controller default). */
function ComfyControllerBoolRow({
  comfyNodeId,
  decl,
}: {
  comfyNodeId: NodeId;
  decl: BasherControllerDecl;
}) {
  const checked = decl.defaultValue === true;
  return (
    <div
      data-testid={`comfy-controller-row-${comfyNodeId}-${decl.nodeId}`}
      className="flex items-center gap-1 border-b border-line px-2 py-1 text-[11px]"
    >
      <span className="flex-1 truncate text-fg" title={`controller:${decl.nodeId} (bool)`}>
        {decl.name}
      </span>
      <input
        type="checkbox"
        checked={checked}
        data-testid={`comfy-controller-input-${comfyNodeId}-${decl.nodeId}`}
        onChange={(e) => setControllerDefault(comfyNodeId, decl.nodeId, e.target.checked)}
        className="accent-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      />
    </div>
  );
}

/** An image/video `basher_controller` — a MEDIA input. kind=image is a real bind:
 *  pick a project image or upload one, stored under `${controllerNodeId}.image` in
 *  the node's imageBindings map — the SAME generic image-binding machinery the Mode-B
 *  LoadImage rows use, so the compile path's applyComfyImageBindings uploads the bytes
 *  + rewrites the controller's `image` input at submit FOR FREE (the out-of-band media
 *  transport, docs/COMFYUI-BASHER-NODES.md). kind=video binding is the next slice. */
function ComfyMediaControllerRow({
  comfyNodeId,
  decl,
}: {
  comfyNodeId: NodeId;
  decl: BasherControllerDecl;
}) {
  if (decl.kind === 'image') {
    return <ComfyImageControllerRow comfyNodeId={comfyNodeId} decl={decl} />;
  }
  if (decl.kind === 'video') {
    return <ComfyVideoControllerRow comfyNodeId={comfyNodeId} decl={decl} />;
  }
  // any other media kind — surfaced read-only so it's never silently invisible.
  return (
    <div
      data-testid={`comfy-controller-row-media-${decl.nodeId}`}
      className="flex items-center gap-1 border-b border-line px-2 py-1 text-[11px]"
      title={`controller:${decl.nodeId} (${decl.kind}) — binding is a later slice`}
    >
      <span className="flex-1 truncate text-fg">{decl.name}</span>
      <span className="select-none text-[9px] uppercase tracking-wide text-fg/30">
        {decl.kind} · bind soon
      </span>
    </div>
  );
}

/** A video `basher_controller` — bind a project video (or upload) to drive the
 *  controller's IMAGE-batch output. Mirrors ComfyImageControllerRow but keyed on the
 *  controller's `video` input (`${controllerNodeId}.video`) and sourced from project
 *  VIDEOS. The bound video's frame count sets the batch N at render. */
function ComfyVideoControllerRow({
  comfyNodeId,
  decl,
}: {
  comfyNodeId: NodeId;
  decl: BasherControllerDecl;
}) {
  const key = comfyImageBindingKey(decl.nodeId, 'video');
  const state = useDagStore((s) => s.state);
  const videos = useMemo(() => listProjectVideos(state), [state]);
  const bound = useDagStore(
    (s) =>
      (s.state.nodes[comfyNodeId]?.params as { imageBindings?: Record<string, string> } | undefined)
        ?.imageBindings?.[key] ?? '',
  );
  return (
    <div
      data-testid={`comfy-controller-row-${comfyNodeId}-${decl.nodeId}`}
      className="flex items-center gap-1 border-b border-line px-2 py-1 text-[11px]"
    >
      <span className="flex-1 truncate text-fg" title={`controller:${decl.nodeId} (video)`}>
        {decl.name}
      </span>
      <select
        value={bound}
        data-testid={`comfy-controller-input-${comfyNodeId}-${decl.nodeId}`}
        onChange={(e) => setComfyImageBinding(comfyNodeId, key, e.target.value || null)}
        className="w-28 truncate rounded border border-line bg-bg-2 px-1 text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        <option value="">None</option>
        {videos.map((v) => (
          <option key={v.src} value={v.src}>
            {v.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        data-testid={`comfy-controller-upload-${comfyNodeId}-${decl.nodeId}`}
        title="Upload a video and bind it to this controller"
        onClick={() => uploadMediaAndBind(comfyNodeId, key, 'video')}
        className="rounded border border-line bg-bg-2 px-1 text-mute hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        ⬆
      </button>
    </div>
  );
}

/** An image `basher_controller` — bind a project image (or upload) to drive the
 *  controller's IMAGE output. Mirrors ComfyImageParamRow but keyed on the controller's
 *  own `image` input (`${controllerNodeId}.image`). "None" falls back to the node's
 *  authored filename. */
function ComfyImageControllerRow({
  comfyNodeId,
  decl,
}: {
  comfyNodeId: NodeId;
  decl: BasherControllerDecl;
}) {
  const key = comfyImageBindingKey(decl.nodeId, 'image');
  const state = useDagStore((s) => s.state);
  const images = useMemo(() => listProjectImages(state), [state]);
  const bound = useDagStore(
    (s) =>
      (s.state.nodes[comfyNodeId]?.params as { imageBindings?: Record<string, string> } | undefined)
        ?.imageBindings?.[key] ?? '',
  );
  return (
    <div
      data-testid={`comfy-controller-row-${comfyNodeId}-${decl.nodeId}`}
      className="flex items-center gap-1 border-b border-line px-2 py-1 text-[11px]"
    >
      <span className="flex-1 truncate text-fg" title={`controller:${decl.nodeId} (image)`}>
        {decl.name}
      </span>
      <select
        value={bound}
        data-testid={`comfy-controller-input-${comfyNodeId}-${decl.nodeId}`}
        onChange={(e) => setComfyImageBinding(comfyNodeId, key, e.target.value || null)}
        className="w-28 truncate rounded border border-line bg-bg-2 px-1 text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        <option value="">None</option>
        {images.map((img) => (
          <option key={img.src} value={img.src}>
            {img.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        data-testid={`comfy-controller-upload-${comfyNodeId}-${decl.nodeId}`}
        title="Upload an image and bind it to this controller"
        onClick={() => uploadImageAndBind(comfyNodeId, key)}
        className="rounded border border-line bg-bg-2 px-1 text-mute hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        ⬆
      </button>
    </div>
  );
}
