// #352 — the agent's constraint proposal must be VISIBLE in the ghost preview.
//
// THE DEFECT THIS PINS: the diff ghost evaluates the fork PURELY — it mirrors
// SceneFromDAG's TOP-LEVEL evaluate but never its `ConstrainedR` wrapper, where the pose
// band actually lives. So proposing "make the cube follow the path" ghosted the cube at
// its AUTHORED position: the director was asked to accept a change the preview did not
// show. That is #324's defect one level up — a proposal you cannot SEE you cannot judge,
// and the V13 accept gate degrades to a coin flip on a sentence.
//
// The ghost is [[H170]]'s FIFTH pose road. [[V104]] decides it with no new thinking: the
// ghost READS nothing and DISPLAYS a result ⇒ it applies the band on top, while the band's
// inputs (the curve's world) keep reading the fork's PURE walk.
//
// WHY AN E2E AND NOT A UNIT TEST: the band composes the point through a MATRIX; the ghost
// is posed by a three.js <group> the renderer mounts. Two compositions over one TRS — the
// same boundary pair #321/#322/#339 ship an e2e for. A unit test with an injected value
// agrees with itself either way. So this walks the LIVE scene graph and reads the
// `matrixWorld` the renderer actually composed.
//
// FALSIFIABILITY PROBE (run before trusting this file): drop the `applyGhostPoseBand` call
// in DiffOverlay.tsx ⇒ the follower case goes red at ~9.7 units while the STATIC CONTROL
// stays green. The control is what proves the band is conditional rather than "the ghost
// is always somewhere else".
//
// THE DISCRIMINATOR IS THE POINT ([[H171]], learned on this exact bug): this file filters
// by the ghost's OWN signature — wireframe at opacity 0.35, DiffOverlay's styling — and
// NEVER by `userData.editorChrome`. That flag is carried by the grid, the light helpers,
// the camera helper AND the curve's control-point dots; a dot sits ON the path by
// construction, so an editorChrome probe reports "the ghost is on the path!" while the
// ghost sits at the origin. It already produced one false "it works" during planning.
//
// REF: #352; V104 (band applies ON TOP), H170 (the five roads), H171 (the discriminator),
// H165 (#327 — why the real button matters), THESIS.md §19 (diff-first).

import { expect, test, type Page } from './_fixtures';

const FOLLOWER_SIZE = 0.37; // unique in the scene → picks this subject's ghost, only it
const CONTROL_SIZE = 0.53; // the static control: proposed-alongside, constrained by nothing
const AIMER_SIZE = 0.41; // the Track-To subject — the ROTATION band's own signature
const EVAL_TIME = 0.5; // a fraction of WORLD ARC LENGTH (not a spline t) — V100

interface CurveSample {
  point: [number, number, number];
}
interface GhostWin {
  __basher_dag: {
    getState(): {
      state: unknown;
      dispatchAtomic: (ops: unknown[], src: string, d: string) => void;
    };
  };
  __basher_diff: {
    getState(): {
      propose: (state: unknown, ops: unknown[], description: string, opSources?: string[]) => void;
    };
  };
  __basher_curve_sample: (nodeId: string, u: number) => CurveSample | null;
  __basher_mesh_world_position: (nodeId: string) => [number, number, number] | null;
  __basher_three: { getState(): { scene: unknown } };
  __basher_selection: unknown;
}

async function boot(page: Page) {
  await page.goto('/');
  const layout = page.getByTestId('layout');
  const starter = page.getByRole('button', { name: /Open example Starter Scene/i });
  await Promise.race([
    layout.waitFor({ timeout: 15_000 }).catch(() => undefined),
    starter.waitFor({ timeout: 15_000 }).catch(() => undefined),
  ]);
  if (await starter.isVisible().catch(() => false)) await starter.click();
  await expect(layout).toBeVisible({ timeout: 10_000 });
  await page.waitForSelector('canvas');
  await page.waitForFunction(() => Boolean((window as unknown as GhostWin).__basher_selection));
  await page.waitForFunction(() => Boolean((window as unknown as GhostWin).__basher_diff));
}

/** The COMMITTED scene: a posed curve (offset + rotated + NON-UNIFORMLY scaled, so local
 *  arc length stops tracking world arc length — the case where the two compositions have
 *  something to disagree about) plus two boxes at the origin, neither constrained yet. */
async function seedScene(page: Page) {
  await page.evaluate(
    ({ followerSize, controlSize }) => {
      const dag = (window as unknown as GhostWin).__basher_dag.getState();
      dag.dispatchAtomic(
        [
          {
            type: 'addNode',
            nodeId: 'n_p352_path',
            nodeType: 'Curve',
            params: {
              points: [
                [0, 0, 0],
                [10, 0, 0],
                [11, 0, 0],
                [12, 0, 0],
              ],
              closed: false,
              resolution: 32,
              position: [1, 2, -3],
              rotation: [0, 35, 0],
              scale: [2, 1, 0.5],
            },
          },
          {
            type: 'connect',
            from: { node: 'n_p352_path', socket: 'out' },
            to: { node: 'n_scene', socket: 'children' },
          },
          {
            type: 'addNode',
            nodeId: 'n_p352_box',
            nodeType: 'BoxMesh',
            params: {
              name: 'Follower',
              position: [0, 0, 0],
              size: [followerSize, followerSize, followerSize],
            },
          },
          {
            type: 'connect',
            from: { node: 'n_p352_box', socket: 'out' },
            to: { node: 'n_scene', socket: 'children' },
          },
          {
            type: 'addNode',
            nodeId: 'n_p352_static',
            nodeType: 'BoxMesh',
            params: {
              name: 'Control',
              position: [0, 0, 0],
              size: [controlSize, controlSize, controlSize],
            },
          },
          {
            type: 'connect',
            from: { node: 'n_p352_static', socket: 'out' },
            to: { node: 'n_scene', socket: 'children' },
          },
        ],
        'user',
        'p352 seed',
      );
    },
    { followerSize: FOLLOWER_SIZE, controlSize: CONTROL_SIZE },
  );
  await page.waitForTimeout(300);
}

/** Stage the proposal the agent will make once `mutator.constrain` exists (#353): bind a
 *  Follow-Path onto the follower. NOT committed — this is exactly what the director is
 *  being asked to judge, and the whole question is whether they can SEE it. */
async function proposeFollowPath(page: Page) {
  await page.evaluate((evalTime) => {
    const w = window as unknown as GhostWin;
    const ops = [
      {
        type: 'addNode',
        nodeId: 'p352_follow',
        nodeType: 'FollowPath',
        params: {
          target: 'n_p352_box',
          curve: 'n_p352_path',
          evalTime,
          offset: 0,
          order: 0,
          mute: false,
        },
      },
    ];
    w.__basher_diff
      .getState()
      .propose(w.__basher_dag.getState().state, ops, 'make the cube follow the path', [
        'agent:mutator.constrain',
      ]);
  }, EVAL_TIME);
  await expect(page.getByTestId('diffbar')).toBeVisible();
  await page.waitForTimeout(200);
}

/**
 * Every GHOST mesh of a given box size, as the world position the RENDERER composed.
 *
 * The discriminator ([[H171]]): ghost STYLING (wireframe at opacity 0.35 — DiffOverlay's
 * own convention) AND this subject's unique box size. Both halves are needed: styling
 * separates ghost from the real object, size separates this subject from the other ghosts
 * (the ghost draws the WHOLE fork scene, so the control and the starter cube ghost too).
 * Returns the LIST, not a verdict — the caller asserts the population is exactly 1, which
 * is what proves the filter names a subject rather than a neighbourhood.
 */
async function ghostWorldPositions(page: Page, size: number): Promise<[number, number, number][]> {
  return page.evaluate((size) => {
    const scene = (window as unknown as GhostWin).__basher_three.getState().scene as {
      traverse: (cb: (o: unknown) => void) => void;
    };
    const hits: [number, number, number][] = [];
    scene.traverse((o: unknown) => {
      const obj = o as {
        material?: { opacity?: number; wireframe?: boolean };
        geometry?: { parameters?: { width?: number } };
        updateWorldMatrix?: (p: boolean, c: boolean) => void;
        matrixWorld?: { elements: number[] };
      };
      const m = obj.material;
      const g = obj.geometry;
      if (!m || !g) return;
      if (m.opacity !== 0.35 || m.wireframe !== true) return;
      if (g.parameters?.width !== size) return;
      obj.updateWorldMatrix?.(true, false);
      const e = obj.matrixWorld?.elements;
      if (!e) return;
      hits.push([e[12], e[13], e[14]]);
    });
    return hits;
  }, size);
}

function dist(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Every GHOST mesh of a given box size, as the euler rotation (DEGREES) the renderer
 *  composed. Same discriminator as `ghostWorldPositions`. */
async function ghostRotationsDeg(page: Page, size: number): Promise<[number, number, number][]> {
  return page.evaluate((size) => {
    const scene = (window as unknown as GhostWin).__basher_three.getState().scene as {
      traverse: (cb: (o: unknown) => void) => void;
    };
    const hits: [number, number, number][] = [];
    scene.traverse((o: unknown) => {
      const obj = o as {
        material?: { opacity?: number; wireframe?: boolean };
        geometry?: { parameters?: { width?: number } };
        rotation?: { x: number; y: number; z: number };
      };
      if (!obj.material || !obj.geometry || !obj.rotation) return;
      if (obj.material.opacity !== 0.35 || obj.material.wireframe !== true) return;
      if (obj.geometry.parameters?.width !== size) return;
      hits.push([
        (obj.rotation.x * 180) / Math.PI,
        (obj.rotation.y * 180) / Math.PI,
        (obj.rotation.z * 180) / Math.PI,
      ]);
    });
    return hits;
  }, size);
}

/** A cube at the origin plus an aim target off to one side, then propose "point the cube
 *  at the target". The ROTATION band's analogue of the Follow-Path seed. */
async function seedAimSceneAndPropose(page: Page) {
  await page.evaluate(
    ({ aimerSize, controlSize }) => {
      const dag = (window as unknown as GhostWin).__basher_dag.getState();
      dag.dispatchAtomic(
        [
          {
            type: 'addNode',
            nodeId: 'n_p352_aimer',
            nodeType: 'BoxMesh',
            params: { name: 'Aimer', position: [0, 0, 0], size: [aimerSize, aimerSize, aimerSize] },
          },
          {
            type: 'connect',
            from: { node: 'n_p352_aimer', socket: 'out' },
            to: { node: 'n_scene', socket: 'children' },
          },
          {
            type: 'addNode',
            nodeId: 'n_p352_aimctl',
            nodeType: 'BoxMesh',
            params: {
              name: 'AimControl',
              position: [0, 0, 0],
              size: [controlSize, controlSize, controlSize],
            },
          },
          {
            type: 'connect',
            from: { node: 'n_p352_aimctl', socket: 'out' },
            to: { node: 'n_scene', socket: 'children' },
          },
          {
            type: 'addNode',
            nodeId: 'n_p352_aimtarget',
            nodeType: 'Null',
            params: { name: 'Target', position: [6, 4, -5] },
          },
          {
            type: 'connect',
            from: { node: 'n_p352_aimtarget', socket: 'out' },
            to: { node: 'n_scene', socket: 'children' },
          },
        ],
        'user',
        'p352 aim seed',
      );
    },
    { aimerSize: AIMER_SIZE, controlSize: CONTROL_SIZE },
  );
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const w = window as unknown as GhostWin;
    w.__basher_diff.getState().propose(
      w.__basher_dag.getState().state,
      [
        {
          type: 'addNode',
          nodeId: 'p352_track',
          nodeType: 'TrackTo',
          params: { target: 'n_p352_aimer', aimNode: 'n_p352_aimtarget', order: 0, mute: false },
        },
      ],
      'point the cube at the target',
      ['agent:mutator.constrain'],
    );
  });
  await expect(page.getByTestId('diffbar')).toBeVisible();
  await page.waitForTimeout(200);
}

test('the ghost of a proposed follower lands ON THE PATH, not at its authored origin', async ({
  page,
}) => {
  await boot(page);
  await seedScene(page);
  await proposeFollowPath(page);

  // Where the SEAM says the path is at this evalTime — arc-length parameterized (V100),
  // resolved through the curve's real world pose.
  const expected = await page.evaluate(
    (u) => (window as unknown as GhostWin).__basher_curve_sample('n_p352_path', u),
    EVAL_TIME,
  );
  expect(expected, 'the curve seam resolves a sample').not.toBeNull();
  const onPath = expected!.point;

  const ghosts = await ghostWorldPositions(page, FOLLOWER_SIZE);
  // The discriminator names a SUBJECT, not a population. If this is ever > 1 the filter
  // has widened and every assertion below is about the wrong object (H171).
  expect(ghosts, 'exactly one ghost carries the follower signature').toHaveLength(1);

  // THE HEADLINE: the ghost is where the proposal PUTS the object — the renderer's own
  // composed matrixWorld, against the seam's independently-composed point.
  expect(dist(ghosts[0], onPath)).toBeLessThan(0.05);

  // And it genuinely MOVED: pre-fix this ghost sat at the authored origin, ~9.7 away.
  expect(dist(ghosts[0], [0, 0, 0])).toBeGreaterThan(1);
});

// THE ROTATION BAND. Found in self-review, by OBSERVING a proposed Track-To instead of
// trusting the position fix's symmetry: the first cut of this fix applied only the position
// band — the one the #352 observation happened to name, via Follow-Path — so "point the cube
// at the target — accept?" previewed an UNROTATED cube. That is this very bug surviving in
// the other band, a miss hiding behind a correct sibling ([[V104]]). A Track-To PLACES an
// object by orientation, and the road's job is to place it as the proposal would.
test('a proposed Track-To ROTATES the ghost — both bands, not just position', async ({ page }) => {
  await boot(page);
  await seedAimSceneAndPropose(page);

  const rots = await ghostRotationsDeg(page, AIMER_SIZE);
  expect(rots, 'exactly one ghost carries the aimer signature').toHaveLength(1);

  // Aimed from the origin at [6,4,-5] — a real 3-axis aim. Pre-fix this read [0,0,0]:
  // the ghost showed the proposal doing nothing at all.
  const magnitude = Math.hypot(...rots[0]);
  expect(magnitude, 'the ghost carries the derived aim, not the authored zero').toBeGreaterThan(5);

  // The control shares the proposal and the overlay but is named by no constraint.
  const ctl = await ghostRotationsDeg(page, CONTROL_SIZE);
  expect(ctl).toHaveLength(1);
  expect(Math.hypot(...ctl[0]), 'the unconstrained ghost stays unrotated').toBeLessThan(0.01);
});

test('the STATIC control ghosts at its authored origin — the band is conditional', async ({
  page,
}) => {
  await boot(page);
  await seedScene(page);
  await proposeFollowPath(page);

  // Same proposal, same ghost overlay, an object the Follow-Path does NOT name. If this
  // moved, the band would be applying to everything and the headline test would pass for
  // the wrong reason.
  const controls = await ghostWorldPositions(page, CONTROL_SIZE);
  expect(controls, 'exactly one ghost carries the control signature').toHaveLength(1);
  expect(dist(controls[0], [0, 0, 0])).toBeLessThan(0.05);
});

test('the REAL scene does not move while the ghost previews the change (diff-first)', async ({
  page,
}) => {
  await boot(page);
  await seedScene(page);
  await proposeFollowPath(page);

  // The proposal is UNCOMMITTED: the ghost shows the follower on the path while the real
  // object stays at its authored origin. That side-by-side IS what the director judges,
  // and it is the property the live-transient alternative would trade away.
  const real = await page.evaluate(() =>
    (window as unknown as GhostWin).__basher_mesh_world_position('n_p352_box'),
  );
  expect(real, 'the real follower is mounted').not.toBeNull();
  expect(dist(real!, [0, 0, 0])).toBeLessThan(0.05);

  const ghosts = await ghostWorldPositions(page, FOLLOWER_SIZE);
  expect(ghosts).toHaveLength(1);
  expect(dist(ghosts[0], real!), 'ghost and real are in DIFFERENT places').toBeGreaterThan(1);
});
