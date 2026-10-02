// #1449 — an FBX with nothing in it reaches our reader instead of crashing three's loader.
//
// Blender 5.1.1's default FBX export of an empty scene (probe `q27_fbx_nothing_fixture.py`) writes a
// `Connections` section with no connection in it. three r169 read `.connections` off it unchecked and
// threw `Cannot read properties of undefined (reading 'forEach')`, which is the text an import would
// have shown. Our patch to the loader (`patches/three+0.169.0.patch`) reads the empty section as none.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';

const FILE = resolve(process.cwd(), 'src/core/import/__fixtures__/nothing-blender-default.fbx');

describe('#1449 — an FBX of an empty scene', () => {
  it('parses to a scene with nothing in it', () => {
    const buf = readFileSync(FILE);
    const group = new FBXLoader().parse(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
      '',
    );
    expect(group.children).toHaveLength(0);
    expect(group.animations).toHaveLength(0);
  });
});
