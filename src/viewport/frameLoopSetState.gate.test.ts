// #1727 — NO REACT STATE SETTER INSIDE A FRAME LOOP, EXCEPT THE ONES LISTED HERE.
//
// A `useFrame` callback runs once per drawn frame. A React state setter called from it asks React
// for a re-render every frame at React's default priority, and while the frame is busy and anything
// subscribed to the playhead keeps sending higher-priority updates, that re-render is never done:
// the keyed object freezes until playback pauses (#1726, measured by p1727-playback-under-load).
// Time-varying values belong on the drawn three.js object, written directly (#1728).
//
// The census is EXACT, in both directions: a new setter in a frame loop reds this, and so does
// removing one without taking it off the list, so the list can only shrink deliberately. Each entry
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

/** Shrinks to empty as #1728 moves each of these to direct writes. */
const ALLOWED = [
  'viewport/SceneFromDAG.tsx :: DirectChannelsLightR :: setPatched',
  // The two mesh overlay renderers' shared frame loop. It writes the transform directly and calls
  // this only when a field OTHER than the transform changed (an animated colour or size), or for
  // a kind that keeps its transform in the drawn value (a light Object, a character).
  'viewport/SceneFromDAG.tsx :: useOverlayDraw :: setSource',
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

/** `{ calls, sites }` for one file's text: how many `useFrame(` calls it makes, and each call
 *  that invokes a setter declared in the same file, as `function :: setter`. */
export function frameLoopSetters(text: string): { calls: number; sites: string[] } {
  // A Set: two components in one file may each name their setter `setPatched`.
  const setters = new Set(
    [
      ...text.matchAll(
        /const\s*\[\s*\w*\s*,\s*(\w+)\s*\]\s*=\s*(?:React\.)?use(?:State|Reducer)\b/g,
      ),
    ].map((m) => m[1]),
  );
  const sites: string[] = [];
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
      if (new RegExp(`\\b${name}\\s*\\(`).test(body)) sites.push(`${enclosing} :: ${name}`);
    }
  }
  return { calls, sites };
}

describe('#1727 — React state setters inside frame loops', () => {
  const files = sourceFiles(SRC);
  let calls = 0;
  const found: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes('useFrame(')) continue;
    const r = frameLoopSetters(text);
    calls += r.calls;
    const rel = path.relative(SRC, file).split(path.sep).join('/');
    for (const s of r.sites) found.push(`${rel} :: ${s}`);
  }

  it('scanned the frame loops it should have (a scan that found none examined nothing)', () => {
    expect(files.length).toBeGreaterThan(500);
    expect(calls).toBeGreaterThanOrEqual(20);
  });

  it('the setters called from a frame loop are exactly the listed ones', () => {
    expect([...found].sort()).toEqual([...ALLOWED].sort());
  });

  it('control: a setter in a frame loop is caught; one outside it, or a direct write, is not', () => {
    const caught = frameLoopSetters(`
      function Spinner() {
        const [angle, setAngle] = useState(0);
        useFrame(({ clock }) => { setAngle(clock.elapsedTime); });
        return null;
      }`);
    expect(caught).toEqual({ calls: 1, sites: ['Spinner :: setAngle'] });

    const clean = frameLoopSetters(`
      import { useFrame } from '@react-three/fiber';
      function Spinner() {
        const ref = useRef(null);
        const [label, setLabel] = useState('');
        useEffect(() => setLabel('x'), []);
        useFrame(({ clock }) => { ref.current.rotation.y = clock.elapsedTime; });
        return null;
      }`);
    expect(clean).toEqual({ calls: 1, sites: [] });
  });
});
