// #1736 — a scene file is written and read in parts, so the whole file never has to be one string.
//
// The browser's limit is 536,870,888 characters; a real 595 MB shot could not be opened. The tests
// pass a small `maxString` so the same rule runs at kilobyte scale: a file several times the limit,
// made of values each under it, must save and open, and a single value over it must be named.

import { describe, expect, it } from 'vitest';
import {
  BundleSyntaxError,
  LONGEST_STRING,
  parseSceneBundleBytes,
  sceneBundleParts,
} from './sceneBundleText';

const enc = new TextEncoder();
const bytes = (s: string) => enc.encode(s);
const joined = (parts: string[]) => parts.join('');

/** A bundle shaped like a saved scene, with text that trips a naive scanner. */
function bundle(assetCount = 3, assetSize = 50) {
  const assets: Record<string, string> = {};
  for (let i = 0; i < assetCount; i++) assets[`assets/b${i}.glb`] = 'QUJD'.repeat(assetSize / 4);
  return {
    formatVersion: 23,
    bundleVersion: 1,
    id: 'p_1',
    name: 'alley “mecha” run ✓ {not a brace} "quoted" \\ back',
    exportedAt: 1730000000000,
    state: {
      nodes: {
        n_box: { id: 'n_box', type: 'Object', params: { label: '}]{["\\"' } },
        'odd "key" ✓': { id: 'x', type: 'Note', params: { text: 'héllo wörld 日本語 🎬' } },
      },
      outputs: { scene: { node: 'n_scene', socket: 'out' } },
    },
    assets,
  };
}

describe('#1736 sceneBundleParts / parseSceneBundleBytes', () => {
  it('writes exactly the JSON one stringify would, and reads it back', () => {
    const b = bundle();
    const text = joined(sceneBundleParts(b));
    expect(text).toBe(JSON.stringify(b));
    expect(parseSceneBundleBytes(bytes(text))).toEqual(b);
  });

  it('reads a file written by the old one-string save, whitespace and a BOM included', () => {
    const b = bundle();
    const pretty = '﻿' + JSON.stringify(b, null, 2) + '\n';
    expect(parseSceneBundleBytes(bytes(pretty))).toEqual(b);
  });

  it('reads a legacy DAG-only file with no assets', () => {
    const { assets: _assets, ...dagOnly } = bundle();
    void _assets;
    expect(parseSceneBundleBytes(bytes(JSON.stringify(dagOnly)))).toEqual(dagOnly);
  });

  it('a file several times the limit, made of values under it, saves and opens', () => {
    const max = 400;
    const b = bundle(12, 300);
    const parts = sceneBundleParts(b, { maxString: max });
    const text = joined(parts);
    // The point of the test: the file as one string would not fit.
    expect(text.length).toBeGreaterThan(5 * max);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(max);
    expect(parseSceneBundleBytes(bytes(text), { maxString: max })).toEqual(b);
  });

  it('a single asset past the limit is named, on save and on open', () => {
    const max = 400;
    const b = bundle(2, 1200);
    expect(() => sceneBundleParts(b, { maxString: max })).toThrow(/asset assets\/b0\.glb/);
    expect(() => parseSceneBundleBytes(bytes(JSON.stringify(b)), { maxString: max })).toThrow(
      /asset assets\/b0\.glb/,
    );
  });

  it('a graph past the limit is named', () => {
    const max = 100;
    const b = bundle(1, 8);
    expect(() => parseSceneBundleBytes(bytes(JSON.stringify(b)), { maxString: max })).toThrow(
      /scene's state/,
    );
  });

  it('bytes that are not one JSON object are a syntax error', () => {
    for (const bad of ['', 'nope', '{"a":1', '{"a":1}{', '{"a" 1}', '{"assets":{"x":"un', '[1]']) {
      expect(() => parseSceneBundleBytes(bytes(bad)), bad).toThrow(BundleSyntaxError);
    }
  });

  it('the default limit is the browser’s longest string', () => {
    expect(LONGEST_STRING).toBe(536_870_888);
  });
});
