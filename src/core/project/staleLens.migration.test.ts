// #1856 — a lens saved past v26 without the v26 strip loses `lookAt`, `roll` and `zoom` on load.
//
// The bundled "Camera Path + AI Walk" example was saved at v26 before the v26 step learned to strip
// those three fields, and boot seeds a stored copy of it once and never over it. So the case that
// matters is a stored copy: read through the real loader, its camera must be one the duplicate door
// accepts, and nothing the camera shows may change.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDuplicateNodesOps } from '../../app/sceneNodeActions';
import { registerAllNodes } from '../../nodes/registerAll';
import { applyOps, __resetRegistryForTests, type DagState } from '../dag';
import { MemoryStorage } from '../storage/MemoryStorage';
import { buildExampleProject } from './examples';
import { loadProject, projectPath } from './io';
import { CAMERA_LENS_STRIP_FORMAT, migrateStaleLensFields } from './migrations';
import { PROJECT_FORMAT_VERSION } from './schema';

type RawNode = { id: string; type: string; params: Record<string, unknown>; inputs?: object };
type RawProject = { formatVersion: number; id: string; state: { nodes: Record<string, RawNode> } };

/** The example as boot stored it before #1851: the project boot builds and saves, at v29, its
 *  lens still holding the three fields. */
async function storedCopy(): Promise<RawProject> {
  const p = JSON.parse(
    JSON.stringify(await buildExampleProject('example_camera_path_ai_walk')),
  ) as RawProject;
  p.formatVersion = 29;
  Object.assign(p.state.nodes.n_camera_data.params, { zoom: 50, lookAt: [0, 0.4, 0], roll: 0 });
  return p;
}

const lensNode = (params: Record<string, unknown>): RawNode => ({
  id: 'cam_d',
  type: 'CameraData',
  params: { projection: 'Perspective', fov: 45, near: 0.1, far: 1000, ...params },
  inputs: {},
});
const camObject = (position: number[]): RawNode => ({
  id: 'cam',
  type: 'Object',
  params: { position, rotation: [0, 0, 0], scale: [1, 1, 1] },
  inputs: { data: { node: 'cam_d', socket: 'out' } },
});
const raw = (nodes: RawNode[]) => ({
  formatVersion: CAMERA_LENS_STRIP_FORMAT - 1,
  state: { nodes: Object.fromEntries(nodes.map((n) => [n.id, n])) },
});
const nodesOf = (p: unknown) => (p as RawProject).state.nodes;

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('v29 → v30: a lens loses the fields the v26 step learned to strip (#1856)', () => {
  it('the step is the last one, so a stored copy reaches it', () => {
    expect(PROJECT_FORMAT_VERSION).toBeGreaterThanOrEqual(CAMERA_LENS_STRIP_FORMAT);
  });

  it('a stored copy of the example loads with a camera the duplicate door accepts, aimed as it was', async () => {
    const storage = new MemoryStorage();
    const copy = await storedCopy();
    await storage.write(projectPath(copy.id), new TextEncoder().encode(JSON.stringify(copy)));
    const project = await loadProject(storage, copy.id);
    const nodes = project.state.nodes;

    expect(
      Object.keys(nodes.n_camera_data.params as object).filter((k) =>
        ['zoom', 'lookAt', 'roll'].includes(k),
      ),
    ).toEqual([]);
    // The aim it had is the Track-To the v26 step made, untouched.
    expect(nodes.n_camera_aim.params).toMatchObject({
      target: 'n_camera',
      aimPoint: [0, 0.4, 0],
      aimSpace: 'parent',
      roll: 0,
    });

    // What Shift+D does: build the copy's ops and apply them. On the stored copy as it was, this
    // throws "addNode: CameraData has no field at zoom".
    const state = project.state as unknown as DagState;
    const dup = buildDuplicateNodesOps(state, ['n_camera']);
    expect(dup).not.toBeNull();
    const next = applyOps(state, dup!.ops).next;
    const copyId = dup!.newRootIds[0];
    expect(next.nodes[copyId]?.type).toBe('Object');
    // Every node the copy added: its lens and its whole constraint chain came across.
    const added = Object.keys(next.nodes).filter((id) => !(id in state.nodes));
    expect(added.map((id) => next.nodes[id].type).sort()).toEqual(
      [
        'CameraData',
        'FollowPath',
        'KeyframeChannelNumber',
        'Object',
        'OwnWorld',
        'TrackTo',
        'TrackTo',
      ].sort(),
    );
  });

  it('the stored copy before this step is what the duplicate door refuses (the case is real)', async () => {
    // Stop the ladder at v29: the lens still holds the fields and a copy of the camera throws.
    const copy = await storedCopy();
    const state = copy.state as unknown as DagState;
    const dup = buildDuplicateNodesOps(state, ['n_camera']);
    expect(() => applyOps(state, dup!.ops)).toThrow(/CameraData has no field at zoom/);
  });

  it('a perspective lens loses the three fields and keeps everything else', () => {
    const out = nodesOf(
      migrateStaleLensFields(
        raw([
          lensNode({ zoom: 50, lookAt: [1, 2, 3], roll: 0.5, focusDistance: 7 }),
          camObject([0, 0, 5]),
        ]),
      ),
    );
    expect(out.cam_d.params).toEqual({
      projection: 'Perspective',
      fov: 45,
      near: 0.1,
      far: 1000,
      focusDistance: 7,
    });
    expect(out.cam.params.position).toEqual([0, 0, 5]);
  });

  it('an orthographic lens with no ortho scale keeps the frame it was drawn with', () => {
    // Before its own ortho scale, an orthographic camera was framed 2·tan(fov/2)·|lookAt − position|.
    const out = nodesOf(
      migrateStaleLensFields(
        raw([
          lensNode({ projection: 'Orthographic', fov: 90, zoom: 50, lookAt: [0, 0, 0] }),
          camObject([0, 0, 5]),
        ]),
      ),
    );
    expect(out.cam_d.params.orthoScale).toBeCloseTo(10, 9);
    expect('lookAt' in out.cam_d.params).toBe(false);
  });

  it('an orthographic lens that already has an ortho scale keeps it', () => {
    const out = nodesOf(
      migrateStaleLensFields(
        raw([
          lensNode({ projection: 'Orthographic', orthoScale: 3, zoom: 50, lookAt: [0, 0, 0] }),
          camObject([0, 0, 5]),
        ]),
      ),
    );
    expect(out.cam_d.params.orthoScale).toBe(3);
  });

  it('keys and drivers on zoom go (they drove nothing); keys on other lens fields stay', () => {
    const key = (id: string, paramPath: string, target = 'cam_d'): RawNode => ({
      id,
      type: 'KeyframeChannelNumber',
      params: { target, paramPath, keys: [] },
      inputs: {},
    });
    const out = nodesOf(
      migrateStaleLensFields(
        raw([
          lensNode({ zoom: 50 }),
          camObject([0, 0, 5]),
          key('k_zoom', 'zoom'),
          key('k_zoom_obj', 'zoom', 'cam'),
          key('k_fov', 'fov'),
          {
            id: 'd_zoom',
            type: 'ParamDriver',
            params: { target: 'cam_d', paramPath: 'zoom' },
            inputs: {},
          },
        ]),
      ),
    );
    expect(Object.keys(out).sort()).toEqual(['cam', 'cam_d', 'k_fov']);
  });

  it('a file with clean lenses comes through unchanged but for its version, and says nothing', () => {
    const before = raw([lensNode({ focusDistance: 5 }), camObject([0, 0, 5])]);
    const after = migrateStaleLensFields(before) as RawProject;
    expect(after.formatVersion).toBe(CAMERA_LENS_STRIP_FORMAT);
    expect(after.state.nodes).toEqual(before.state.nodes);
    expect(console.warn).not.toHaveBeenCalled();
  });
});
