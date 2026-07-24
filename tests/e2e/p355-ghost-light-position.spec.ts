// #355 — a proposed light's ghost must mark it WHERE THE PROPOSAL PUTS IT, not the origin.
//
// THE DEFECT THIS PINS: GhostLight (DiffOverlay.tsx) drew its marker inside a bare
// <group> with no `position` prop, so every ghost light sat at the world origin whatever
// position the proposal gave it. "Add a key light up and to the left — accept?" previewed
// a marker at [0,0,0], neither where the light is nor a depiction of the change — the V13
// accept gate degrades to trusting the sentence (the same class as #352, one component over).
//
// WHY AN E2E AND NOT A UNIT TEST: the marker is posed by a three.js <group> the renderer
// mounts; the bug is precisely whether the light's position reaches that group. A unit test
// with an injected value agrees with itself either way. So this walks the LIVE scene graph
// and reads the `matrixWorld` the renderer actually composed — the same discipline as p352.
//
// THE DISCRIMINATOR ([[H171]]): filter by the ghost light's OWN signature — a NON-wireframe
// mesh at opacity 0.5 (DiffOverlay's ghost-light styling) — AND a unique proposed COLOUR,
// never `userData.editorChrome` (the grid, the real light helpers and the camera helper all
// carry that flag). The ghost draws the WHOLE fork scene, so the starter's own light ghosts
// too; the unique colour separates the PROPOSED light from it.
//
// FALSIFIABILITY PROBE (run before trusting this file): drop the `position={position}` prop
// on GhostLight's <group> ⇒ this goes red at the origin while a control light proposed at a
// DIFFERENT non-origin point also collapses to [0,0,0] — proving the prop carries the value,
// not that "the ghost is always somewhere".
//
// REF: #355; #352 / p352-diff-ghost-constraint-band.spec.ts (the census discipline); H171.

import { expect, test, type Page } from './_fixtures';
import { splitLightOps } from './_splitLight';

const PROPOSED = [3, 4, 5] as const; // where the proposal puts the key light (non-origin)
const CONTROL = [-4, 1, -6] as const; // a second proposed light, a DIFFERENT non-origin point
const KEY_COLOR = '#ff00ff'; // magenta — unique vs the starter's white light + the box hues
const CTL_COLOR = '#00ffff'; // cyan — the control light's own signature

interface GhostWin {
  __basher_dag: { getState(): { state: unknown } };
  __basher_diff: {
    getState(): {
      propose: (state: unknown, ops: unknown[], description: string, opSources?: string[]) => void;
    };
  };
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

/** Propose adding two point lights at distinct non-origin positions, each a unique colour.
 *  NOT committed — this is exactly the proposal the director is asked to judge. */
async function proposeLights(page: Page) {
  // #386 C3: a proposed point light is a split pair — the Object carries `position` (what
  // the ghost must honour) and the LightData carries the colour the ghost tints itself by.
  const keyOps = splitLightOps({
    objectId: 'p355_key',
    lightKind: 'Point',
    position: PROPOSED,
    shading: { intensity: 1, color: KEY_COLOR, distance: 0, decay: 2 },
  });
  const ctlOps = splitLightOps({
    objectId: 'p355_ctl',
    lightKind: 'Point',
    position: CONTROL,
    shading: { intensity: 1, color: CTL_COLOR, distance: 0, decay: 2 },
  });
  await page.evaluate(
    ({ keyOps, ctlOps }) => {
      const w = window as unknown as GhostWin;
      const ops = [
        ...keyOps,
        {
          type: 'connect',
          from: { node: 'p355_key', socket: 'out' },
          to: { node: 'n_scene', socket: 'lights' },
        },
        ...ctlOps,
        {
          type: 'connect',
          from: { node: 'p355_ctl', socket: 'out' },
          to: { node: 'n_scene', socket: 'lights' },
        },
      ];
      w.__basher_diff
        .getState()
        .propose(w.__basher_dag.getState().state, ops, 'add two key lights', [
          'agent:mutator.addLight',
        ]);
    },
    { keyOps, ctlOps },
  );
  await expect(page.getByTestId('diffbar')).toBeVisible();
  await page.waitForTimeout(200);
}

/** Every GHOST-LIGHT mesh of a given colour, as the world position the RENDERER composed.
 *  Signature: a NON-wireframe mesh at opacity 0.5 (GhostLight's styling) whose material
 *  colour matches. The mesh sits at the group's local origin, so its matrixWorld translation
 *  IS the group's world position — i.e. where the proposal placed the light. */
async function ghostLightPositions(page: Page, hex: string): Promise<[number, number, number][]> {
  return page.evaluate((hex) => {
    const want = hex.replace('#', '').toLowerCase();
    const scene = (window as unknown as GhostWin).__basher_three.getState().scene as {
      traverse: (cb: (o: unknown) => void) => void;
    };
    const hits: [number, number, number][] = [];
    scene.traverse((o: unknown) => {
      const obj = o as {
        material?: {
          opacity?: number;
          wireframe?: boolean;
          color?: { getHexString?: () => string };
        };
        geometry?: { type?: string };
        updateWorldMatrix?: (p: boolean, c: boolean) => void;
        matrixWorld?: { elements: number[] };
      };
      const m = obj.material;
      if (!m || m.opacity !== 0.5 || m.wireframe === true) return;
      if (m.color?.getHexString?.() !== want) return;
      obj.updateWorldMatrix?.(true, false);
      const e = obj.matrixWorld?.elements;
      if (!e) return;
      hits.push([e[12], e[13], e[14]]);
    });
    return hits;
  }, hex);
}

function dist(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

test('a proposed light ghosts WHERE PROPOSED, not at the origin', async ({ page }) => {
  await boot(page);
  await proposeLights(page);

  const key = await ghostLightPositions(page, KEY_COLOR);
  // The discriminator names ONE light, not a neighbourhood. If this widens, every
  // assertion below is about the wrong marker (H171).
  expect(key, 'exactly one ghost carries the key-light colour').toHaveLength(1);

  // THE HEADLINE: the ghost is where the proposal PUTS the light — the renderer's own
  // composed matrixWorld. Pre-fix this read [0,0,0], ~7 units off.
  expect(dist(key[0], PROPOSED)).toBeLessThan(0.05);
  expect(dist(key[0], [0, 0, 0]), 'it genuinely left the origin').toBeGreaterThan(1);
});

test('a second proposed light ghosts at ITS OWN point — the position carries, it is not a constant', async ({
  page,
}) => {
  await boot(page);
  await proposeLights(page);

  // The control proves the group's position is the VALUE, not a fixed non-origin offset:
  // a different proposed position must land at that different point.
  const ctl = await ghostLightPositions(page, CTL_COLOR);
  expect(ctl, 'exactly one ghost carries the control-light colour').toHaveLength(1);
  expect(dist(ctl[0], CONTROL)).toBeLessThan(0.05);
  expect(dist(ctl[0], PROPOSED), 'the two ghosts are in DIFFERENT places').toBeGreaterThan(1);
});
