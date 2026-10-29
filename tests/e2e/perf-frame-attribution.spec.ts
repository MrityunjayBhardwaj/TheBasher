// #1727 — where a playback frame goes. A measurement, not a gate.
//
// The playback table's stages (eval, react, world, render submit, shadow walks) add up to about
// 3–5 ms of a 45–80 ms frame p50 on this fixture. This spec attributes the rest, on the same
// fixture (N stress spheres, a keyed box, a keyed Group over a nested selected sphere):
//
//   1. The main thread, sampled. A V8 CPU profile (Chrome DevTools Protocol `Profiler`, 100 µs
//      sampling) over WINDOW_MS of playback, its samples bucketed by what was on top of the stack:
//      idle (the main thread waiting), GC, "(program)" (the browser's own native work: layout,
//      paint, compositing, GPU command submission), and JavaScript by where it comes from —
//      three.js, React, R3F, our source (with the top functions named) and the rest.
//   2. The GPU. In a second pass `gl.render` is followed by `gl.finish()`, which blocks until the
//      GPU has drawn the frame; the time `finish` takes is the drawing the main thread did not
//      see. (Headless Chromium draws with SwiftShader, a CPU rasteriser in the GPU process.)
//
//   3. A Chrome trace of the same window: busy ms per frame on each thread (main, GPU, compositor),
//      and the main thread's time by event name — which is how the readback was found.
//
// Both are printed per row: frame p50, then each bucket as ms per frame (its share of the samples
// times the frame), then the finish time. Skipped on CI.

import { existsSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { CDPSession, Page } from '@playwright/test';
import { test, expect } from './_fixtures';
import { splitCurveOps } from './_splitCurve';

// PERF_ATTR_GPU=1 runs on the machine's GPU (ANGLE on Metal here) instead of headless Chromium's
// SwiftShader. Under SwiftShader the WebGL canvas is read back to the CPU on every compositor
// commit (GLES2::ReadPixels, 46–60 ms a frame at 400–800 objects): the frame times every other
// headless table in this repo reports are mostly that read, not the app.
if (process.env.PERF_ATTR_GPU === '1') {
  test.use({
    launchOptions: { args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] },
  });
}

const LEVELS = (process.env.PERF_ATTR_OBJECTS ?? '400,800').split(',').map((n) => parseInt(n, 10));
// PERF_ATTR_SELECT=0 leaves the nested sphere unselected (no gizmo, no inspector).
const SELECT = process.env.PERF_ATTR_SELECT !== '0';
// #1731 — PERF_ATTR_SUBJECT picks what is selected while the fixture plays, to price the editor
// surfaces that still follow the playhead through React: `sphere` (the default: the nested sphere),
// `camera` (the default scene's camera: its gizmo, lens rows and look-at target), `curve` (a
// selected curve: its point handles), `bone` (a skinned import in Pose mode with a bone selected:
// the bone gizmo), `diff` (an agent's proposed curve pending: the ghost preview), `none`.
const SUBJECT = process.env.PERF_ATTR_SUBJECT ?? (SELECT ? 'sphere' : 'none');
const WINDOW_MS = parseInt(process.env.PERF_ATTR_WINDOW_MS ?? '4000', 10);
// #1734 (6.4) — PERF_ATTR_SCENE=<a split .basher directory, see stageScene> plays that scene instead of the stress
// fixture (one row, nothing selected), opened through the app's own bundle import. With it, the
// row also counts the skinned meshes by road — skinned on the GPU (a three SkinnedMesh) or
// deformed on the CPU (a plain mesh whose position buffer is rewritten as it plays) — and prices
// the functions named in PERF_ATTR_INCLUSIVE, inclusive of what they call.
const SCENE = process.env.PERF_ATTR_SCENE ?? '';
const INCLUSIVE = (
  process.env.PERF_ATTR_INCLUSIVE ??
  'writeDeformed,write,pose,sampleSkinDeform,samplePose,posedBoneMatrices,updateMatrixWorld,update'
).split(',');

interface W {
  __basher_dag: {
    getState: () => {
      state: { outputs: { scene: { node: string } }; nodes: Record<string, unknown> };
      dispatchAtomic: (ops: unknown[], source?: string, description?: string) => unknown;
    };
  };
  __basher_time: {
    getState: () => { setTime: (s: number) => void; play: () => void; pause: () => void };
  };
  __basher_selection: { getState: () => { select: (id: string | null) => void } };
  __basher_perf_stress: (opts: { meshes: number; segments?: number }) => unknown;
  __basher_three: {
    getState: () => {
      gl: {
        render: (s: unknown, c: unknown) => void;
        getContext: () => WebGLRenderingContext;
      } | null;
    };
  };
}

interface ProfileNode {
  id: number;
  children?: number[];
  callFrame: { functionName: string; url: string; lineNumber: number };
}
interface Profile {
  nodes: ProfileNode[];
  samples: number[];
  timeDeltas: number[];
}

async function stage(page: Page, objects: number) {
  await page.goto('/');
  await page.evaluate(async () => {
    if (typeof navigator?.storage?.getDirectory === 'function') {
      const root = await navigator.storage.getDirectory();
      try {
        await root.removeEntry('basher', { recursive: true });
      } catch {
        /* not present */
      }
    }
  });
  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as Partial<W>;
    return Boolean(
      w.__basher_dag &&
      w.__basher_time &&
      w.__basher_perf_stress &&
      w.__basher_three?.getState().gl,
    );
  });
  await page.evaluate(
    ({ objects, select }) => {
      const w = window as unknown as W;
      w.__basher_perf_stress({ meshes: objects, segments: 8 });
      const dag = w.__basher_dag.getState();
      const sceneId = dag.state.outputs.scene.node;
      const key = (nodeId: string, target: string, to: number[]) => ({
        type: 'addNode',
        nodeId,
        nodeType: 'KeyframeChannelVec3',
        params: {
          name: 'position',
          target,
          paramPath: 'position',
          keyframes: [
            { time: 0, value: [0, 2, 0], easing: 'linear' },
            { time: 60, value: to, easing: 'linear' },
          ],
        },
      });
      dag.dispatchAtomic(
        [
          { type: 'addNode', nodeId: 'attr_g', nodeType: 'Group', params: { position: [0, 2, 0] } },
          {
            type: 'addNode',
            nodeId: 'attr_sel_data',
            nodeType: 'SphereData',
            params: { radius: 0.3, widthSegments: 8, heightSegments: 8 },
          },
          {
            type: 'addNode',
            nodeId: 'attr_sel',
            nodeType: 'Object',
            params: { position: [0, 0, 1], rotation: [0, 0, 0], scale: [1, 1, 1] },
          },
          {
            type: 'connect',
            from: { node: 'attr_sel_data', socket: 'out' },
            to: { node: 'attr_sel', socket: 'data' },
          },
          {
            type: 'connect',
            from: { node: 'attr_sel', socket: 'out' },
            to: { node: 'attr_g', socket: 'children' },
          },
          {
            type: 'connect',
            from: { node: 'attr_g', socket: 'out' },
            to: { node: sceneId, socket: 'children' },
          },
          key('attr_ch_box', 'n_box', [0, 0, 150]),
          key('attr_ch_g', 'attr_g', [150, 2, 0]),
          { type: 'setParam', nodeId: sceneId, paramPath: 'frameEnd', value: 3600 },
        ],
        'user',
        'perf-frame-attribution fixture',
      );
      w.__basher_selection.getState().select(select ? 'attr_sel' : null);
    },
    { objects, select: SUBJECT === 'sphere' },
  );
  await selectSubject(page);
  await page.waitForTimeout(500);
}

/** Put the #1731 subject in place: select it, or (for `diff`) propose it. */
/** Open the scene at SCENE as a new project and wait until it draws. SCENE is a directory holding
 *  a `.basher` file split, because the files this is for are past V8's longest string (0x1fffffe8
 *  characters; the 595 MB alley file is, so neither `file.text()` nor `response.text()` can hold
 *  it): `bundle.json` (the bundle without `assets`), `manifest.json` ([bundle path, file, length]
 *  per asset) and `assets/<file>`, one asset's text each. The page puts the bundle object back
 *  together, so no one string is longer than its largest part. The directory is served by the dev
 *  server through a link at `public/__perf_attr_scene` (made here, removed after): routing it
 *  through Playwright sends each body over the protocol as JSON, which aborts the test process. */
async function stageScene(page: Page) {
  const link = join(process.cwd(), 'public', '__perf_attr_scene');
  if (!existsSync(link)) symlinkSync(SCENE, link);
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as Partial<W> & { __basher_import_scene_bundle?: unknown };
    return Boolean(
      w.__basher_import_scene_bundle && w.__basher_time && w.__basher_three?.getState().gl,
    );
  });
  await page.evaluate(async () => {
    const get = async (rel: string) => {
      const r = await fetch(`/__perf_attr_scene/${rel}`);
      if (!r.ok) throw new Error(`${rel}: ${r.status}`);
      return r.text();
    };
    const w = window as unknown as {
      __basher_import_scene_bundle: (b: unknown) => Promise<string>;
    };
    const bundle = JSON.parse(await get('bundle.json')) as { assets?: Record<string, string> };
    const manifest = JSON.parse(await get('manifest.json')) as [string, string, number][];
    bundle.assets = {};
    for (const [path, file] of manifest) bundle.assets[path] = await get(`assets/${file}`);
    await w.__basher_import_scene_bundle(bundle);
  });
  // Assets load after the graph, a character at a time: wait until the mesh count has held for
  // three checks in a row (it plateaus between loads; one repeat was not enough on the alley).
  let last = -1;
  let held = 0;
  for (let i = 0; i < 90 && held < 3; i++) {
    await page.waitForTimeout(3000);
    const n = await page.evaluate(() => {
      const scene = (
        window as unknown as {
          __basher_three: {
            getState: () => {
              scene: { traverse: (f: (o: { isMesh?: boolean }) => void) => void } | null;
            };
          };
        }
      ).__basher_three.getState().scene;
      let c = 0;
      scene?.traverse((o) => {
        if (o.isMesh) c++;
      });
      return c;
    });
    held = n === last && n > 0 ? held + 1 : 0;
    last = n;
  }
}

/** The skinned meshes by road, over one second of playback. */
async function skinRoads(page: Page) {
  return page.evaluate(async () => {
    type M = {
      isMesh?: boolean;
      isSkinnedMesh?: boolean;
      skeleton?: { bones: unknown[] };
      geometry?: { attributes: { position?: { version: number; count: number } } };
    };
    const w = window as unknown as {
      __basher_three: {
        getState: () => { scene: { traverse: (f: (o: M) => void) => void } | null };
      };
      __basher_time: {
        getState: () => { setTime: (s: number) => void; play: () => void; pause: () => void };
      };
    };
    const meshes: M[] = [];
    w.__basher_three.getState().scene?.traverse((o) => {
      if (o.isMesh) meshes.push(o);
    });
    const before = meshes.map((m) => m.geometry?.attributes.position?.version ?? 0);
    const t = w.__basher_time.getState();
    t.setTime(0);
    t.play();
    await new Promise((r) => setTimeout(r, 1000));
    t.pause();
    let gpu = 0;
    let gpuVerts = 0;
    const skeletons = new Set<unknown>();
    let skeletonBones = 0;
    let cpu = 0;
    let cpuVerts = 0;
    meshes.forEach((m, i) => {
      const pos = m.geometry?.attributes.position;
      if (m.isSkinnedMesh) {
        gpu++;
        gpuVerts += pos?.count ?? 0;
        if (m.skeleton && !skeletons.has(m.skeleton)) {
          skeletons.add(m.skeleton);
          skeletonBones += m.skeleton.bones.length;
        }
      } else if (pos && pos.version > before[i]) {
        cpu++;
        cpuVerts += pos.count;
      }
    });
    return {
      meshes: meshes.length,
      gpu,
      gpuVerts,
      cpu,
      cpuVerts,
      skeletons: skeletons.size,
      skeletonBones,
    };
  });
}

async function selectSubject(page: Page) {
  const curve = [
    ...splitCurveOps({
      objectId: 'attr_curve',
      points: [
        [0, 0, 0],
        [2, 0, 0],
        [4, 0, 2],
      ],
    }),
  ];
  await page.evaluate(
    async ({ subject, curve }) => {
      const w = window as unknown as W & {
        __basher_diff: {
          getState: () => { propose: (s: unknown, ops: unknown[], d: string, t: string[]) => void };
        };
      };
      const dag = w.__basher_dag.getState();
      const sceneId = dag.state.outputs.scene.node;
      const toScene = {
        type: 'connect',
        from: { node: 'attr_curve', socket: 'out' },
        to: { node: sceneId, socket: 'children' },
      };
      if (subject === 'camera') w.__basher_selection.getState().select('n_camera');
      if (subject === 'curve') {
        dag.dispatchAtomic([...curve, toScene], 'user', 'attr curve');
        w.__basher_selection.getState().select('attr_curve');
      }
      if (subject === 'diff') {
        w.__basher_diff
          .getState()
          .propose(dag.state, [...curve, toScene], 'add a curve', ['agent:mesh.add']);
      }
      if (subject === 'bone') {
        // Vite serves these by URL; a variable keeps tsc from resolving them as modules.
        const nativeUrl = '/src/core/import/nativeGltfImport.ts';
        const native = (await import(/* @vite-ignore */ nativeUrl)) as {
          buildNativeGltfImportOps: (
            o: unknown,
          ) => Promise<{ ops: unknown[] } | { refused: string }>;
        };
        const buffer = await fetch('/assets/skinned-bar.glb').then((r) => r.arrayBuffer());
        const result = await native.buildNativeGltfImportOps({
          buffer,
          assetRef: 'user-imports/attr/skinned-bar.glb',
          sceneNodeId: sceneId,
          storeImage: async () => 'unused',
        });
        if ('refused' in result) throw new Error(result.refused);
        dag.dispatchAtomic(result.ops, 'user', 'attr skinned import');
        const nodes = w.__basher_dag.getState().state.nodes as Record<
          string,
          { type: string; inputs: Record<string, unknown> }
        >;
        const modifier = Object.entries(nodes).find(([, n]) => n.type === 'ArmatureModifier')![0];
        const armature = (nodes[modifier].inputs.armature as { node: string }).node;
        w.__basher_selection.getState().select(armature);
        const modesUrl = '/src/app/stores/armatureModeStore.ts';
        const bonesUrl = '/src/app/stores/boneSelectionStore.ts';
        const modes = (await import(/* @vite-ignore */ modesUrl)) as {
          useArmatureModeStore: { getState: () => { setMode: (id: string, m: string) => void } };
        };
        const bones = (await import(/* @vite-ignore */ bonesUrl)) as {
          useBoneSelectionStore: {
            getState: () => { selectBone: (id: string, b: string, chain: string[]) => void };
          };
        };
        modes.useArmatureModeStore.getState().setMode(armature, 'pose');
        bones.useBoneSelectionStore.getState().selectBone(armature, 'Bone1', ['Bone0', 'Bone1']);
      }
    },
    { subject: SUBJECT, curve },
  );
}

/** Play for WINDOW_MS; return the animation-frame intervals. `finish` adds gl.finish() after each
 *  render and returns how long it took. */
async function play(page: Page, finish: boolean) {
  return page.evaluate(
    async ({ windowMs, finish }) => {
      const w = window as unknown as W;
      const gl = w.__basher_three.getState().gl!;
      const ctx = gl.getContext();
      const original = gl.render;
      const finishMs: number[] = [];
      if (finish) {
        gl.render = function (this: unknown, s: unknown, c: unknown) {
          const r = original.call(this, s, c);
          const t0 = performance.now();
          ctx.finish();
          finishMs.push(performance.now() - t0);
          return r;
        } as typeof gl.render;
      }
      const t = w.__basher_time.getState();
      t.setTime(0);
      t.play();
      for (let i = 0; i < 5; i++) await new Promise<void>((r) => requestAnimationFrame(() => r()));
      const intervals: number[] = [];
      let last = performance.now();
      let running = true;
      const tick = (now: number) => {
        if (!running) return;
        intervals.push(now - last);
        last = now;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      await new Promise((r) => setTimeout(r, windowMs));
      running = false;
      t.pause();
      gl.render = original;
      return { intervals: intervals.slice(1), finishMs };
    },
    { windowMs: WINDOW_MS, finish },
  );
}

const p50 = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};

function bucketOf(n: ProfileNode): string {
  const { functionName: f, url } = n.callFrame;
  if (f === '(idle)') return 'idle';
  if (f === '(garbage collector)') return 'gc';
  if (f === '(program)') return 'program';
  if (f === '(root)') return 'program';
  if (/three\.module|\/three\//.test(url)) return 'js:three';
  if (/@react-three|react-three-fiber/.test(url)) return 'js:r3f';
  if (/react-dom|react-reconciler|scheduler|\/react\./.test(url)) return 'js:react';
  if (/\/src\//.test(url)) return 'js:src';
  // three, React and R3F arrive through Vite's pre-bundled chunks.
  if (/node_modules\/\.vite\/deps\//.test(url)) return 'js:deps';
  return 'js:other';
}

async function profileWindow(page: Page, cdp: CDPSession) {
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
  await cdp.send('Profiler.start');
  const run = await play(page, false);
  const { profile } = (await cdp.send('Profiler.stop')) as unknown as { profile: Profile };
  await cdp.send('Profiler.disable');
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parentOf = new Map<number, number>();
  for (const n of profile.nodes) for (const c of n.children ?? []) parentOf.set(c, n.id);
  // Own-code samples by call chain: the first six of our own frames from the leaf up, recursion collapsed, so a
  // per-object scan is named with whoever asks for it every frame.
  const chains = new Map<string, number>();
  const own = (n: ProfileNode) => /\/src\//.test(n.callFrame.url);
  const label = (n: ProfileNode) =>
    `${n.callFrame.functionName || '(anon)'}@${n.callFrame.url.replace(/^.*\/src\//, '').replace(/\?.*$/, '')}:${n.callFrame.lineNumber + 1}`;
  const us = new Map<string, number>();
  const srcFns = new Map<string, number>();
  const inclusive = new Map<string, number>();
  const depFns = new Map<string, number>();
  let total = 0;
  profile.samples.forEach((id, i) => {
    const dt = profile.timeDeltas[i] ?? 0;
    const n = byId.get(id)!;
    // Inclusive time of each watched function name: a sample counts once per name on its stack.
    const seen = new Set<string>();
    for (let k: number | undefined = id; k !== undefined; k = parentOf.get(k)) {
      const f = byId.get(k)!.callFrame.functionName;
      if (INCLUSIVE.includes(f) && !seen.has(f)) {
        seen.add(f);
        inclusive.set(f, (inclusive.get(f) ?? 0) + dt);
      }
    }
    const b = bucketOf(n);
    us.set(b, (us.get(b) ?? 0) + dt);
    total += dt;
    if (b === 'js:src') {
      const chain: string[] = [];
      for (
        let k: number | undefined = id;
        k !== undefined && chain.length < 6;
        k = parentOf.get(k)
      ) {
        const m = byId.get(k)!;
        if (own(m) && chain[chain.length - 1] !== label(m)) chain.push(label(m)); // recursion collapsed
      }
      const key = chain.join(' ← ');
      chains.set(key, (chains.get(key) ?? 0) + dt);
    }
    if (b === 'js:deps') {
      const name = `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.replace(/^.*\/deps\//, 'deps/').replace(/\?.*$/, '')}:${n.callFrame.lineNumber + 1}`;
      depFns.set(name, (depFns.get(name) ?? 0) + dt);
    }
    if (b === 'js:src' || b === 'js:other') {
      const name = `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.replace(/^.*\/(src|node_modules)\//, '$1/').replace(/\?.*$/, '')}:${n.callFrame.lineNumber + 1}`;
      srcFns.set(name, (srcFns.get(name) ?? 0) + dt);
    }
  });
  return { run, us, total, srcFns, chains, inclusive, depFns };
}

interface TraceEvent {
  name: string;
  ph: string;
  ts: number;
  dur?: number;
  pid: number;
  tid: number;
  args?: { name?: string };
}

/** A Chrome trace of one playback window: per thread, busy ms per frame (the union of its
 *  top-level tasks), and on the renderer's main thread, ms per frame by event name. */
async function traceWindow(page: Page, cdp: CDPSession) {
  const events: TraceEvent[] = [];
  cdp.on('Tracing.dataCollected', (e) => {
    for (const v of e.value) events.push(v as unknown as TraceEvent);
  });
  const done = new Promise<void>((r) => cdp.once('Tracing.tracingComplete', () => r()));
  await cdp.send('Tracing.start', {
    categories: [
      'toplevel',
      'devtools.timeline',
      'disabled-by-default-devtools.timeline',
      'blink',
      'cc',
      'gpu',
      'viz',
    ].join(','),
    transferMode: 'ReportEvents',
  });
  const run = await play(page, false);
  await cdp.send('Tracing.end');
  await done;
  const threadName = new Map<string, string>();
  for (const e of events)
    if (e.ph === 'M' && e.name === 'thread_name')
      threadName.set(`${e.pid}:${e.tid}`, e.args?.name ?? '?');
  const frames = Math.max(1, run.intervals.length);
  const tasks = new Map<string, [number, number][]>();
  for (const e of events) {
    if (e.ph !== 'X' || !e.dur) continue;
    if (e.name !== 'ThreadControllerImpl::RunTask' && e.name !== 'RunTask') continue;
    const k = `${e.pid}:${e.tid}`;
    if (!tasks.has(k)) tasks.set(k, []);
    tasks.get(k)!.push([e.ts, e.ts + e.dur]);
  }
  const busy = new Map<string, number>();
  for (const [k, xs] of tasks) {
    xs.sort((a, b) => a[0] - b[0]);
    let sum = 0;
    let [s0, e0] = xs[0];
    for (const [s1, e1] of xs.slice(1)) {
      if (s1 > e0) {
        sum += e0 - s0;
        [s0, e0] = [s1, e1];
      } else e0 = Math.max(e0, e1);
    }
    sum += e0 - s0;
    const name = threadName.get(k) ?? k;
    busy.set(name, (busy.get(name) ?? 0) + sum / 1000 / frames);
  }
  // The renderer main thread's work by event name (inclusive ms per frame, top names).
  const main = [...threadName.entries()].filter(([, n]) => n === 'CrRendererMain').map(([k]) => k);
  const byName = new Map<string, number>();
  for (const e of events) {
    if (e.ph !== 'X' || !e.dur || !main.includes(`${e.pid}:${e.tid}`)) continue;
    byName.set(e.name, (byName.get(e.name) ?? 0) + e.dur / 1000 / frames);
  }
  return { run, busy, byName };
}

test('perf frame attribution: where a playback frame goes', async ({ page }) => {
  test.skip(!!process.env.CI, 'CI runners have no real GPU and noisy CPU; run locally');
  test.setTimeout(600_000);
  const cdp = await page.context().newCDPSession(page);
  const lines: string[] = [
    `\n[perf attribution] ${WINDOW_MS} ms of playback per row, selected: ${SUBJECT}; ms per frame`,
    'objects | frame p50 | idle  | program |  gc  | deps (three/react/r3f) | src  | other | finish p50 (pass 2) | frame p50 (pass 2)',
  ];
  const tops: string[] = [];
  // Which GL the page actually got: SwiftShader (software) or the machine's GPU.
  await page.goto('/');
  const renderer = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    return ext ? String(gl!.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown';
  });
  lines[0] += ` — GL: ${renderer}`;
  for (const objects of SCENE ? [0] : LEVELS) {
    if (SCENE) {
      await stageScene(page);
      const roads = await skinRoads(page);
      tops.push(
        `  scene ${SCENE.replace(/^.*\//, '')}: ${roads.meshes} meshes drawn; skinned on the GPU ${roads.gpu} (${roads.gpuVerts} vertices), deformed on the CPU ${roads.cpu} (${roads.cpuVerts} vertices); ${roads.skeletons} three.js skeletons, ${roads.skeletonBones} bones posed and uploaded per frame`,
      );
    } else await stage(page, objects);
    const prof = await profileWindow(page, cdp);
    const frames = prof.run.intervals.length;
    // A bucket's share of the sampled time, times the frame: the profile spans a little more than
    // the counted frames (set-up and warm-up), so shares, not raw totals, are per frame.
    const frameP50 = p50(prof.run.intervals);
    const perFrame = (b: string) => ((prof.us.get(b) ?? 0) / Math.max(1, prof.total)) * frameP50;
    const second = await play(page, true);
    const f = (v: number) => v.toFixed(1).padStart(5);
    lines.push(
      `${String(objects).padStart(7)} | ${f(p50(prof.run.intervals))}     | ${f(perFrame('idle'))} | ${f(perFrame('program'))}   | ${f(perFrame('gc'))}| ${f(perFrame('js:deps') + perFrame('js:three') + perFrame('js:react') + perFrame('js:r3f'))}                 | ${f(perFrame('js:src'))}| ${f(perFrame('js:other'))} | ${f(p50(second.finishMs))}               | ${f(p50(second.intervals))}`,
    );
    tops.push(
      `  ${objects || 'scene'}: inclusive ms per frame: ` +
        INCLUSIVE.map(
          (k) =>
            `${k} ${(((prof.inclusive.get(k) ?? 0) / Math.max(1, prof.total)) * frameP50).toFixed(2)}`,
        ).join(' · '),
    );
    const deps = [...prof.depFns.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    tops.push(
      `  ${objects || 'scene'}: top three/React/R3F functions, self ms per frame: ` +
        deps
          .map(([k, v]) => `${k} ${((v / Math.max(1, prof.total)) * frameP50).toFixed(2)}`)
          .join(' · '),
    );
    if (SCENE) {
      const roads = await skinRoads(page);
      tops.push(
        `  scene, after the profile: ${roads.meshes} meshes drawn; skinned on the GPU ${roads.gpu} (${roads.gpuVerts} vertices), deformed on the CPU ${roads.cpu} (${roads.cpuVerts} vertices)`,
      );
    }
    const chains = [...prof.chains.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    tops.push(
      `  ${objects} objects, own-code call chains (leaf ← callers; ms per frame):\n` +
        chains
          .map(([k, v]) => `    ${((v / Math.max(1, prof.total)) * frameP50).toFixed(2)}  ${k}`)
          .join('\n'),
    );
    const tr = await traceWindow(page, cdp);
    const threads = [...tr.busy.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    const names = [...tr.byName.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14);
    tops.push(
      `  ${objects} objects, trace pass (frame p50 ${p50(tr.run.intervals).toFixed(1)}): busy ms per frame by thread: ` +
        threads.map(([k, v]) => `${k} ${v.toFixed(1)}`).join(' · '),
      `  ${objects} objects, renderer main thread by event (inclusive ms per frame): ` +
        names.map(([k, v]) => `${k} ${v.toFixed(1)}`).join(' · '),
    );
    const top = [...prof.srcFns.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    tops.push(
      `  ${objects} objects, top own-code/other functions (ms per frame): ` +
        top
          .map(([k, v]) => `${k} ${((v / Math.max(1, prof.total)) * frameP50).toFixed(2)}`)
          .join(' · '),
    );
    expect(frames, `${objects}: the window drew`).toBeGreaterThan(3);
    expect(prof.total, `${objects}: the profile sampled`).toBeGreaterThan(0);
  }
  console.log([...lines, '', ...tops].join('\n') + '\n');
});

test.afterAll(() => {
  if (SCENE) rmSync(join(process.cwd(), 'public', '__perf_attr_scene'), { force: true });
});
