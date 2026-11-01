// #1595 — the shots are read off the keys on the active camera, and each row names the camera the
// resolver puts on screen at the shot's start.
import { beforeAll, describe, expect, it } from 'vitest';
import { buildDefaultDagState } from '../core/project/default';
import { applyOp, type DagState } from '../core/dag';
import { registerAllNodes } from '../nodes/registerAll';
import { makeSplitCamera } from '../test-utils/splitCamera';
import { buildSetActiveCameraOps } from './setActiveCamera';
import { selectActiveCameraNode } from './activeCamera';
import { shotsOf } from './shots';

beforeAll(() => registerAllNodes());

/** The default scene plus two cameras, every one made active once so all three are listed. */
function threeCameras(): { state: DagState; order: string[]; select: string } {
  let s = buildDefaultDagState();
  s = makeSplitCamera(s, { objectId: 'cam2', position: [20, 0, 0] }).state;
  s = makeSplitCamera(s, { objectId: 'cam3', position: [40, 0, 0] }).state;
  for (const id of ['cam3', 'cam2', 'n_camera']) {
    for (const op of buildSetActiveCameraOps(s, id) ?? []) s = applyOp(s, op).next;
  }
  const view = shotsOf(s, 10);
  return { state: s, order: [...view.cameraIds], select: view.selectId! };
}

/** The cut channel (#1668): a text channel on `active`, each key naming its camera. */
function keyed(state: DagState, select: string, keys: [number, string][]): DagState {
  return applyOp(state, {
    type: 'addNode',
    nodeId: 'cuts',
    nodeType: 'KeyframeChannelText',
    params: {
      name: 'active',
      target: select,
      paramPath: 'active',
      keyframes: keys.map(([time, value]) => ({ time, value, easing: 'constant' })),
    },
  }).next;
}

const rows = (s: DagState, end = 10) =>
  shotsOf(s, end).shots.map((x) => [x.start, x.end, x.cameraId, x.keyTime]);

describe('#1595 — shots from the camera cuts', () => {
  it('one camera wired directly is one shot over the whole film', () => {
    const view = shotsOf(buildDefaultDagState(), 10);
    expect(view.selectId).toBeNull();
    expect(view.shots.map((x) => [x.start, x.end, x.cameraId])).toEqual([[0, 10, 'n_camera']]);
  });

  it('several cameras and no keys: one shot, on the camera that is active', () => {
    const { state, order } = threeCameras();
    expect(order).toHaveLength(3);
    expect(rows(state)).toEqual([[0, 10, 'n_camera', null]]);
  });

  it('keys at 0 and 2 make two shots, each on the camera its key picks', () => {
    const { state, select } = threeCameras();
    const s = keyed(state, select, [
      [0, 'n_camera'],
      [2, 'cam3'],
    ]);
    expect(rows(s)).toEqual([
      [0, 2, 'n_camera', 0],
      [2, 10, 'cam3', 2],
    ]);
  });

  it('before the first key its camera holds, so a first key after 0 is not a cut', () => {
    const { state, select } = threeCameras();
    const s = keyed(state, select, [
      [1, 'cam2'],
      [3, 'cam3'],
    ]);
    expect(rows(s)).toEqual([
      [0, 3, 'cam2', null],
      [3, 10, 'cam3', 3],
    ]);
  });

  it('a key at or past the end of the film starts no shot', () => {
    const { state, select } = threeCameras();
    const s = keyed(state, select, [
      [0, 'n_camera'],
      [4, 'cam2'],
      [12, 'cam3'],
    ]);
    expect(rows(s, 10)).toEqual([
      [0, 4, 'n_camera', 0],
      [4, 10, 'cam2', 4],
    ]);
  });

  it('#1668 — a key whose camera is no longer in the switch starts no shot; the shot before runs on', () => {
    const { state, select } = threeCameras();
    let s = keyed(state, select, [
      [0, 'n_camera'],
      [2, 'cam2'],
      [4, 'cam3'],
    ]);
    s = applyOp(s, {
      type: 'disconnect',
      from: { node: 'cam2', socket: 'out' },
      to: { node: select, socket: 'cameras' },
    }).next;
    expect(rows(s)).toEqual([
      [0, 4, 'n_camera', 0],
      [4, 10, 'cam3', 4],
    ]);
  });
});

// #1747 — the cuts obey the rules every channel does (`overlayCutChannel`): muted, silenced by a
// soloed sibling, or weighted under the text snap, the channel leaves the switch's own camera on
// screen. The rows follow the resolver: no cut that does not cut, one shot on what plays.
describe('#1747 — a cuts channel with no say makes no shots', () => {
  const cut = (): { s: DagState; select: string } => {
    const { state, select } = threeCameras();
    return {
      select,
      s: keyed(state, select, [
        [0, 'cam2'],
        [2, 'cam3'],
        [5, 'cam2'],
      ]),
    };
  };
  const set = (s: DagState, paramPath: string, value: unknown) =>
    applyOp(s, { type: 'setParam', nodeId: 'cuts', paramPath, value }).next;

  it('heard (control): three shots, and nothing silenced', () => {
    const { s } = cut();
    expect(rows(s).map((r) => r[2])).toEqual(['cam2', 'cam3', 'cam2']);
    expect(shotsOf(s, 10).cutsSilenced).toBe(false);
  });

  it('muted: one shot over the film, on the camera the resolver plays', () => {
    const s = set(cut().s, 'mute', true);
    expect(rows(s)).toEqual([[0, 10, 'n_camera', null]]);
    expect(shotsOf(s, 10).cutsSilenced).toBe(true);
  });

  it('weight under the text snap: one shot; at or over it: the cuts', () => {
    expect(rows(set(cut().s, 'weight', 0.4))).toEqual([[0, 10, 'n_camera', null]]);
    expect(rows(set(cut().s, 'weight', 0.6)).map((r) => r[2])).toEqual(['cam2', 'cam3', 'cam2']);
  });

  it('a soloed sibling on the switch silences the cuts, as it does on screen', () => {
    const { s: s0, select } = cut();
    // The switch has one param, so a sibling the solo rule hears is a second, keyed channel on it.
    const s = applyOp(s0, {
      type: 'addNode',
      nodeId: 'other',
      nodeType: 'KeyframeChannelText',
      params: {
        name: 'active',
        target: select,
        paramPath: 'active',
        solo: true,
        keyframes: [{ time: 0, value: 'n_camera', easing: 'constant' }],
      },
    }).next;
    expect(selectActiveCameraNode(s, 3)?.id, 'what plays').toBe('n_camera');
    expect(rows(s)).toEqual([[0, 10, 'n_camera', null]]);
    expect(shotsOf(s, 10).cutsSilenced).toBe(true);
  });

  it('no keys is not silenced: there is nothing to cut', () => {
    expect(shotsOf(threeCameras().state, 10).cutsSilenced).toBe(false);
  });
});

// #1754 — every channel on the switch's `active` is folded by the rules every channel follows,
// not just the first: a soloed second channel silences the cuts AND plays its own camera.
describe('#1754 — a second channel on the switch plays its own camera', () => {
  const two = (second: Record<string, unknown>, keys: [number, string][]): DagState => {
    const { state, select } = threeCameras();
    const s = keyed(state, select, [
      [0, 'n_camera'],
      [2, 'cam2'],
    ]);
    return applyOp(s, {
      type: 'addNode',
      nodeId: 'second',
      nodeType: 'KeyframeChannelText',
      params: {
        name: 'active',
        target: select,
        paramPath: 'active',
        ...second,
        keyframes: keys.map(([time, value]) => ({ time, value, easing: 'constant' })),
      },
    }).next;
  };
  const plays = (s: DagState) => [1, 3].map((t) => selectActiveCameraNode(s, t)?.id);

  it('soloed: the cuts fall silent and the soloed channel’s camera plays throughout', () => {
    const s = two({ solo: true }, [[0, 'cam3']]);
    expect(plays(s)).toEqual(['cam3', 'cam3']);
    expect(rows(s)).toEqual([[0, 10, 'cam3', null]]);
    expect(shotsOf(s, 10).cutsSilenced).toBe(true);
  });

  it('soloed, but naming no listed camera: nothing to play, so the switch’s own camera', () => {
    const s = two({ solo: true }, [[0, 'gone']]);
    expect(plays(s)).toEqual(['n_camera', 'n_camera']);
  });

  it('not soloed: both are heard, and the later channel overrides where it has a key', () => {
    const s = two({}, [[2.5, 'cam3']]);
    // Before its first key a channel's left-most key holds, so the second channel wins throughout.
    expect(plays(s)).toEqual(['cam3', 'cam3']);
    const muted = two({ mute: true }, [[2.5, 'cam3']]);
    expect(plays(muted), 'muted second: the cuts alone').toEqual(['n_camera', 'cam2']);
  });
});
