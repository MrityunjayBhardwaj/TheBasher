// #1782 — an area light set to face a point keeps facing it when it moves. Before #1765 it was
// turned toward its `lookAt` only when the `lookAt` itself changed, so a moved light kept facing
// the old direction. Now the point is a Track-To's aim and the light is re-turned from where it is
// drawn every frame.
//
// Side A is the live RectAreaLight: its world −Z, the way it shines (three turns a light's −Z
// toward a `lookAt`). Side B is the intended aim, normalize(aim − position), from the position the
// light is moved to. Falsified by turning the light from where it was first drawn instead of where
// it is now (the old `lookAt` effect's behaviour): the moved case goes red.

import { expect, test } from './_fixtures';
import { splitLightOps } from './_splitLight';

type V3 = [number, number, number];
interface W {
  __basher_dag?: { getState: () => { dispatch: (op: unknown) => void } };
  __basher_three?: { getState: () => { scene: unknown } };
}

const norm = (v: V3): V3 => {
  const l = Math.hypot(...v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

/** Every RectAreaLight's world position and the way it shines (its world −Z). */
const areaLights = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const out: { p: number[]; d: number[] }[] = [];
    const scene = (window as unknown as W).__basher_three?.getState().scene as
      | { traverse: (f: (o: unknown) => void) => void }
      | undefined;
    scene?.traverse((o) => {
      const l = o as {
        isRectAreaLight?: boolean;
        updateWorldMatrix: (a: boolean, b: boolean) => void;
        matrixWorld: { elements: number[] };
      };
      if (!l.isRectAreaLight) return;
      l.updateWorldMatrix(true, false);
      const e = l.matrixWorld.elements;
      const z = Math.hypot(e[8], e[9], e[10]);
      out.push({ p: [e[12], e[13], e[14]], d: [-e[8] / z, -e[9] / z, -e[10] / z] });
    });
    return out;
  });

test('#1782 — a Track-To aimed area light keeps facing its aim after it moves', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForFunction(() => {
    const w = window as unknown as W;
    return Boolean(w.__basher_dag && w.__basher_three);
  });
  const AIM: V3 = [0, 0, 0];
  const FROM: V3 = [0, 5, 5];
  const TO: V3 = [5, 5, 0];
  const ops = splitLightOps({
    objectId: 'n1782_area',
    lightKind: 'Area',
    position: FROM,
    shading: { intensity: 5 },
  });
  await page.evaluate(
    ({ ops, AIM }) => {
      const d = (op: unknown) => (window as unknown as W).__basher_dag!.getState().dispatch(op);
      for (const op of ops) d(op);
      d({
        type: 'connect',
        from: { node: 'n1782_area', socket: 'out' },
        to: { node: 'n_scene', socket: 'lights' },
      });
      d({
        type: 'addNode',
        nodeId: 'n1782_aim',
        nodeType: 'TrackTo',
        params: { target: 'n1782_area', aimPoint: AIM },
      });
    },
    { ops, AIM },
  );

  const facesAimFrom = async (pos: V3) => {
    const want = norm([AIM[0] - pos[0], AIM[1] - pos[1], AIM[2] - pos[2]]);
    await expect
      .poll(async () => {
        const light = (await areaLights(page)).find((l) =>
          l.p.every((v, i) => Math.abs(v - pos[i]) < 1e-4),
        );
        if (!light) return `no area light at ${pos}`;
        return Math.max(...light.d.map((v, i) => Math.abs(v - want[i])));
      })
      .toBeLessThan(1e-4);
  };

  await facesAimFrom(FROM);
  await page.evaluate((TO) => {
    (window as unknown as W).__basher_dag!.getState().dispatch({
      type: 'setParam',
      nodeId: 'n1782_area',
      paramPath: 'position',
      value: TO,
    });
  }, TO);
  // Moved: it faces the aim from where it is now, not the old direction (0, −0.71, −0.71).
  await facesAimFrom(TO);
});
