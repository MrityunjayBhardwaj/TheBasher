// #386 Stage C (C3) — the split posable light, OBSERVED on the live app.
//
// A light is now an `Object` (pose) wired through `data` to a `LightData` (shading).
// Unlike the mesh splits, a light renders through a SEPARATE band (`scene.lights` /
// `scene.lightRig`) rather than `scene.children`, so its recompose happens at each
// gather-evaluate. Every road below therefore has to be watched from the RENDER side —
// `__basher_light_world_positions()` reports where three.js actually mounted each light —
// because a light that resolves correctly and never mounts type-checks perfectly.
//
// The gates whose natural home is a feature spec live with that feature and are NOT
// duplicated here (all observed darwin-local):
//   - animated shading repaints on a scrub      → p212-light-studio-keyframe,
//                                                 deep-light-studio-animation
//   - the inspector shows a split light's rows  → deep-light-studio-animation
//   - the Light Studio panel edits + keys       → p212, p206-light-studio-panel
//   - Track-To aims a split Spot/Sun/Area       → p265-aimable-light-track-to, p205
//   - a LightRig recomposes its grouped lights  → p208-light-rig
//   - a light nested in a Group illuminates     → p231-grouped-light
//   - a proposed light ghosts where proposed    → p355-ghost-light-position
//
// What is left, and lives here:
//   1. the three plain RENDER roads (default project / freshly added / nested-then-freed);
//   2. the studio-profile JSON round-trip, which reads shading through `data` on the way
//      OUT and writes it back through `data` on the way IN — a reach missing on either
//      side silently substitutes the fallback constants (5 / #ffffff / 2×2), so the fixture
//      uses values that collide with NO fallback;
//   3. reparenting a grouped light back to the Scene root, which must return it to the
//      RICH `scene.lights` band (helpers/channels/aim), not the generic children band.
//
// REF: src/nodes/LightData.ts; src/nodes/lightRecompose.ts; src/app/lightNode.ts;
//      src/app/studioProfileIO.ts; src/viewport/SceneFromDAG.tsx; #386.

import { expect, test } from './_fixtures';
import type { JSHandle, Page } from '@playwright/test';
import { splitLightOps } from './_splitLight';

interface W {
  __basher_dag: {
    getState: () => {
      state: {
        outputs: { scene?: { node: string } };
        nodes: Record<
          string,
          {
            type: string;
            params: Record<string, unknown>;
            inputs?: {
              data?: { node?: string };
              children?: { node: string }[];
              lights?: { node: string }[];
            };
          }
        >;
      };
      dispatch: (op: unknown) => void;
      dispatchAtomic: (ops: unknown[], source?: string, label?: string) => void;
    };
  };
  __basher_light_world_positions?: () => [number, number, number][];
  __basher_importEnvHdri?: (bytes: Uint8Array, filename: string) => Promise<string>;
}

/** Every rendered three.js light's world position — the RENDER side, not the resolver. */
async function litPositions(page: Page): Promise<[number, number, number][]> {
  return page.evaluate(() => (window as unknown as W).__basher_light_world_positions?.() ?? []);
}

const near = (
  ps: [number, number, number][],
  x: number,
  y: number,
  z: number,
  tol = 0.25,
): boolean =>
  ps.some((p) => Math.abs(p[0] - x) < tol && Math.abs(p[1] - y) < tol && Math.abs(p[2] - z) < tol);

async function ready(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as W;
    return Boolean(
      w.__basher_dag && w.__basher_light_world_positions && w.__basher_dag.getState().state.outputs,
    );
  });
}

test.describe('#386 C3 — the split posable light, observed', () => {
  test('the three render roads: the default project, a freshly added light, and one freed from a Group', async ({
    page,
  }) => {
    await ready(page);

    // ROAD 1 — the default project is split-native (default.ts mints n_light + n_light_data).
    // A fused light there would throw on evaluate at boot and nothing would mount.
    await expect
      .poll(async () => near(await litPositions(page), 5, 5, 3), { timeout: 10_000 })
      .toBe(true);

    // ROAD 2 — a split light added straight into scene.lights illuminates from its
    // OBJECT's position (the pose half), with its shading read through `data`.
    const addOps = splitLightOps({
      objectId: 'obs_point',
      lightKind: 'Point',
      position: [7, 1, -2],
      shading: { intensity: 3 },
    });
    await page.evaluate((ops) => {
      const w = window as unknown as W;
      const sceneId = w.__basher_dag.getState().state.outputs.scene!.node;
      w.__basher_dag.getState().dispatchAtomic(
        [
          ...ops,
          {
            type: 'connect',
            from: { node: 'obs_point', socket: 'out' },
            to: { node: sceneId, socket: 'lights' },
          },
        ],
        'e2e',
        'add split point light',
      );
    }, addOps);
    await expect
      .poll(async () => near(await litPositions(page), 7, 1, -2), { timeout: 10_000 })
      .toBe(true);

    // ROAD 3 — nested under a Group, the light recomposes at the GROUP-composed world
    // (the group's [-4,0,0] plus the light's own [7,1,-2]) and keeps illuminating.
    await page.evaluate(() => {
      const w = window as unknown as W;
      const sceneId = w.__basher_dag.getState().state.outputs.scene!.node;
      w.__basher_dag.getState().dispatchAtomic(
        [
          {
            type: 'addNode',
            nodeId: 'obs_grp',
            nodeType: 'Group',
            params: { position: [-4, 0, 0] },
          },
          {
            type: 'connect',
            from: { node: 'obs_grp', socket: 'out' },
            to: { node: sceneId, socket: 'children' },
          },
          {
            type: 'disconnect',
            from: { node: 'obs_point', socket: 'out' },
            to: { node: sceneId, socket: 'lights' },
          },
          {
            type: 'connect',
            from: { node: 'obs_point', socket: 'out' },
            to: { node: 'obs_grp', socket: 'children' },
          },
        ],
        'e2e',
        'nest the light in a group',
      );
    });
    await expect
      .poll(async () => near(await litPositions(page), 3, 1, -2), { timeout: 10_000 })
      .toBe(true);
    // FALSIFICATION: it really moved — nothing is lit at the un-grouped spot any more.
    expect(near(await litPositions(page), 7, 1, -2)).toBe(false);
  });

  test('a studio profile round-trips through JSON with its NON-DEFAULT shading intact', async ({
    page,
  }) => {
    await ready(page);

    // Every fixture value is chosen to collide with NO fallback in composeProfile
    // (which substitutes 5 / '#ffffff' / 2 / 2 when the shading read misses). A reach
    // that silently failed on either the export or the import side would land on those
    // constants, so each assertion below is a real discriminator.
    const INTENSITY = 7.5;
    const WIDTH = 3.25;
    const HEIGHT = 1.75;
    const COLOR = '#3ad17f';

    const lightOps = splitLightOps({
      objectId: 'rt_light',
      lightKind: 'Area',
      position: [2, 3, 4],
      shading: { intensity: INTENSITY, color: COLOR, width: WIDTH, height: HEIGHT },
    });

    const texRef = await page.evaluate(
      async ({ lightOps }) => {
        const w = window as unknown as W;
        const bytes = new Uint8Array(
          await fetch('/fixtures/env/test.hdr').then((r) => r.arrayBuffer()),
        );
        const assetRef = await w.__basher_importEnvHdri!(bytes, 'test.hdr');
        const sceneId = w.__basher_dag.getState().state.outputs.scene!.node;
        w.__basher_dag.getState().dispatchAtomic(
          [
            ...lightOps,
            { type: 'setParam', nodeId: 'rt_light_data', paramPath: 'tex', value: assetRef },
            {
              type: 'addNode',
              nodeId: 'rt_rig',
              nodeType: 'LightRig',
              params: { name: 'Round Trip' },
            },
            {
              type: 'connect',
              from: { node: 'rt_light', socket: 'out' },
              to: { node: 'rt_rig', socket: 'lights' },
            },
            {
              type: 'connect',
              from: { node: 'rt_rig', socket: 'out' },
              to: { node: sceneId, socket: 'lightRig' },
            },
          ],
          'e2e',
          'build a studio profile',
        );
        return assetRef;
      },
      { lightOps },
    );
    expect(texRef, 'the fixture texture imported').toBeTruthy();

    // Open the Light Studio, where the Profiles bar lives.
    const drawer = page.getByTestId('timeline-drawer');
    if ((await drawer.getAttribute('data-open')) !== 'true') {
      await page.getByTestId('timeline-drawer-toggle').click();
    }
    await page.getByTestId('timeline-tab-lightStudio').click();
    await expect(page.getByTestId('light-studio-panel')).toBeVisible();

    // EXPORT through the real button, and read what actually landed in the file.
    const download = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('light-studio-profiles-export').click(),
    ]).then(([d]) => d);
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c as Buffer);
    const json = Buffer.concat(chunks).toString('utf8');
    const parsed = JSON.parse(json) as {
      profiles: {
        name: string;
        lights: {
          intensity: number;
          color: string;
          width: number;
          height: number;
          tex?: string;
          position: [number, number, number];
        }[];
      }[];
    };

    const exported = parsed.profiles.find((p) => p.name === 'Round Trip');
    expect(exported, 'the rig exported as a profile').toBeTruthy();
    expect(exported!.lights).toHaveLength(1);
    const outLight = exported!.lights[0];
    // The EXPORT side reached through `data` for every shading field…
    expect(outLight.intensity, 'exported intensity is the authored 7.5, not the 5 fallback').toBe(
      INTENSITY,
    );
    expect(outLight.width, 'exported width is the authored 3.25, not the 2 fallback').toBe(WIDTH);
    expect(outLight.height, 'exported height is the authored 1.75, not the 2 fallback').toBe(
      HEIGHT,
    );
    expect(outLight.color, 'exported colour is the authored one, not the #ffffff fallback').toBe(
      COLOR,
    );
    expect(outLight.tex, 'exported texture ref survived').toBe(texRef);
    // …and the POSE came off the Object half.
    expect(outLight.position).toEqual([2, 3, 4]);

    // IMPORT the very bytes we exported, back through the real file input.
    const dataIdsBefore = await page.evaluate(() =>
      Object.entries((window as unknown as W).__basher_dag.getState().state.nodes)
        .filter(([, n]) => n.type === 'LightData')
        .map(([id]) => id),
    );
    await page.getByTestId('light-studio-profiles-import-file').setInputFiles({
      name: 'light-profiles.json',
      mimeType: 'application/json',
      buffer: Buffer.from(json),
    });

    // A brand-new LightData appeared, carrying the round-tripped shading — a light
    // rebuilt from fallbacks would read 5 / #ffffff / 2 / 2 here.
    const imported = await expect
      .poll(
        async () =>
          page.evaluate((before) => {
            const nodes = (window as unknown as W).__basher_dag.getState().state.nodes;
            const fresh = Object.entries(nodes).find(
              ([id, n]) => n.type === 'LightData' && !before.includes(id),
            );
            return fresh ? (fresh[1].params as Record<string, unknown>) : null;
          }, dataIdsBefore),
        { timeout: 10_000 },
      )
      .not.toBeNull()
      .then(() =>
        page.evaluate((before) => {
          const nodes = (window as unknown as W).__basher_dag.getState().state.nodes;
          const fresh = Object.entries(nodes).find(
            ([id, n]) => n.type === 'LightData' && !before.includes(id),
          )!;
          return fresh[1].params as Record<string, unknown>;
        }, dataIdsBefore),
      );

    expect(imported.intensity, 'imported intensity').toBe(INTENSITY);
    expect(imported.width, 'imported width').toBe(WIDTH);
    expect(imported.height, 'imported height').toBe(HEIGHT);
    expect(imported.color, 'imported colour').toBe(COLOR);
    expect(imported.tex, 'imported texture ref').toBe(texRef);
    expect(imported.lightKind, 'imported as an Area light').toBe('Area');
  });

  test('a grouped light dragged back to the Scene root returns to the RICH lights band and stays lit', async ({
    page,
  }) => {
    await ready(page);

    const GRP = 'obs_reparent_grp';
    const LIGHT = 'n_light'; // the default project's split key light, Object at [5,5,3]

    await page.evaluate((grp) => {
      const w = window as unknown as W;
      const sceneId = w.__basher_dag.getState().state.outputs.scene!.node;
      w.__basher_dag.getState().dispatchAtomic(
        [
          { type: 'addNode', nodeId: grp, nodeType: 'Group', params: { position: [6, 0, 0] } },
          {
            type: 'connect',
            from: { node: grp, socket: 'out' },
            to: { node: sceneId, socket: 'children' },
          },
        ],
        'e2e',
        'add a group',
      );
    }, GRP);

    const dragRowOnto = async (srcId: string, dstId: string) => {
      const dt: JSHandle = await page.evaluateHandle(() => new DataTransfer());
      const src = page.locator(`[data-testid="scene-tree-row-${srcId}"]`);
      const dst = page.locator(`[data-testid="scene-tree-row-${dstId}"]`);
      await src.dispatchEvent('dragstart', { dataTransfer: dt });
      await dst.dispatchEvent('dragover', { dataTransfer: dt });
      await dst.dispatchEvent('drop', { dataTransfer: dt });
    };

    const sceneBand = (socket: 'children' | 'lights') =>
      page.evaluate((s) => {
        const st = (window as unknown as W).__basher_dag.getState().state;
        const scene = st.nodes[st.outputs.scene!.node];
        return ((scene.inputs as Record<string, { node: string }[]>)[s] ?? []).map((r) => r.node);
      }, socket);

    // Into the Group: the light leaves the lights band and renders at the composed world.
    await dragRowOnto(LIGHT, GRP);
    await expect.poll(() => sceneBand('lights')).not.toContain(LIGHT);
    await expect
      .poll(async () => near(await litPositions(page), 11, 5, 3), { timeout: 10_000 })
      .toBe(true);

    // Back onto the Scene root: it must land in `lights` — the RICH band that carries
    // helpers, channels and aim — NOT the generic `children` band a kind-blind reparent
    // would drop it into. And it must still actually illuminate, from its own world.
    await dragRowOnto(LIGHT, 'n_scene');
    await expect.poll(() => sceneBand('lights')).toContain(LIGHT);
    expect(await sceneBand('children'), 'not demoted to the generic children band').not.toContain(
      LIGHT,
    );
    await expect
      .poll(async () => near(await litPositions(page), 5, 5, 3), { timeout: 10_000 })
      .toBe(true);
    // FALSIFICATION: the grouped-world light is gone, so the pass is not a leftover.
    expect(near(await litPositions(page), 11, 5, 3)).toBe(false);
  });
});
