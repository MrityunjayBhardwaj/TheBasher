// #1727 — NO DEFERRED REACT STATE UPDATE INSIDE A FRAME LOOP; THE SYNCHRONOUS ONES ARE COUNTED.
//
// A `useFrame` callback runs once per drawn frame. A React state setter called from it asks React
// for a re-render every frame at React's default priority, and while the frame is busy and anything
// subscribed to the playhead keeps sending higher-priority updates, that re-render is never done:
// the keyed object freezes until playback pauses (#1726, measured by p1727-playback-under-load).
// Time-varying values belong on the drawn three.js object, written directly (#1728).
//
// Where a value has no direct write yet (a light, an editor helper, an animated colour), the update
// is committed on the spot with R3F's `flushSync(() => setX(...))`: synchronous, so nothing can
// push it back. Those are allowed but listed in SYNC, which shrinks to empty as the frame table's
// writers replace them (#1730). DEFERRED stays empty.
//
// Both censuses are EXACT, in both directions: a new setter in a frame loop reds this, and so does
// removing one without taking it off its list, so a list can only change deliberately. Each entry
// is `file :: enclosing function :: setter`, never a line number, so moving code doesn't red it.
//
// What the scan sees: every `useFrame(` call in src/ outside tests, its argument text up to the
// matching `)`, and the setters the same file declares with `const [x, setX] = useState(...)` or
// `useReducer`. A setter reached through a helper in another file is NOT seen; the two controls at
// the bottom pin what is and isn't caught.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '..');

/** Setters called from a frame loop at React's default priority. Empty since #1728. */
const DEFERRED: string[] = [];

/** Setters a frame loop commits synchronously (`flushSync`). Shrinks to empty with #1730. */
const SYNC = [
  // A keyed light: it reads its whole value (scale as brightness, position for its aim).
  'viewport/SceneFromDAG.tsx :: DirectChannelsLightR :: setPatched',
  // The two mesh overlay renderers' shared frame loop. It writes the transform directly and calls
  // this only when a field OTHER than the transform changed (an animated colour or size), or for
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

/** `{ calls, sites, syncSites }` for one file's text: how many `useFrame(` calls it makes, and
 *  each call that invokes a setter declared in the same file, as `function :: setter`: in
 *  `syncSites` when every call of it there is the whole body of `flushSync(() => ...)`. */
export function frameLoopSetters(text: string): {
  calls: number;
  sites: string[];
  syncSites: string[];
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
  let calls = 0;
  for (let i = text.indexOf('useFrame('); i !== -1; i = text.indexOf('useFrame(', i + 1)) {
    // Skip the import line and a declaration named useFrame.
    const before = text.slice(Math.max(0, i - 40), i);
    if (/import\s*\{[^}]*$|function\s*$/.test(before)) continue;
    let depth = 0;
    let end = i + 'useFrame'.length;
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
      const sync = uses.every((m) =>
        /flushSync\(\s*\(\)\s*=>\s*$/.test(body.slice(Math.max(0, m.index - 40), m.index)),
      );
      (sync ? syncSites : sites).push(`${enclosing} :: ${name}`);
    }
  }
  return { calls, sites, syncSites };
}

describe('#1727 — React state setters inside frame loops', () => {
  const files = sourceFiles(SRC);
  let calls = 0;
  const found: string[] = [];
  const foundSync: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes('useFrame(')) continue;
    const r = frameLoopSetters(text);
    calls += r.calls;
    const rel = path.relative(SRC, file).split(path.sep).join('/');
    for (const s of r.sites) found.push(`${rel} :: ${s}`);
    for (const s of r.syncSites) foundSync.push(`${rel} :: ${s}`);
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

  it('control: a setter in a frame loop is caught; one outside it, or a direct write, is not', () => {
    const caught = frameLoopSetters(`
      function Spinner() {
        const [angle, setAngle] = useState(0);
        useFrame(({ clock }) => { setAngle(clock.elapsedTime); });
        return null;
      }`);
    expect(caught).toEqual({ calls: 1, sites: ['Spinner :: setAngle'], syncSites: [] });

    const sync = frameLoopSetters(`
      function Spinner() {
        const [angle, setAngle] = useState(0);
        useFrame(({ clock }) => { flushSync(() => setAngle(clock.elapsedTime)); });
        return null;
      }`);
    expect(sync).toEqual({ calls: 1, sites: [], syncSites: ['Spinner :: setAngle'] });

    // One deferred call beside a synchronous one is deferred.
    const mixed = frameLoopSetters(`
      function Spinner() {
        const [angle, setAngle] = useState(0);
        useFrame(({ clock }) => { flushSync(() => setAngle(1)); setAngle(clock.elapsedTime); });
        return null;
      }`);
    expect(mixed).toEqual({ calls: 1, sites: ['Spinner :: setAngle'], syncSites: [] });

    const clean = frameLoopSetters(`
      import { useFrame } from '@react-three/fiber';
      function Spinner() {
        const ref = useRef(null);
        const [label, setLabel] = useState('');
        useEffect(() => setLabel('x'), []);
        useFrame(({ clock }) => { ref.current.rotation.y = clock.elapsedTime; });
        return null;
      }`);
    expect(clean).toEqual({ calls: 1, sites: [], syncSites: [] });
  });
});
