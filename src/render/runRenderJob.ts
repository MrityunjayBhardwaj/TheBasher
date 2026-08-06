// runRenderJob — the impure execution side of P4's render graph.
//
// The RenderJob NODE evaluator (src/nodes/RenderJob.ts) returns metadata
// only — what frames, which passes, where to write. Actual frame-by-frame
// dispatch lives here. Walks the frame range; at each frame, evaluates
// every connected pass node at the matching `Time`; encodes per-pass
// pixels via an injectable `PassEncoder`; writes PNG bytes through
// StorageCapability (V6, no direct fs/opfs access).
//
// V8 (file-rooted dispatch rule): src/render/* MUST NOT emit Ops. This
// module reads DagState and writes to StorageCapability. It never calls
// dagStore.dispatch / setState. Reviewers reject any import of dispatch
// from this directory.
//
// PassEncoder is the seam between the pure DAG metadata and real pixels.
// Production wires a THREE.WebGLRenderer-backed encoder; tests inject a
// stub encoder that returns deterministic placeholder bytes. Either way
// runRenderJob's orchestration (frame walk, dispatch order, storage path)
// is identical — the only thing that varies is who turns SceneValue +
// CameraValue + Time into pixel bytes.
//
// REF: THESIS §43 (RenderJob), §49 (Time as first-class), §51 (caching),
// vyapti V6 (capability interfaces) + V8 (file-rooted dispatch),
// project_p4_prompt locked decisions ("main thread sync first; Worker
// upgrade as Wave B.1 if perf demands").

import { evaluate } from '../core/dag/evaluator';
// #524 — a pure READER, which is what keeps this inside V8: it derives a state, it never
// emits an Op and never touches the store.
import { effectiveDagState } from '../app/effectiveParams';
import { recomposeCameraObject } from '../nodes/cameraRecompose';
import type { DagState } from '../core/dag/state';
import type { EvalCtx, NodeId } from '../core/dag/types';
import type { StorageCapability } from '../core/storage';
import type {
  CameraValue,
  ImagePassKind,
  ImageValue,
  JobResultValue,
  SceneValue,
} from '../nodes/types';

/** Encodes a single pass at a single frame into PNG bytes. */
export interface PassEncoder {
  (input: {
    pass: ImageValue;
    scene: SceneValue;
    camera: CameraValue;
    frame: number;
    seconds: number;
  }): Promise<Uint8Array>;
}

export interface RunRenderJobDeps {
  storage: StorageCapability;
  encoder: PassEncoder;
}

export interface RenderJobReport {
  jobId: string;
  framesWritten: number;
  passKinds: ImagePassKind[];
  /** Paths written, in dispatch order. */
  outputs: string[];
}

/**
 * Walks the frame range described by the RenderJob node `jobNodeId`,
 * evaluating each connected pass at the matching Time, encoding pixels via
 * `deps.encoder`, and writing the bytes through `deps.storage`. Returns a
 * report enumerating every output path so callers can describe the run.
 *
 * Cycle / time-source assumptions: the dag MUST already contain a
 * TimeSource the passes are wired to. The RenderJob's `time` socket is not
 * required to be wired (it's metadata-only on RenderJob), but every
 * connected pass IS time-dependent and reads its `time` input.
 */
export async function runRenderJob(
  jobNodeId: NodeId,
  state: DagState,
  deps: RunRenderJobDeps,
): Promise<RenderJobReport> {
  const job = state.nodes[jobNodeId];
  if (!job) throw new Error(`runRenderJob: unknown jobNodeId "${jobNodeId}"`);
  if (job.type !== 'RenderJob') {
    throw new Error(`runRenderJob: node "${jobNodeId}" is not a RenderJob (got ${job.type})`);
  }

  // Evaluate the RenderJob once at frame 0 to derive the metadata record.
  // The evaluator validates params via the node's zod schema, so we get
  // the typed JobResultValue back without re-parsing here.
  const meta = evaluate(state, jobNodeId, { ctx: ctxForFrame(0, 30) }).value as JobResultValue;

  // Resolve the connected pass node ids in dispatch order. Reading
  // `state.nodes[jobNodeId].inputs['pass-input']` directly so we keep the
  // node-id mapping (not just the resolved values). The evaluator gives
  // us values; the node ids drive per-frame re-evaluation.
  const passBinding = job.inputs['pass-input'];
  const passRefs =
    passBinding === undefined ? [] : Array.isArray(passBinding) ? passBinding : [passBinding];

  const outputs: string[] = [];
  const fps = meta.frames.fps;
  for (let frame = meta.frames.start; frame <= meta.frames.end; frame++) {
    const seconds = frame / fps;
    const ctx = ctxForFrame(frame, fps);
    // #524 — the cook's params for THIS frame. A keyframe on a cube's `size` or a driver on
    // a modifier's `count` is consumed inside `evaluate` to build geometry, so no overlay
    // applied downstream of the cook can reach it; folding here is what puts the animated
    // value in front of the build. Every `evaluate` below reads `frameState`, not `state`,
    // and that is the whole wiring — a call left on `state` renders the un-animated cook
    // with nothing to show for it (`effectiveParams.gate.test.ts` counts them).
    //
    // Per frame rather than hoisted, because the fold is a function of `ctx.time`. It
    // returns `state` itself when nothing is overlaid, so an un-animated job pays one pass
    // over the node table and no rebuild.
    const frameState = effectiveDagState(state, ctx);
    for (const ref of passRefs) {
      const passResult = evaluate(frameState, ref.node, { ctx, socket: ref.socket });
      const pass = passResult.value as ImageValue;
      // Pass evaluators consume Scene + Camera via their own input
      // sockets — read those producers off the pass node's inputs so
      // the encoder gets resolved POJOs without re-walking the dag here.
      const passNode = state.nodes[ref.node];
      const sceneRef = passNode?.inputs.scene;
      const cameraRef = passNode?.inputs.camera;
      if (!sceneRef || Array.isArray(sceneRef) || !cameraRef || Array.isArray(cameraRef)) {
        throw new Error(
          `runRenderJob: pass "${ref.node}" missing single Scene or Camera input — cannot dispatch`,
        );
      }
      const scene = evaluate(frameState, sceneRef.node, { ctx, socket: sceneRef.socket })
        .value as SceneValue;
      // #387 — this is a RAW `evaluate` + cast, not a socket gather, so it is its own
      // road and needs the recompose in its own right: a split camera reaching the
      // encoder as an ObjectValue would hand it a struct with no `fov`/`lookAt` at all.
      // Fused → null → unchanged.
      const cameraValue = evaluate(frameState, cameraRef.node, {
        ctx,
        socket: cameraRef.socket,
      }).value;
      const camera = recomposeCameraObject(cameraValue) ?? (cameraValue as CameraValue);

      const bytes = await deps.encoder({ pass, scene, camera, frame, seconds });
      const path = framePath(meta.outputPath, pass.passKind, frame);
      await deps.storage.write(path, bytes);
      outputs.push(path);
    }
  }

  return {
    jobId: meta.jobId,
    framesWritten: outputs.length / Math.max(passRefs.length, 1),
    passKinds: meta.passKinds.slice(),
    outputs,
  };
}

function ctxForFrame(frame: number, fps: number): EvalCtx {
  const seconds = frame / fps;
  return {
    time: {
      frame,
      seconds,
      normalized: 0,
    },
  };
}

function framePath(outputPath: string, passKind: ImagePassKind, frame: number): string {
  const trimmed = outputPath.replace(/\/+$/, '');
  const padded = frame.toString().padStart(4, '0');
  return `${trimmed}/${passKind}_${padded}.png`;
}
