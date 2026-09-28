// #1193 — a camera's far plane defaults to Blender's Clip End.
//
// Blender 5.1.1, measured 2026-09-22: `bpy.types.Camera.bl_rna.properties['clip_end'].default`
// and a fresh `bpy.data.cameras.new(...)` both give 1000.0. The number is written out here
// rather than read from `DEFAULT_CAMERA_FAR`: a test that compared the constant with itself
// would stay green if the constant went back to 500, which is the regression it exists for.

import { beforeAll, describe, expect, it } from 'vitest';
import { applyOp, emptyDagState } from '../core/dag';
import { buildDefaultDagState } from '../core/project/default';
import { CameraDataNode, CameraDataParams } from './CameraData';
import { registerAllNodes } from './registerAll';

const BLENDER_CLIP_END = 1000;
const BLENDER_CLIP_START = 0.1;

beforeAll(() => registerAllNodes());

describe('#1193 / #1195 — CameraData clip planes default to Blender’s 0.1–1000', () => {
  it('the schema fills a missing far with 1000', () => {
    expect(CameraDataParams.parse({ projection: 'Perspective', fov: 45 }).far).toBe(
      BLENDER_CLIP_END,
    );
  });

  it('a camera added without a far stores 1000', () => {
    const s = applyOp(emptyDagState(), {
      type: 'addNode',
      nodeId: 'cam',
      nodeType: 'CameraData',
      params: { projection: 'Perspective', fov: 45 },
    }).next;
    expect((s.nodes.cam.params as { far: number }).far).toBe(BLENDER_CLIP_END);
  });

  it('the evaluated value falls back to 1000 for a bag with no far (the hydrate seam)', () => {
    const value = CameraDataNode.evaluate(
      { projection: 'Perspective', fov: 45 } as never,
      {} as never,
      {} as never,
    );
    expect((value as { far: number }).far).toBe(BLENDER_CLIP_END);
  });

  it('the default project’s camera is at 1000', () => {
    const params = buildDefaultDagState().nodes.n_camera_data.params as { far: number };
    expect(params.far).toBe(BLENDER_CLIP_END);
  });

  it('control: a far the author wrote is kept', () => {
    expect(CameraDataParams.parse({ projection: 'Perspective', fov: 45, far: 500 }).far).toBe(500);
  });

  // #1195 — the near plane, the same way. 0.1 is `Camera.clip_start` on Blender 5.1.1,
  // NOT the viewport's 0.01 (that is `SpaceView3D.clip_start`, a different camera).
  it('the schema fills a missing near with 0.1', () => {
    expect(CameraDataParams.parse({ projection: 'Perspective', fov: 45 }).near).toBe(
      BLENDER_CLIP_START,
    );
  });

  it('the evaluated value falls back to 0.1 for a bag with no near', () => {
    const value = CameraDataNode.evaluate(
      { projection: 'Perspective', fov: 45 } as never,
      {} as never,
      {} as never,
    );
    expect((value as { near: number }).near).toBe(BLENDER_CLIP_START);
  });

  it('the default project’s camera is at 0.1', () => {
    const params = buildDefaultDagState().nodes.n_camera_data.params as { near: number };
    expect(params.near).toBe(BLENDER_CLIP_START);
  });

  it('control: a near the author wrote is kept', () => {
    expect(CameraDataParams.parse({ projection: 'Perspective', fov: 45, near: 0.01 }).near).toBe(
      0.01,
    );
  });
});
