// #265 ([[V45]] #2, I4/C7) — a Track-To constraint drives EVERY aimable light
// kind, not just AreaLight. Boundary-pair: the REAL rendered light's world aim
// DIRECTION (side A, __basher_light_world_aims — the shader's normalize(target −
// position)) == the intended aim normalize(aimPoint − position), for a top-level
// SpotLight AND DirectionalLight. Falsify: mute the Track-To → the light reverts
// to its AUTHORED aim (the constraint provably owns the direction while active).
//
// Lights render FLAT (no name to address by id), so the seam reports every aimable
// light's world position + direction; each light is matched by its position.

import { expect, test } from './_fixtures';

interface BasherWindow {
  __basher_dag?: { getState: () => { dispatch: (op: unknown) => void } };
  __basher_time?: { getState: () => { pause: () => void; setTime: (s: number) => void } };
  __basher_light_world_aims?: () => { position: number[]; direction: number[] }[];
}

type V3 = [number, number, number];

function norm(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** Find the aim of the light whose reported world position ≈ `pos`. */
function aimAt(aims: { position: number[]; direction: number[] }[], pos: V3): V3 | null {
  const hit = aims.find(
    (a) =>
      Math.abs(a.position[0] - pos[0]) < 1e-2 &&
      Math.abs(a.position[1] - pos[1]) < 1e-2 &&
      Math.abs(a.position[2] - pos[2]) < 1e-2,
  );
  return hit ? (hit.direction as V3) : null;
}

const SPOT_POS: V3 = [5, 5, 0];
const SPOT_AIM: V3 = [0, 0, 0]; // Track-To aim point (world origin)
const SUN_POS: V3 = [0, 8, 0];
const SUN_AIM: V3 = [4, 0, 0];

async function seed(page: import('@playwright/test').Page) {
  await page.waitForFunction(() => {
    const w = window as unknown as BasherWindow;
    return Boolean(w.__basher_dag && w.__basher_time && w.__basher_light_world_aims);
  });
  await page.evaluate(
    ({ spotPos, spotAim, sunPos, sunAim }) => {
      const w = window as unknown as BasherWindow;
      const d = (op: unknown) => w.__basher_dag!.getState().dispatch(op);
      w.__basher_time!.getState().pause();
      w.__basher_time!.getState().setTime(0);
      // SpotLight authored to aim -Z (target = pos + (0,0,-1)), so an ignored
      // constraint would read [0,0,-1] — DISTINCT from the aim toward the origin.
      d({
        type: 'addNode',
        nodeId: 'n265_spot',
        nodeType: 'SpotLight',
        params: { position: spotPos, target: [spotPos[0], spotPos[1], spotPos[2] - 1] },
      });
      d({
        type: 'connect',
        from: { node: 'n265_spot', socket: 'out' },
        to: { node: 'n_scene', socket: 'lights' },
      });
      d({
        type: 'addNode',
        nodeId: 'n265_spot_tt',
        nodeType: 'TrackTo',
        params: {
          name: 'spot-tt',
          target: 'n265_spot',
          aimNode: '',
          aimPoint: spotAim,
          up: [0, 1, 0],
          mute: false,
        },
      });
      // DirectionalLight (rotation 0 → authored aim is toward the origin). Track-To
      // aims it at [4,0,0], a DISTINCT direction from "toward origin".
      d({
        type: 'addNode',
        nodeId: 'n265_sun',
        nodeType: 'DirectionalLight',
        params: { position: sunPos, intensity: 1 },
      });
      d({
        type: 'connect',
        from: { node: 'n265_sun', socket: 'out' },
        to: { node: 'n_scene', socket: 'lights' },
      });
      d({
        type: 'addNode',
        nodeId: 'n265_sun_tt',
        nodeType: 'TrackTo',
        params: {
          name: 'sun-tt',
          target: 'n265_sun',
          aimNode: '',
          aimPoint: sunAim,
          up: [0, 1, 0],
          mute: false,
        },
      });
    },
    { spotPos: SPOT_POS, spotAim: SPOT_AIM, sunPos: SUN_POS, sunAim: SUN_AIM },
  );
  // Let the per-frame useLightTargetAim settle.
  await page.waitForTimeout(300);
}

test.describe('#265 aimable-light Track-To (H40 boundary-pair)', () => {
  test('SpotLight + DirectionalLight aim at the Track-To target; mute reverts', async ({
    page,
  }) => {
    await page.goto('/');
    await seed(page);

    const aims = await page.evaluate(() =>
      (window as unknown as BasherWindow).__basher_light_world_aims!(),
    );

    const spotDir = aimAt(aims, SPOT_POS);
    const sunDir = aimAt(aims, SUN_POS);
    expect(spotDir, 'spot light present').not.toBeNull();
    expect(sunDir, 'sun light present').not.toBeNull();

    const wantSpot = norm([
      SPOT_AIM[0] - SPOT_POS[0],
      SPOT_AIM[1] - SPOT_POS[1],
      SPOT_AIM[2] - SPOT_POS[2],
    ]);
    const wantSun = norm([
      SUN_AIM[0] - SUN_POS[0],
      SUN_AIM[1] - SUN_POS[1],
      SUN_AIM[2] - SUN_POS[2],
    ]);
    // Rendered aim == intended aim, all three axes.
    for (let i = 0; i < 3; i++) expect(spotDir![i]).toBeCloseTo(wantSpot[i], 2);
    for (let i = 0; i < 3; i++) expect(sunDir![i]).toBeCloseTo(wantSun[i], 2);
    // Guard against the pre-fix value: the spot was aiming -Z (authored).
    expect(Math.abs(spotDir![2] - -1)).toBeGreaterThan(0.1);

    // Falsify: mute the spot's Track-To → it reverts to the AUTHORED -Z aim.
    await page.evaluate(() => {
      const w = window as unknown as BasherWindow;
      w.__basher_dag!.getState().dispatch({
        type: 'setParam',
        nodeId: 'n265_spot_tt',
        paramPath: 'mute',
        value: true,
      });
    });
    await page.waitForTimeout(300);
    const aims2 = await page.evaluate(() =>
      (window as unknown as BasherWindow).__basher_light_world_aims!(),
    );
    const spotDir2 = aimAt(aims2, SPOT_POS);
    expect(spotDir2, 'spot still present').not.toBeNull();
    // Authored target was pos + (0,0,-1) → direction [0,0,-1].
    expect(spotDir2![0]).toBeCloseTo(0, 2);
    expect(spotDir2![1]).toBeCloseTo(0, 2);
    expect(spotDir2![2]).toBeCloseTo(-1, 2);
  });
});
