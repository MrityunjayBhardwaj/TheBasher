// #1717 — the viewer's "3D render" is the beauty pass file a shot's workflow read for the frame.
import { beforeAll, describe, expect, it } from 'vitest';
import { applyOp, type DagState } from '../../core/dag';
import type { Op } from '../../core/dag/types';
import { buildDefaultDagState } from '../../core/project/default';
import { registerAllNodes } from '../../nodes/registerAll';
import { passFramePath } from '../../render/compileWorkflowFrame';
import { makeSplitCamera } from '../../test-utils/splitCamera';
import { buildSetActiveCameraOps } from '../setActiveCamera';
import { shotsOf } from '../shots';
import { buildNewCompositionOps } from './newComposition';
import { makeShotClipsPlan, shotClipsOf } from './shotClips';
import { renderSourceAt } from './shotCompare';

beforeAll(() => registerAllNodes());

const apply = (s: DagState, ops: readonly Op[]) =>
  ops.reduce((acc, op) => applyOp(acc, op).next, s);

function twoShots(): DagState {
  let s = buildDefaultDagState();
  s = apply(s, [{ type: 'setParam', nodeId: 'n_scene', paramPath: 'frameEnd', value: 120 }]);
  s = makeSplitCamera(s, { objectId: 'cam2', position: [20, 0, 0] }).state;
  for (const id of ['cam2', 'n_camera']) s = apply(s, buildSetActiveCameraOps(s, id) ?? []);
  s = apply(s, [
    {
      type: 'addNode',
      nodeId: 'cuts',
      nodeType: 'KeyframeChannelText',
      params: {
        name: 'active',
        target: shotsOf(s, 2).selectId!,
        paramPath: 'active',
        keyframes: [
          { time: 0, value: 'n_camera', easing: 'constant' },
          { time: 1, value: 'cam2', easing: 'constant' },
        ],
      },
    },
    ...buildNewCompositionOps('comp', 'Film'),
  ]);
  return apply(s, makeShotClipsPlan(s, 'comp').ops);
}

describe('#1717 — the 3D render a shot clip came from', () => {
  it("at a frame of shot 2, it is shot 2's beauty pass file for that frame", () => {
    const s = twoShots();
    const clip = shotClipsOf(s, 'comp')[1];
    const outputPath = (s.nodes[clip.workflowId!].params as { outputPath: string }).outputPath;
    expect(renderSourceAt(s, 'comp', 45)).toMatchObject({
      path: passFramePath(outputPath, 'beauty', 45),
      layerId: clip.layerId,
      filmFrame: 45,
    });
  });

  it('past the last shot there is none', () => {
    expect(renderSourceAt(twoShots(), 'comp', 60 + 60)).toBeNull();
  });
});
