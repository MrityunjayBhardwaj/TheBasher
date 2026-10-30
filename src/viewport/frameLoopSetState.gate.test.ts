// #1727 — NO DEFERRED REACT STATE UPDATE INSIDE A FRAME LOOP; THE SYNCHRONOUS ONES ARE COUNTED.
//
// A `useFrame` callback runs once per drawn frame. A React state setter called from it asks React
// for a re-render every frame at React's default priority, and while the frame is busy and anything
// subscribed to the playhead keeps sending higher-priority updates, that re-render is never done:
// the keyed object freezes until playback pauses (#1726, measured by p1727-playback-under-load).
// Time-varying values belong on the drawn three.js object, written directly (#1728).
//
// Where a value has no direct write yet (a light, an editor helper, an animated colour), the update
// is committed synchronously, so nothing can push it back. Since #1730 the animated renderers have
// no frame loop of their own: each registers a tick with the frame evaluator (`useFrameTick`), and a
// tick hands its update back (`return () => setX(...)`) for the evaluator to commit with the
// frame's others in one `flushSync`. Those are listed in COMMITTED. A `useFrame` that still commits
// on its own with `flushSync(() => setX(...))` is listed in SYNC. DEFERRED stays empty, and a
// setter CALLED inside a tick (not handed back) counts as deferred: the tick runs in the frame loop.
//
// Both censuses are EXACT, in both directions: a new setter in a frame loop reds this, and so does
// removing one without taking it off its list, so a list can only change deliberately. Each entry
// is `file :: enclosing function :: setter`, never a line number, so moving code doesn't red it.
//
// What the scan sees: every `useFrame(` and `useFrameTick(` call in src/ outside tests, its argument
// text up to the matching `)`, and the setters the same file declares with `const [x, setX] = useState(...)` or
// `useReducer`. A setter reached through a helper in another file is NOT seen; the two controls at
// the bottom pin what is and isn't caught.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '..');

/** Setters called from a frame loop at React's default priority. Empty since #1728. */
const DEFERRED: string[] = [];

/** Setters a `useFrame` commits on its own with `flushSync`. Empty since #1730. */
const SYNC: string[] = [];

/** Setters a frame-evaluator tick hands back for the evaluator's one commit per frame (#1730). */
const COMMITTED = [
  // A keyed light: it reads its whole value (scale as brightness, position for its aim).
  'viewport/SceneFromDAG.tsx :: DirectChannelsLightR :: setPatched',
  // The two mesh overlay renderers' shared tick. It writes the transform directly and hands this
  // back only when a field OTHER than the transform changed (an animated colour or size), or for
  // a kind that keeps its transform in the drawn value (a light Object, a character).
  'viewport/SceneFromDAG.tsx :: useOverlayDraw :: setSource',
  // The camera frustum and light helpers following the playhead.
  'viewport/usePlayheadFollow.ts :: usePlayheadFollow :: setValue',
];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
      continue;
    }
    if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry) || /^tmp-/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

/** `{ calls, sites, syncSites, committedSites }` for one file's text: how many `useFrame(` and
 *  `useFrameTick(` calls it makes, and each call that invokes a setter declared in the same file,
 *  as `function :: setter`: in `syncSites` when it is a `useFrame` and every call of the setter
 *  there is the whole body of `flushSync(() => ...)`; in `committedSites` when it is a
 *  `useFrameTick` and every one is handed back as `return () => ...`; otherwise in `sites`. */
export function frameLoopSetters(text: string): {
  calls: number;
  sites: string[];
  syncSites: string[];
  committedSites: string[];
} {
  // A Set: two components in one file may each name their setter `setPatched`.
  const setters = new Set(
    [
      ...text.matchAll(
        /const\s*\[\s*\w*\s*,\s*(\w+)\s*\]\s*=\s*(?:React\.)?use(?:State|Reducer)\b/g,
      ),
    ].map((m) => m[1]),
  );
  const sites: string[] = [];
  const syncSites: string[] = [];
  const committedSites: string[] = [];
  let calls = 0;
  for (const m of text.matchAll(/\buseFrame(Tick)?\(/g)) {
    const i = m.index;
    const tick = m[1] === 'Tick';
    // Skip the import line and a declaration named useFrame / useFrameTick.
    const before = text.slice(Math.max(0, i - 40), i);
    if (/import\s*\{[^}]*$|function\s*$/.test(before)) continue;
    let depth = 0;
    let end = i + m[0].length - 1;
    for (; end < text.length; end++) {
      if (text[end] === '(') depth++;
      else if (text[end] === ')' && --depth === 0) break;
    }
    calls++;
    const body = text.slice(i, end + 1);
    const enclosing = [...text.slice(0, i).matchAll(/function\s+(\w+)/g)].pop()?.[1] ?? '?';
    for (const name of setters) {
      const uses = [...body.matchAll(new RegExp(`\\b${name}\\s*\\(`, 'g'))];
      if (uses.length === 0) continue;
      const preceded = (re: RegExp) =>
        uses.every((u) => re.test(body.slice(Math.max(0, u.index - 40), u.index)));
      const site = `${enclosing} :: ${name}`;
      if (tick) (preceded(/return\s*\(\)\s*=>\s*$/) ? committedSites : sites).push(site);
      else (preceded(/flushSync\(\s*\(\)\s*=>\s*$/) ? syncSites : sites).push(site);
    }
  }
  return { calls, sites, syncSites, committedSites };
}

describe('#1727 — React state setters inside frame loops', () => {
  const files = sourceFiles(SRC);
  let calls = 0;
  const found: string[] = [];
  const foundSync: string[] = [];
  const foundCommitted: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes('useFrame(') && !text.includes('useFrameTick(')) continue;
    const r = frameLoopSetters(text);
    calls += r.calls;
    const rel = path.relative(SRC, file).split(path.sep).join('/');
    for (const s of r.sites) found.push(`${rel} :: ${s}`);
    for (const s of r.syncSites) foundSync.push(`${rel} :: ${s}`);
    for (const s of r.committedSites) foundCommitted.push(`${rel} :: ${s}`);
  }

  it('scanned the frame loops it should have (a scan that found none examined nothing)', () => {
    expect(files.length).toBeGreaterThan(500);
    expect(calls).toBeGreaterThanOrEqual(20);
  });

  it('no frame loop calls a setter at the default priority', () => {
    expect([...found].sort()).toEqual([...DEFERRED].sort());
  });

  it('the setters a frame loop commits synchronously are exactly the listed ones', () => {
    expect([...foundSync].sort()).toEqual([...SYNC].sort());
  });

  it('the setters a frame-evaluator tick hands back are exactly the listed ones', () => {
    expect([...foundCommitted].sort()).toEqual([...COMMITTED].sort());
  });

  it('control: a setter in a frame loop is caught; one outside it, or a direct write, is not', () => {
    const caught = frameLoopSetters(`
      function Spinner() {
        const [angle, setAngle] = useState(0);
        useFrame(({ clock }) => { setAngle(clock.elapsedTime); });
        return null;
      }`);
    expect(caught).toEqual({
      calls: 1,
      sites: ['Spinner :: setAngle'],
      syncSites: [],
      committedSites: [],
    });

    const sync = frameLoopSetters(`
      function Spinner() {
        const [angle, setAngle] = useState(0);
        useFrame(({ clock }) => { flushSync(() => setAngle(clock.elapsedTime)); });
        return null;
      }`);
    expect(sync).toEqual({
      calls: 1,
      sites: [],
      syncSites: ['Spinner :: setAngle'],
      committedSites: [],
    });

    // One deferred call beside a synchronous one is deferred.
    const mixed = frameLoopSetters(`
      function Spinner() {
        const [angle, setAngle] = useState(0);
        useFrame(({ clock }) => { flushSync(() => setAngle(1)); setAngle(clock.elapsedTime); });
        return null;
      }`);
    expect(mixed).toEqual({
      calls: 1,
      sites: ['Spinner :: setAngle'],
      syncSites: [],
      committedSites: [],
    });

    const clean = frameLoopSetters(`
      import { useFrame } from '@react-three/fiber';
      function Spinner() {
        const ref = useRef(null);
        const [label, setLabel] = useState('');
        useEffect(() => setLabel('x'), []);
        useFrame(({ clock }) => { ref.current.rotation.y = clock.elapsedTime; });
        return null;
      }`);
    expect(clean).toEqual({ calls: 1, sites: [], syncSites: [], committedSites: [] });

    // A tick that hands its setter back is committed by the evaluator; one that calls it is not.
    const handed = frameLoopSetters(`
      function Spinner() {
        const [angle, setAngle] = useState(0);
        useFrameTick(id, () => { if (moved) return () => setAngle(1); });
        return null;
      }`);
    expect(handed).toEqual({
      calls: 1,
      sites: [],
      syncSites: [],
      committedSites: ['Spinner :: setAngle'],
    });
    const called = frameLoopSetters(`
      function Spinner() {
        const [angle, setAngle] = useState(0);
        useFrameTick(id, () => { setAngle(1); });
        return null;
      }`);
    expect(called).toEqual({
      calls: 1,
      sites: ['Spinner :: setAngle'],
      syncSites: [],
      committedSites: [],
    });
  });
});
