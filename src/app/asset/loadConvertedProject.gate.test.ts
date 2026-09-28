// #1216 — every LOADED project reaches the DAG store through `hydrateLoadedProject`, which converts
// its clone-road characters first. A loader that hydrates on its own would put a saved clone
// character back on the screen as it was, silently. This census reads boot.ts and fails on a
// hydrate of anything but a freshly built seed outside that one function, and on a loader that
// never calls it.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** The name of the function each match sits in: the nearest `function NAME(` above it. */
function enclosingFunctions(source: string, pattern: RegExp): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(pattern)) {
    const before = source.slice(0, match.index);
    const names = [...before.matchAll(/function\s+(\w+)\s*\(/g)];
    out.push(names.length > 0 ? names[names.length - 1][1] : '<top>');
  }
  return out;
}

/** Functions that hydrate something other than a freshly built seed, outside the one door. */
function strayHydrates(source: string): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(/\.hydrate\(([^)]*)/g)) {
    const [fn] = enclosingFunctions(source.slice(0, match.index! + 1), /\.$/g);
    const arg = match[1].trim();
    if (fn === 'hydrateLoadedProject') continue;
    if (arg.startsWith('buildDefaultDagState(')) continue;
    // A seed built in the same function: `seed.state` / a project the function composed itself.
    const body = source.slice(source.lastIndexOf(`function ${fn}(`), match.index);
    if (
      /buildDefaultProject\(\)/.test(body) &&
      !/loadProject\(|bundleToProject\(|ioDuplicateProject\(/.test(body)
    )
      continue;
    out.push(fn);
  }
  return out;
}

/** Functions that load or unbundle a project and never hand it to the one door. */
function loadersSkippingTheDoor(source: string): string[] {
  const loaders = new Set(
    enclosingFunctions(source, /\b(loadProject|bundleToProject|ioDuplicateProject)\(/g),
  );
  return [...loaders].filter((fn) => {
    const start = source.lastIndexOf(`function ${fn}(`);
    const next = source.indexOf('\nexport ', start + 1);
    const body = source.slice(start, next === -1 ? undefined : next);
    return !/hydrateLoadedProject\(/.test(body);
  });
}

const BOOT = readFileSync('src/app/boot.ts', 'utf8');

describe('a loaded project reaches the store only through hydrateLoadedProject', () => {
  it('boot.ts: no stray hydrate, and every loader calls the door', () => {
    expect(strayHydrates(BOOT)).toEqual([]);
    expect(loadersSkippingTheDoor(BOOT)).toEqual([]);
    // The loaders the census found — so a rename that hides one from it shows here.
    expect(
      new Set(enclosingFunctions(BOOT, /\b(loadProject|bundleToProject|ioDuplicateProject)\(/g)),
    ).toEqual(new Set(['boot', 'switchProject', 'duplicateCurrentProject', 'importSceneBundle']));
  });

  it('control: a loader hydrating on its own is caught', () => {
    const bad = `export async function switchProject(id) {
  const project = await loadProject(storage, id);
  useDagStore.getState().hydrate({ nodes: project.state.nodes });
}`;
    expect(strayHydrates(bad)).toEqual(['switchProject']);
    expect(loadersSkippingTheDoor(bad)).toEqual(['switchProject']);
  });
});
