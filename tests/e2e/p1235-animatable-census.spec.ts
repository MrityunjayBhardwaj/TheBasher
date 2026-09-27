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
//
// #1260 — CI runs it as parallel jobs, one per part: `CENSUS_PART=2/3` measures only the second
// third of the subjects and checks them against their part of the file. The e2e shards skip it
// (`E2E_SKIP_CENSUS`, see playwright.config.ts). Writing needs the whole census, so it refuses a
// part.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from './_fixtures';

const CENSUS = resolve(process.cwd(), 'src/app/animatableCensus.json');
// #1259 — each subject's measured seconds, written beside the census by CENSUS_WRITE. The parts
// split by it: rows are not time (parts of 265 / 265 / 264 rows cost 3.3 / 8.8 / 11.1 min).
const COST = resolve(process.cwd(), 'tests/e2e/p1235-census-cost.json');
const COSTS: Record<string, number> = (() => {
  try {
    return (JSON.parse(readFileSync(COST, 'utf8')) as { seconds: Record<string, number> }).seconds;
  } catch {
    return {};
  }
})();

const PART = (() => {
  const raw = process.env.CENSUS_PART;
  if (!raw) return null;
  const m = /^(\d+)\/(\d+)$/.exec(raw);
  if (!m || +m[1] < 1 || +m[1] > +m[2])
    throw new Error(`CENSUS_PART must be i/n with 1 ≤ i ≤ n, got "${raw}"`);
  return { index: +m[1], count: +m[2] };
})();

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

/** The compute vocabulary. Each is measured THROUGH a driver onto a Sphere, since a compute
 *  node draws nothing of its own. Mirrors `COMPUTE_KINDS` in src/app/addPrimitives.ts. */
const COMPUTE = [
  'Math',
  'Fit',
  'Clamp',
  'Mix',
  'CurveRemap',
  'Noise',
  'MakeVec3',
  'VecBreak3',
  'Vec3Math',
  'SampleGeometry',
  'Lag',
  'Solver',
  'PrevFrame',
  'SolverInput',
];

interface Row {
  subject: string;
  type: string;
  nodeId: string;
  path: string;
  kind: string;
  reach: string | null;
  /** #1258 — the same param driven by a ParamDriver instead: absent for a kind a driver cannot
   *  carry, null when the driver moved nothing. */
  driver?: string | null;
  setting: string[];
  note?: string;
  driverNote?: string;
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
    const row = {
      kind: r.kind,
      reach: r.reach,
      ...(r.driver !== undefined ? { driver: r.driver } : {}),
    };
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
        'Measured by tests/e2e/p1235-animatable-census.spec.ts — regenerate with CENSUS_WRITE=1, never edit by hand. reach: scene | pose | composite | render | null (keyed, nothing moved). driver: the same for a ParamDriver carrying the value, on number and vec3 rows only.',
      subjects: sorted,
      notMeasured: Object.keys(notMeasured)
        .sort()
        .map((pattern) => ({ pattern, reason: notMeasured[pattern] })),
    },
    disagreements,
  };
}

// Each part is its own test, so the merged CI report holds n distinct results rather than one
// title reported n times.
const TITLE =
  'which params a keyframe channel can animate, measured on the drawn scene' +
  (PART ? ` (part ${PART.index}/${PART.count})` : '');

test(TITLE, async ({ page }) => {
  // Wall time follows the machine's load, not the code (#1262: 597 rows took 14.3 min at load 13
  // and 23.1 min at load 24, on one commit). The cap is there to catch a hang, so it sits well
  // above both.
  test.setTimeout(2_700_000);
  if (PART && process.env.CENSUS_WRITE === '1')
    throw new Error('CENSUS_WRITE needs the whole census — unset CENSUS_PART');
  page.on('pageerror', (e) => console.log('CENSUS pageerror: ' + e.message.slice(0, 300)));
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
      w.__basher_addPrimitive &&
      w.__basher_censusBuilders &&
      w.__basher_animatableContext &&
      w.__basher_three?.getState().scene,
    );
  });

  const result = await page.evaluate(
    async ({ kinds, compute, part, costs }) => {
      const w = window as Loose;
      const dag = () => w.__basher_dag.getState();
      const frames = () =>
        new Promise<void>((r) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => requestAnimationFrame(() => r())),
          ),
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

      // Everything else the product can put on a scene object, placed by the builders its panels
      // call. Each operator gets a Cube of its own so it is measured alone, not under another's
      // handle. A builder that refuses is recorded, never dropped.
      const B = w.__basher_censusBuilders;
      const placement: string[] = [];
      let slot = 0;
      const at = (): [number, number, number] => [
        (slot++ % 12) * 2.5 - 14,
        1 + Math.floor(slot / 12) * 2.5,
        -12,
      ];
      const apply = (ops: unknown[] | undefined | null, what: string): boolean => {
        if (!ops) {
          placement.push(`${what}: the builder refused`);
          return false;
        }
        dag().dispatchAtomic(ops, 'user', `census ${what}`);
        return true;
      };
      for (const [section, build] of [
        ['modifier', B.buildAddModifierOps],
        ['material', B.buildAddMaterialOpOps],
      ] as const) {
        for (const type of B.operatorTypesInSection(section)) {
          const c = w.__basher_addPrimitive('Cube', at());
          const r = build(dag().state, c.dataNodeId, type) ?? build(dag().state, c.nodeId, type);
          apply(r?.ops, `${section} ${type}`);
        }
      }
      {
        const c = w.__basher_addPrimitive('Cube', at());
        const r =
          B.buildNewMaterialOps(dag().state, c.dataNodeId) ??
          B.buildNewMaterialOps(dag().state, c.nodeId);
        apply(r?.ops, 'material');
      }
      {
        const c = w.__basher_addPrimitive('Cube', at());
        apply(B.buildAddConstraintOps(dag().state, c.nodeId, 'TrackTo')?.ops, 'TrackTo');
      }
      {
        const c = w.__basher_addPrimitive('Cube', at());
        const r = B.buildAddConstraintOps(dag().state, c.nodeId, 'FollowPath');
        if (apply(r?.ops, 'FollowPath'))
          dag().dispatch(
            {
              type: 'setParam',
              nodeId: r.constraintId,
              paramPath: 'curve',
              value: (placed['Curve'] as { nodeId: string }).nodeId,
            },
            'user',
            'census',
          );
      }
      for (const kind of compute) {
        const src = w.__basher_addPrimitive(kind, at());
        if (!src) {
          placement.push(`${kind}: not placed`);
          continue;
        }
        const target = w.__basher_addPrimitive('Sphere', at());
        // The bind builder takes the socket it is given; `connect` is what checks it exists.
        // So try the output names a compute node uses, and record the one that took.
        let bound = '';
        for (const socket of ['out', 'x', 'point', 'value']) {
          const source = {
            kind: 'output',
            id: kind,
            label: kind,
            ref: { node: src.nodeId, socket },
          };
          for (const [targetId, paramPath] of [
            [target.dataNodeId, 'radius'],
            [target.nodeId, 'position'],
          ]) {
            const res = B.buildBindDriverOps(dag().state, {
              targetId,
              paramPath,
              source,
              driverId: `drv_${kind}`,
            });
            if (!res.ok) continue;
            try {
              dag().dispatchAtomic(res.ops, 'user', `census driver ${kind}`);
              bound = `${socket} → ${paramPath}`;
              break;
            } catch {
              continue;
            }
          }
          if (bound) break;
        }
        if (!bound)
          placement.push(`${kind}: no output of it binds to a Sphere's radius or position`);
      }
      // #1258 — the driver arm's source: one controller Null, apart from everything and never
      // walked as a subject. A number row reads its `tx` (0 at home) remapped onto the value; a
      // vec3 row reads its whole position, moved to the value for that row, since the position
      // road has no remap. Both roads end in the one seam every reader of a driver calls
      // (`driverChannelValuesForTarget`), so which source a row uses does not change its reach.
      const CTRL_HOME: [number, number, number] = [0, -40, -60];
      const ctrl = w.__basher_addPrimitive('Null', CTRL_HOME);
      if (!ctrl) throw new Error('the driver arm could not place its controller Null');
      const harness = new Set<string>([ctrl.nodeId, ctrl.dataNodeId].filter(Boolean));
      // #1259 — a compositor Layer's params are read by the composite, which the 3D scene never
      // shows. Two compositions, each placed the way the video space places one: a bare media
      // layer, and one with a ColorCorrect on its clip (an effect puts its clip under a stack, so
      // the bare one is where the clip is measured). The image is made here: a ramp in every
      // channel, so a grade that pivots on the middle grey moves it, and narrower than the comp,
      // so the background shows beside it.
      const comps: string[] = [];
      {
        const c = new OffscreenCanvas(48, 32);
        const g = c.getContext('2d')!;
        for (let x = 0; x < 48; x++)
          for (let y = 0; y < 32; y++) {
            g.fillStyle = `rgb(${30 + x * 4},${40 + y * 5},${200 - x * 2})`;
            g.fillRect(x, y, 1, 1);
          }
        const bytes = new Uint8Array(
          await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer(),
        );
        for (const effect of [null, 'ColorCorrect']) {
          const compId = B.createNewComposition();
          const layerId = await B.importMediaClipAsLayer(
            { relativePath: `census-${effect ?? 'bare'}.png`, bytes },
            compId,
          );
          if (!layerId) throw new Error('the census could not add a media layer');
          if (effect) {
            const ops = B.buildAddLayerEffectOps(dag().state, layerId, effect);
            apply(ops.length ? ops : null, `effect ${effect}`);
          }
          comps.push(compId);
        }
      }
      /** The frame each composition composites at the playhead, hashed. */
      async function compHash(): Promise<string> {
        const out: string[] = [];
        for (const id of comps) {
          const img = await B.compositeFrame(id);
          if (!img) {
            out.push('none');
            continue;
          }
          const words = new Uint32Array(img.data.buffer);
          let h = 2166136261;
          for (let i = 0; i < words.length; i++) {
            h ^= words[i];
            h = Math.imul(h, 16777619);
          }
          out.push(`${img.width}x${img.height}:${h >>> 0}`);
        }
        return out.join(',');
      }
      // #1259 — a posable node's `quaternion` is optional and absent until the author opts in, so
      // no leaf existed to key. Seed it (the identity, which draws what the euler zero draws) on
      // every node whose schema DECLARES a rotation mode, and measure each such node in both
      // modes. Asked of the schema, not of a dispatch: a passthrough schema (Scene) accepts any
      // write, and seeding it made a Scene "posable" (measured).
      const setMode = (id: string, mode: 'quaternion' | undefined) =>
        dag().dispatch(
          { type: 'setParam', nodeId: id, paramPath: 'rotationMode', value: mode },
          'user',
          'census mode',
        );
      const posable: string[] = [];
      for (const [id, node] of Object.entries(dag().state.nodes) as [string, Loose][]) {
        if (node.type.startsWith('KeyframeChannel') || harness.has(id)) continue;
        if (!B.declaresParam(node.type, 'rotationMode')) continue;
        dag().dispatch(
          { type: 'setParam', nodeId: id, paramPath: 'quaternion', value: [0, 0, 0, 1] },
          'user',
          'census seed',
        );
        if (!Array.isArray(dag().state.nodes[id]?.params?.quaternion))
          throw new Error(`the census could not seed ${node.type} ${id}'s quaternion`);
        posable.push(id);
      }
      await frames();
      await frames();

      const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
      let current = 'setup';
      function snap(): string {
        const scene = w.__basher_three.getState().scene;
        if (!scene) throw new Error(`the viewport's scene is gone, measuring ${current}`);
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
          if (g?.attributes) {
            // Every attribute, not only position: a UV projection moves `uv` and nothing else.
            p.push('g', g.drawRange?.count ?? -1);
            for (const name of Object.keys(g.attributes).sort()) {
              const a = g.attributes[name].array;
              let s = 0;
              const step = Math.max(1, Math.floor(a.length / 997));
              for (let i = 0; i < a.length; i += step) s += a[i] * ((i % 7) + 1);
              p.push(name, a.length, r4(s));
            }
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
        JSON.stringify(w.__basher_frustum_pose ?? {}, (_k, v) =>
          typeof v === 'number' ? r4(v) : v,
        );

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
      const contextOf = (id: string, path?: string): { subject?: string; unmeasured?: string } =>
        w.__basher_animatableContext(id, path);
      const subjectOf = (id: string): string => contextOf(id).subject ?? 'unknown';
      const skippedUnderStack: string[] = [];
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
      // #1280 — a number is keyed inside the range its schema declares: keyed past a bound a
      // reader clamps to (a Layer's opacity 1 -> 1.73, clamped back to 1), it draws as authored
      // and reads "still". The usual step; the opposite step when it leaves the range; the bound
      // farthest from the value when neither fits (the middle could be the value itself).
      // Every row the range turned is logged.
      const bounded: string[] = [];
      function within(type: string, path: string, v: number, step: number): number {
        const r = B.paramRange(type, path) as { min: number | null; max: number | null } | null;
        const fits = (x: number) =>
          !r || ((r.min === null || x >= r.min) && (r.max === null || x <= r.max));
        if (fits(v + step)) return v + step;
        const to =
          fits(v - step) || r!.min === null || r!.max === null
            ? v - step
            : r!.max - v >= v - r!.min
              ? r!.max
              : r!.min;
        bounded.push(`${type}.${path} ${v} -> ${r4(to)} (range ${r!.min}..${r!.max})`);
        return to;
      }
      function perturb(kind: string, v: Loose, type: string, path: string): unknown {
        switch (kind) {
          case 'number':
            return within(type, path, v, Math.max(0.5, Math.abs(v) * 0.6) + 0.13);
          case 'color':
            return v.toLowerCase() === '#ff00ff' ? '#00ff00' : '#ff00ff';
          case 'vec2':
            return [within(type, `${path}.0`, v[0], 0.7), within(type, `${path}.1`, v[1], 0.45)];
          case 'vec3':
            return [
              within(type, `${path}.0`, v[0], 0.7),
              within(type, `${path}.1`, v[1], 0.45),
              within(type, `${path}.2`, v[2], -0.6),
            ];
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
      const c0 = snap() + (await compHash());
      await setT(1);
      const c1 = snap() + (await compHash());
      const controlStill = c0 === c1;
      const composites = await compHash();

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
        driver?: string | null;
        setting: string[];
        note?: string;
        driverNote?: string;
      }[] = [];
      // #1260 — split by SUBJECT, never by row: "two instances of one subject agree" can only be
      // checked when every instance is measured in the same part. Each subject weighs its
      // measured seconds (#1259, from the committed cost file), and the heaviest goes first to the
      // lightest part, so every part derives the same split from the same inputs without being
      // told it. A subject the file has not timed yet weighs its rows at the file's mean seconds
      // per row, and is named in the log so the next CENSUS_WRITE times it.
      const weight: Record<string, number> = {};
      const weigh = (id: string) => {
        if (contextOf(id).unmeasured) return;
        const leaves: [string, string, unknown][] = [];
        walk(dag().state.nodes[id].params, '', leaves);
        const s = subjectOf(id);
        for (const [path] of leaves)
          if (!contextOf(id, path).unmeasured) weight[s] = (weight[s] ?? 0) + 1;
      };
      for (const [id, node] of Object.entries(nodes)) {
        if (node.type.startsWith('KeyframeChannel') || harness.has(id)) continue;
        weigh(id);
        if (posable.includes(id)) {
          setMode(id, 'quaternion');
          weigh(id);
          setMode(id, undefined);
        }
      }
      const timed = Object.keys(weight).filter((x) => x in costs);
      const rowsTimed = timed.reduce((t, x) => t + weight[x], 0);
      const perRow = rowsTimed > 0 ? timed.reduce((t, x) => t + costs[x], 0) / rowsTimed : 1;
      const untimed = Object.keys(weight).filter((x) => !(x in costs));
      for (const x of Object.keys(weight)) weight[x] = x in costs ? costs[x] : weight[x] * perRow;
      const assignment: Record<string, number> = {};
      const partLoad = Array.from({ length: part?.count ?? 1 }, () => 0);
      for (const s of Object.keys(weight).sort(
        (a, b) => weight[b] - weight[a] || (a < b ? -1 : 1),
      )) {
        const k = partLoad.indexOf(Math.min(...partLoad));
        assignment[s] = k + 1;
        partLoad[k] += weight[s];
      }
      /** The reach of the overlay `overlayId` just installed, against a `pre` taken without it.
       *  The overlay is then removed, and the scene it leaves behind is returned as `back`. */
      async function reachOf(overlayId: string, pre: string, prePose: string, preComp: string) {
        await frames();
        await frames();
        const s1 = snap();
        let reach: string | null =
          s1 !== pre
            ? 'scene'
            : poses() !== prePose
              ? 'pose'
              : (await compHash()) !== preComp
                ? 'composite'
                : null;
        if (!reach) {
          // Not in the editor scene: render through the active camera with and without it.
          const withIt = await renderHash();
          dag().dispatch(
            { type: 'setParam', nodeId: overlayId, paramPath: 'mute', value: true },
            'user',
            'census',
          );
          await frames();
          await frames();
          const without = await renderHash();
          if (withIt !== without) reach = 'render';
        }
        dag().dispatch({ type: 'removeNode', nodeId: overlayId }, 'user', 'census');
        await frames();
        await frames();
        return { reach, back: snap() + (await compHash()) };
      }
      let n = 0;
      /** Every leaf of `id` as it stands now: one pass per rotation mode for a posable node. */
      // Wall time per subject, reported beside the rows: rows are not time (a row that moves
      // nothing pays two renders), and the split can only be sized from what each subject costs.
      const subjectMs: Record<string, number> = {};
      async function measurePass(id: string) {
        const subject = subjectOf(id);
        if (part && assignment[subject] !== part.index) return;
        const t0 = performance.now();
        try {
          await measureLeaves(id);
        } finally {
          subjectMs[subject] = (subjectMs[subject] ?? 0) + performance.now() - t0;
        }
      }
      async function measureLeaves(id: string) {
        const node = dag().state.nodes[id] as { type: string; params: Record<string, unknown> };
        const leaves: [string, string, unknown][] = [];
        walk(node.params, '', leaves);
        const ctx = contextOf(id);
        if (ctx.unmeasured) {
          if (leaves.length) skippedUnderStack.push(`${node.type} ${id}: ${ctx.unmeasured}`);
          return;
        }
        for (const [path, kind, value] of leaves) {
          const pathCtx = contextOf(id, path);
          if (pathCtx.unmeasured) {
            skippedUnderStack.push(`${node.type} ${id} ${path}: ${pathCtx.unmeasured}`);
            continue;
          }
          const chId = `census_ch_${n++}`;
          current = `${node.type} ${id} ${path}`;
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
          const preComp = await compHash();
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
                  { time: 1, value: perturb(kind, value, node.type, path), easing: 'linear' },
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
          const { reach, back } = await reachOf(chId, pre, prePose, preComp);
          // #1258 — the driver arm: the same param, in the same setting, driven to the same value
          // by a ParamDriver the product's bind builds, against a "before" taken without it.
          let driver: string | null | undefined;
          let driverNote: string | undefined;
          if (kind === 'number' || kind === 'vec3') {
            const drvId = `census_drv_${n}`;
            const to = perturb(kind, value, node.type, path);
            if (kind === 'vec3') {
              dag().dispatch(
                { type: 'setParam', nodeId: ctrl.nodeId, paramPath: 'position', value: to },
                'user',
                'census',
              );
              await frames();
              await frames();
            }
            const dPre = snap();
            const dPrePose = poses();
            const dPreComp = await compHash();
            const bind = B.buildBindDriverOps(dag().state, {
              targetId: id,
              paramPath: path,
              driverId: drvId,
              source:
                kind === 'number'
                  ? {
                      kind: 'transform',
                      id: 'census',
                      label: 'census',
                      node: ctrl.nodeId,
                      channel: 'tx',
                      remap: { inMin: 0, inMax: 1, outMin: to, outMax: (to as number) + 1 },
                    }
                  : { kind: 'transformVec', id: 'census', label: 'census', node: ctrl.nodeId },
            });
            if (!bind.ok) driverNote = `driver refused: ${bind.reason}`;
            else {
              dag().dispatchAtomic(bind.ops, 'user', 'census');
              const d = await reachOf(drvId, dPre, dPrePose, dPreComp);
              driver = d.reach;
              if (d.back !== dPre + dPreComp) driverNote = 'driver did not return to base';
            }
            if (kind === 'vec3') {
              dag().dispatch(
                { type: 'setParam', nodeId: ctrl.nodeId, paramPath: 'position', value: CTRL_HOME },
                'user',
                'census',
              );
              await frames();
            }
          }
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
            ...(driver !== undefined ? { driver } : {}),
            setting,
            ...(back !== pre + preComp ? { note: 'did not return to base' } : {}),
            ...(driverNote ? { driverNote } : {}),
          });
        }
      }
      for (const [id, node] of Object.entries(nodes)) {
        if (node.type.startsWith('KeyframeChannel') || harness.has(id)) continue;
        await measurePass(id);
        if (posable.includes(id)) {
          setMode(id, 'quaternion');
          await measurePass(id);
          setMode(id, undefined);
          await frames();
        }
      }
      return {
        controlStill,
        composites,
        bounded,
        posable: posable.map((id) => `${dag().state.nodes[id].type} ${subjectOf(id)}`),
        placed,
        wiring,
        placement,
        skippedUnderStack,
        rows,
        assignment,
        partLoad,
        subjectMs,
        untimed,
      };
    },
    { kinds: KINDS, compute: COMPUTE, part: PART, costs: COSTS },
  );

  const rows = result.rows as Row[];
  console.log(`CENSUS posable (${result.posable.length}): ${result.posable.join(' | ')}`);
  console.log(
    'CENSUS placement: ' +
      (result.placement.length ? result.placement.join(' | ') : 'every builder accepted'),
  );
  console.log(
    `CENSUS not measured (context): ${result.skippedUnderStack.length} — ${result.skippedUnderStack.slice(0, 40).join(' | ')}`,
  );
  console.log(`CENSUS rows=${rows.length} moved=${rows.filter((r) => r.reach !== null).length}`);
  const driven = rows.filter((r) => r.driver !== undefined);
  console.log(
    `CENSUS driver arm: rows=${driven.length} moved=${driven.filter((r) => r.driver !== null).length} ` +
      `differ-from-channel=${driven.filter((r) => r.driver !== r.reach).length} — ` +
      driven
        .filter((r) => r.driver !== r.reach)
        .map((r) => `${r.subject}.${r.path} channel=${r.reach} driver=${r.driver}`)
        .join(' | '),
  );
  console.log(
    `CENSUS driver notes: ${rows
      .filter((r) => r.driverNote)
      .map((r) => `${r.subject}.${r.path}: ${r.driverNote}`)
      .join(' | ')}`,
  );
  const subjectMs = result.subjectMs as Record<string, number>;
  console.log(
    'CENSUS subject seconds: ' +
      Object.entries(subjectMs)
        .sort((a, b) => b[1] - a[1])
        .map(([s, ms]) => `${s}=${(ms / 1000).toFixed(1)}`)
        .join(' '),
  );
  console.log(
    `CENSUS cost file: ${Object.keys(COSTS).length} subjects timed; untimed (weighed by rows): ${
      (result.untimed as string[]).join(' ') || 'none'
    }`,
  );
  const assignment = result.assignment as Record<string, number>;
  const mine = (subject: string) => !PART || assignment[subject] === PART.index;
  if (PART)
    console.log(
      `CENSUS part ${PART.index}/${PART.count}: seconds per part ${(result.partLoad as number[]).map((x) => Math.round(x)).join(' / ')}, ` +
        `subjects ${Object.keys(assignment).filter(mine).sort().join(' ')}`,
    );
  // The measurement has to be able to see anything before its "nothing moved" means anything.
  console.log(`CENSUS composites: ${result.composites}`);
  console.log(
    `CENSUS keyed inside a declared range (${result.bounded.length}): ${result.bounded.join(' | ')}`,
  );
  expect(result.controlStill, 'no channel, two playheads: the scene holds still').toBe(true);
  expect(rows.filter((r) => r.reach !== null).length, 'some params move the scene').toBeGreaterThan(
    0,
  );
  // #1259 — the composite arm sees too: both compositions drew a frame, and a keyed Layer moved it.
  expect(result.composites, 'each composition composites a frame').not.toMatch(/none/);
  expect(
    rows.filter((r) => r.reach === 'composite').map((r) => r.type),
    'some params move the composite',
  ).toContain('Layer');
  expect(rows.filter((r) => r.note?.startsWith('channel refused'))).toEqual([]);
  expect(
    rows.filter((r) => r.driverNote?.startsWith('driver refused')).map((r) => r.driverNote),
    'the bind builder takes every number and vec3 row',
  ).toEqual([]);
  // Every row returns to its own snapshot once its channel is gone — except the two env params,
  // whose imperative write is never undone (#1239). Pinned so the fix reds here and is re-pinned.
  expect(
    rows.filter((r) => r.note === 'did not return to base').map((r) => `${r.subject}.${r.path}`),
  ).toEqual(['Scene.envIntensity', 'Scene.envRotationY'].filter((x) => mine(x.split('.')[0])));

  const { table, disagreements } = tableOf(rows);
  expect(disagreements, 'two instances of one subject agree').toEqual([]);
  if (process.env.CENSUS_WRITE === '1') {
    writeFileSync(CENSUS, JSON.stringify(table, null, 2) + '\n');
    writeFileSync(
      COST,
      JSON.stringify(
        {
          $comment:
            'Seconds each census subject took, written by CENSUS_WRITE=1 with the census; the CI parts split by it. Machine-dependent — only the ratios matter.',
          seconds: Object.fromEntries(
            Object.keys(subjectMs)
              .sort()
              .map((x) => [x, Math.round(subjectMs[x] / 100) / 10]),
          ),
        },
        null,
        2,
      ) + '\n',
    );
    return;
  }
  const committed = JSON.parse(readFileSync(CENSUS, 'utf8'));
  if (PART) {
    // Every part places the whole scene and derives the whole split, so each one can check that
    // no subject of the file falls outside all parts — and the n parts together check all of it.
    expect(
      Object.keys(committed.subjects).filter((s) => !assignment[s]),
      'every subject in the file is measured by some part',
    ).toEqual([]);
    expect(
      table.subjects,
      `part ${PART.index}/${PART.count} equals its subjects in the file`,
    ).toEqual(Object.fromEntries(Object.entries(committed.subjects).filter(([s]) => mine(s))));
    // Not-measured patterns are not a subject's, so a part can only check that it found none
    // the file lacks. The whole run (and CENSUS_WRITE) checks the list exactly.
    expect(committed.notMeasured).toEqual(expect.arrayContaining(table.notMeasured));
    return;
  }
  expect(table, 'the measured census equals src/app/animatableCensus.json').toEqual(committed);
});
