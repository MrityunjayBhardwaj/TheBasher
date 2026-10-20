// A miniature of the launch plaza's graph, for the node view and its layout (#1675, #1563).
// Node types must be registered (`registerAllNodes`) for its references to be read.

import type { DagState } from '../core/dag/state';

// The plaza run in miniature: a camera aimed at the runner by a Track To and pushed in by keys,
// the runner (a group holding a meshed object and a chain of empty transforms), a ground tile, and a
// stand-in character left in the file with its only drawable hidden.
export function plazaState(): DagState {
  return {
    nodes: {
      render: {
        id: 'render',
        type: 'RenderOutput',
        params: {},
        inputs: { scene: { node: 'scene', socket: 'out' } },
      },
      scene: {
        id: 'scene',
        type: 'Scene',
        params: {},
        inputs: {
          camera: { node: 'cam', socket: 'out' },
          children: [
            { node: 'runner', socket: 'out' },
            { node: 'tile', socket: 'out' },
            { node: 'standIn', socket: 'out' },
          ],
        },
      },
      cam: {
        id: 'cam',
        type: 'Object',
        params: {},
        inputs: { data: { node: 'camData', socket: 'out' } },
      },
      camData: { id: 'camData', type: 'CameraData', params: {}, inputs: {} },
      camKeys: {
        id: 'camKeys',
        type: 'KeyframeChannelVec3',
        params: { target: 'cam', paramPath: 'position' },
        inputs: {},
      },
      track: {
        id: 'track',
        type: 'TrackTo',
        params: { target: 'cam', aimNode: 'body' },
        inputs: {},
      },
      runner: {
        id: 'runner',
        type: 'Group',
        params: {},
        inputs: {
          children: [
            { node: 'rig', socket: 'out' },
            { node: 'body', socket: 'out' },
          ],
        },
      },
      // An imported transform chain that holds no geometry, as glTF imports carry.
      rig: {
        id: 'rig',
        type: 'Group',
        params: {},
        inputs: { children: [{ node: 'empty', socket: 'out' }] },
      },
      empty: { id: 'empty', type: 'Group', params: {}, inputs: {} },
      body: {
        id: 'body',
        type: 'Object',
        params: {},
        inputs: { data: { node: 'bodyMesh', socket: 'out' } },
      },
      bodyMesh: { id: 'bodyMesh', type: 'PolyMeshData', params: {}, inputs: {} },
      tile: {
        id: 'tile',
        type: 'Object',
        params: {},
        inputs: { data: { node: 'tileMesh', socket: 'out' } },
      },
      tileMesh: { id: 'tileMesh', type: 'PolyMeshData', params: {}, inputs: {} },
      standIn: {
        id: 'standIn',
        type: 'Group',
        params: {},
        inputs: {
          children: [
            { node: 'standInEmpty', socket: 'out' },
            { node: 'standInBody', socket: 'out' },
          ],
        },
      },
      standInEmpty: { id: 'standInEmpty', type: 'Group', params: {}, inputs: {} },
      standInBody: {
        id: 'standInBody',
        type: 'Object',
        params: { viewport: false },
        inputs: { data: { node: 'standInMesh', socket: 'out' } },
      },
      standInMesh: { id: 'standInMesh', type: 'PolyMeshData', params: {}, inputs: {} },
      standInKeys: {
        id: 'standInKeys',
        type: 'KeyframeChannelVec3',
        params: { target: 'standIn', paramPath: 'position' },
        inputs: {},
      },
    },
    outputs: { scene: { node: 'scene', socket: 'out' }, render: { node: 'render', socket: 'out' } },
  } as unknown as DagState;
}
