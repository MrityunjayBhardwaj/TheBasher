// #1235 — which params a keyframe channel can animate, MEASURED on the drawn scene.
//
// For one of every kind the product's Add path places (a Cube wired into the Group and the
// Transform so they have something to move), every keyable-shaped leaf of every node is keyed
// A → B, and the param is animatable when the drawn scene, the camera pose the renderer takes,
// or the image rendered through the active camera moves. A no-channel control at the same two
// times must hold still, and each row is measured against a snapshot taken just before it.
//
// The result is `src/app/animatableCensus.json`, which `isAnimatable` reads. This spec reds on
// Loose difference from it. To regenerate after a renderer changes what it reads:
//   CENSUS_WRITE=1 npx playwright test tests/e2e/p1235-animatable-census.spec.ts
// and commit the JSON with the change that moved it.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from './_fixtures';

const CENSUS = resolve(process.cwd(), 'src/app/animatableCensus.json');

/** The page-side walk reads three.js objects and arbitrary params; typing them here would be a
 *  second copy of three's types for a probe that only hashes them. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

const KINDS = [
  'Cube',
  'Sphere',
  'DirectionalLight',
  'PointLight',
  'SpotLight',
  'AreaLight',
  'AmbientLight',
  'PerspectiveCamera',
  'OrthographicCamera',
  'Group',
  'Transform',
  'Null',
  'Curve',
];

interface Row {
  subject: string;
  type: string;
  nodeId: string;
  path: string;
  kind: string;
  reach: string | null;
  setting: string[];
  note?: string;
}

/** The committed table's shape, built from the measured rows. One row per (subject, pattern);
 *  two instances of a subject that disagree are a measurement error, not a row. */
function tableOf(rows: Row[]) {
  const subjects: Record<string, Record<string, { kind: string; reach: string | null }>> = {};
  const notMeasured: Record<string, string> = {};
  const disagreements: string[] = [];
  for (const r of rows) {
    const pattern = r.path
      .split('.')
      .map((s) => (/^\d+$/.test(s) ? '*' : s))
      .join('.');
    if (r.note?.startsWith('not measured: ')) {
      notMeasured['(^|\\.)uvTransform\\.'] = r.note.slice('not measured: '.length);
      continue;
    }
    const row = { kind: r.kind, reach: r.reach };
    const prev = (subjects[r.subject] ??= {})[pattern];
    if (prev && JSON.stringify(prev) !== JSON.stringify(row))
      disagreements.push(
        `${r.subject} ${pattern}: ${JSON.stringify(prev)} vs ${JSON.stringify(row)}`,
      );
    subjects[r.subject][pattern] = row;
  }
  const sorted = Object.fromEntries(
    Object.keys(subjects)
      .sort()
      .map((k) => [
        k,
        Object.fromEntries(
          Object.keys(subjects[k])
            .sort()
            .map((p) => [p, subjects[k][p]]),
        ),
      ]),
  );
  return {
    table: {
      $comment:
        'Measured by tests/e2e/p1235-animatable-census.spec.ts — regenerate with CENSUS_WRITE=1, never edit by hand. reach: scene | pose | render | null (keyed, nothing moved).',
      subjects: sorted,
      notMeasured: Object.keys(notMeasured)
        .sort()
        .map((pattern) => ({ pattern, reason: notMeasured[pattern] })),
    },
    disagreements,
  };
}

test('which params a keyframe channel can animate, measured on the drawn scene', async ({
  page,
}) => {
  test.setTimeout(900_000);
  await page.goto('/');
  await page.evaluate(async () => {
    const r = await navigator.storage.getDirectory();
    try {
      await r.removeEntry('basher', { recursive: true });
    } catch {
      /* nothing stored yet */
    }
  });
  await page.reload();
  const layout = page.getByTestId('layout');
  const starter = page.getByRole('button', { name: /Open example Starter Scene/i });
  await Promise.race([
    layout.waitFor({ timeout: 15_000 }).catch(() => undefined),
    starter.waitFor({ timeout: 15_000 }).catch(() => undefined),
  ]);
  if (await starter.isVisible().catch(() => false)) await starter.click();
  await expect(layout).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => {
    const w = window as Loose;
    return Boolean(
      w.__basher_addPrimitive && w.__basher_animatableSubject && w.__basher_three?.getState().scene,
    );
  });

  const result = await page.evaluate(async (kinds) => {
    const w = window as Loose;
    const dag = () => w.__basher_dag.getState();
    const frames = () =>
      new Promise<void>((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
      );
    const setT = async (t: number) => {
      w.__basher_time.getState().setTime(t);
      await frames();
      await frames();
    };
    const placed: Record<string, unknown> = {};
    kinds.forEach((k: string, i: number) => {
      placed[k] = w.__basher_addPrimitive(k, [i * 3 - 18, 1, -4]);
    });
    // A Group or Transform with nothing in it draws nothing, so each gets a Cube, wired the
    // way the outliner nests one: out of the scene's children, into the wrapper.
    const sceneId = dag().state.outputs.scene.node;
    const wiring: string[] = [];
    for (const [k, socket] of [
      ['Group', 'children'],
      ['Transform', 'target'],
    ] as const) {
      const wrapper = (placed[k] as { nodeId: string }).nodeId;
      const child = w.__basher_addPrimitive('Cube', [0, 3, -8]).nodeId;
      for (const op of [
        {
          type: 'disconnect',
          from: { node: child, socket: 'out' },
          to: { node: sceneId, socket: 'children' },
        },
        { type: 'connect', from: { node: child, socket: 'out' }, to: { node: wrapper, socket } },
        {
          type: 'connect',
          from: { node: wrapper, socket: 'out' },
          to: { node: sceneId, socket: 'children' },
        },
      ]) {
        const r = dag().dispatch(op, 'user', 'census wiring');
        wiring.push(`${k}:${op.type}:${JSON.stringify(r)?.slice(0, 80)}`);
      }
    }
    await frames();
    await frames();

    const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
    function snap(): string {
      const scene = w.__basher_three.getState().scene;
      scene.updateMatrixWorld(true);
      const parts: string[] = [
        `env:${r4(scene.environmentIntensity ?? 1)}:${r4(scene.environmentRotation?.y ?? 0)}:${r4(scene.backgroundIntensity ?? 1)}`,
      ];
      scene.traverse((o: Loose) => {
        const p: (string | number)[] = [
          o.type,
          o.name,
          o.visible ? 1 : 0,
          ...o.matrixWorld.elements.map(r4),
        ];
        const g = o.geometry;
        if (g?.attributes?.position) {
          const a = g.attributes.position.array;
          let s = 0;
          const step = Math.max(1, Math.floor(a.length / 997));
          for (let i = 0; i < a.length; i += step) s += a[i] * ((i % 7) + 1);
          p.push('g', a.length, r4(s), g.drawRange?.count ?? -1);
        }
        const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
        for (const m of ms) {
          p.push('m', m.type, m.visible ? 1 : 0, m.transparent ? 1 : 0, m.map ? 1 : 0);
          for (const key of Object.keys(m).sort()) {
            const v = (m as Loose)[key];
            if (typeof v === 'number') p.push(`${key}=${r4(v)}`);
            else if (v && v.isColor) p.push(`${key}=${v.getHex()}`);
            else if (v && v.isVector2) p.push(`${key}=${r4(v.x)},${r4(v.y)}`);
          }
        }
        if (o.isLight) {
          if (o.target?.isObject3D) {
            o.target.updateMatrixWorld(true);
            p.push('lt', ...o.target.matrixWorld.elements.slice(12, 15).map(r4));
          }
          p.push(
            'l',
            r4(o.intensity),
            o.color.getHex(),
            r4(o.distance ?? -1),
            r4(o.decay ?? -1),
            r4(o.angle ?? -1),
            r4(o.penumbra ?? -1),
            r4(o.width ?? -1),
            r4(o.height ?? -1),
            o.castShadow ? 1 : 0,
          );
        }
        if (o.isCamera)
          p.push(
            'c',
            r4(o.fov ?? -1),
            r4(o.near),
            r4(o.far),
            r4(o.zoom ?? 1),
            r4(o.top ?? 0),
            r4(o.left ?? 0),
          );
        parts.push(p.join(','));
      });
      return parts.join('|');
    }
    const poses = () =>
      JSON.stringify(w.__basher_frustum_pose ?? {}, (_k, v) => (typeof v === 'number' ? r4(v) : v));

    async function renderHash(): Promise<string> {
      const out = await w.__basher_render_png('beauty');
      if (!out) return 'no-render';
      let h = 2166136261;
      const str = `${out.width}x${out.height}:${out.dataUrl}`;
      for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      return String(h >>> 0);
    }
    const subjectOf = (id: string): string => w.__basher_animatableSubject(id) ?? 'unknown';
    function posingCamera(id: string): string | null {
      const nodes = dag().state.nodes;
      const n = nodes[id];
      if (n.type === 'Object' && subjectOf(id).includes('CameraData')) return id;
      if (n.type === 'CameraData')
        return (
          Object.entries(nodes).find(([, m]: Loose) => m.inputs?.data?.node === id)?.[0] ?? null
        );
      return null;
    }
    function kindOf(v: unknown): string | null {
      if (typeof v === 'number') return 'number';
      if (typeof v === 'string') return /^#[0-9a-fA-F]{6}$/.test(v) ? 'color' : null;
      if (
        Array.isArray(v) &&
        v.length >= 2 &&
        v.length <= 4 &&
        v.every((x) => typeof x === 'number')
      )
        return ({ 2: 'vec2', 3: 'vec3', 4: 'quat' } as Record<number, string>)[v.length];
      return null;
    }
    function walk(v: unknown, path: string, out: [string, string, unknown][]) {
      const k = kindOf(v);
      if (k) {
        out.push([path, k, v]);
        return;
      }
      if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}.${i}`, out));
      else if (v && typeof v === 'object')
        for (const [key, x] of Object.entries(v)) walk(x, path ? `${path}.${key}` : key, out);
    }
    function perturb(kind: string, v: Loose): unknown {
      switch (kind) {
        case 'number':
          return v + Math.max(0.5, Math.abs(v) * 0.6) + 0.13;
        case 'color':
          return v.toLowerCase() === '#ff00ff' ? '#00ff00' : '#ff00ff';
        case 'vec2':
          return [v[0] + 0.7, v[1] + 0.45];
        case 'vec3':
          return [v[0] + 0.7, v[1] + 0.45, v[2] - 0.6];
        case 'quat': {
          const q = [0.2, 0.3, 0.1, 0.927];
          const n = Math.hypot(...q);
          return q.map((x) => x / n);
        }
      }
      return v;
    }
    const TYPE: Record<string, string> = {
      number: 'KeyframeChannelNumber',
      vec2: 'KeyframeChannelVec2',
      vec3: 'KeyframeChannelVec3',
      quat: 'KeyframeChannelQuat',
      color: 'KeyframeChannelColor',
    };

    await setT(0);
    const c0 = snap();
    await setT(1);
    const c1 = snap();
    const controlStill = c0 === c1;

    const nodes = dag().state.nodes as Record<
      string,
      { type: string; params: Record<string, unknown> }
    >;
    const rows: {
      subject: string;
      type: string;
      nodeId: string;
      path: string;
      kind: string;
      reach: string | null;
      setting: string[];
      note?: string;
    }[] = [];
    let n = 0;
    for (const [id, node] of Object.entries(nodes)) {
      if (node.type.startsWith('KeyframeChannel')) continue;
      const leaves: [string, string, unknown][] = [];
      walk(node.params, '', leaves);
      for (const [path, kind, value] of leaves) {
        const chId = `census_ch_${n++}`;
        if (/(^|\.)uvTransform\./.test(path)) {
          rows.push({
            subject: subjectOf(id),
            type: node.type,
            nodeId: id,
            path,
            kind,
            reach: null,
            setting: [],
            note: 'not measured: only visible through a texture, and the harness places none',
          });
          continue;
        }
        // SETTING: a lobe field is invisible while its lobe's weight is 0, so switch the lobe on
        // for the measurement and record that it needed it.
        const setting: string[] = [];
        const lobe = /^(.*\.)([a-z_]+)\.([a-z_A-Z]+)$/.exec(path);
        if (lobe && lobe[3] !== 'weight') {
          const wPath = `${lobe[1]}${lobe[2]}.weight`;
          const wv = wPath
            .split('.')
            .reduce((o: Loose, k) => (o == null ? undefined : o[k]), node.params);
          if (wv === 0) {
            dag().dispatch(
              { type: 'setParam', nodeId: id, paramPath: wPath, value: 1 },
              'user',
              'census',
            );
            setting.push(`${wPath}=1`);
          }
        }
        const cam = posingCamera(id);
        if (cam) {
          w.__basher_setActiveCamera(cam);
          setting.push('active camera');
        }
        await frames();
        await frames();
        const pre = snap();
        const prePose = poses();
        const res = dag().dispatch(
          {
            type: 'addNode',
            nodeId: chId,
            nodeType: TYPE[kind],
            params: {
              name: path,
              target: id,
              paramPath: path,
              keyframes: [
                { time: 0, value, easing: 'linear' },
                { time: 1, value: perturb(kind, value), easing: 'linear' },
              ],
            },
          },
          'user',
          'census',
        );
        if (!dag().state.nodes[chId]) {
          rows.push({
            subject: subjectOf(id),
            type: node.type,
            nodeId: id,
            path,
            kind,
            reach: null,
            setting,
            note: 'channel refused ' + JSON.stringify(res)?.slice(0, 120),
          });
          continue;
        }
        await frames();
        await frames();
        const s1 = snap();
        let reach: string | null = s1 !== pre ? 'scene' : poses() !== prePose ? 'pose' : null;
        if (!reach) {
          // Not in the editor scene: render through the active camera with and without it.
          const withIt = await renderHash();
          dag().dispatch(
            { type: 'setParam', nodeId: chId, paramPath: 'mute', value: true },
            'user',
            'census',
          );
          await frames();
          await frames();
          const without = await renderHash();
          if (withIt !== without) reach = 'render';
        }
        dag().dispatch({ type: 'removeNode', nodeId: chId }, 'user', 'census');
        await frames();
        await frames();
        const back = snap();
        if (setting.some((x) => x.endsWith('=1'))) {
          const wPath = setting.find((x) => x.endsWith('=1'))!.slice(0, -2);
          dag().dispatch(
            { type: 'setParam', nodeId: id, paramPath: wPath, value: 0 },
            'user',
            'census',
          );
          await frames();
        }
        rows.push({
          subject: subjectOf(id),
          type: node.type,
          nodeId: id,
          path,
          kind,
          reach,
          setting,
          ...(back !== pre ? { note: 'did not return to base' } : {}),
        });
      }
    }
    return { controlStill, placed, wiring, rows };
  }, KINDS);

  const rows = result.rows as Row[];
  // The measurement has to be able to see anything before its "nothing moved" means anything.
  expect(result.controlStill, 'no channel, two playheads: the scene holds still').toBe(true);
  expect(rows.filter((r) => r.reach !== null).length, 'some params move the scene').toBeGreaterThan(
    0,
  );
  expect(rows.filter((r) => r.note?.startsWith('channel refused'))).toEqual([]);
  // Every row returns to its own snapshot once its channel is gone — except the two env params,
  // whose imperative write is never undone (#1239). Pinned so the fix reds here and is re-pinned.
  expect(
    rows.filter((r) => r.note === 'did not return to base').map((r) => `${r.subject}.${r.path}`),
  ).toEqual(['Scene.envIntensity', 'Scene.envRotationY']);

  const { table, disagreements } = tableOf(rows);
  expect(disagreements, 'two instances of one subject agree').toEqual([]);
  if (process.env.CENSUS_WRITE === '1') {
    writeFileSync(CENSUS, JSON.stringify(table, null, 2) + '\n');
    return;
  }
  const committed = JSON.parse(readFileSync(CENSUS, 'utf8'));
  expect(table, 'the measured census equals src/app/animatableCensus.json').toEqual(committed);
});
