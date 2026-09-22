// #1184 — an FBX's bones are the rig the file declares, not the list one skin is weighted to.
//
// A skin lists only the bones it deforms, so reading the bone set off the first skin dropped
// every bone no mesh is weighted to — on Mixamo's samba, 15 of 67 (head top, eyes, fingertips,
// toe ends). Blender makes every `LimbNode` a bone and keeps a non-bone node that has bones
// under it as a bone too. These rows build variants of `rig-two-skins.fbx` (Hips, Spine above
// it, two skins over both; declares centimetres, so the file's 1 reads as 0.01 m).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { parseFbx } from './fbx';
import { specToThreeSkeleton } from './threeAdapter';
import type { BoneSpec } from '../../nodes/types';

const readText = (name: string): string =>
  readFileSync(resolve(process.cwd(), 'public/fixtures/anim', name), 'utf8');
const readBinary = (name: string): ArrayBuffer => {
  const buf = readFileSync(resolve(process.cwd(), 'public/fixtures/anim', name));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
};
const TWO_SKINS = readText('rig-two-skins.fbx');

interface ExtraModel {
  readonly id: number;
  readonly name: string;
  readonly type: 'LimbNode' | 'Null';
  readonly at: readonly [number, number, number];
  /** 0 = the scene root; 100 = Hips; 200 = Spine. */
  readonly parent: number;
}

/** `rig-two-skins.fbx` with more Model nodes, no skin weighted to any of them, connected in order. */
function withModels(models: readonly ExtraModel[]): ArrayBuffer {
  const anchor = '\tGeometry: 3000';
  const link = '\tC: "OO",200,100\n';
  if (!TWO_SKINS.includes(anchor) || !TWO_SKINS.includes(link))
    throw new Error('fixture no longer has the shape this builds on');
  const blocks = models
    .map(
      (m) => `\tModel: ${m.id}, "Model::${m.name}", "${m.type}" {
\t\tVersion: 232
\t\tProperties70:  {
\t\t\tP: "Lcl Translation", "Lcl Translation", "", "A",${m.at.join(',')}
\t\t}
\t}
`,
    )
    .join('');
  const links = models.map((m) => `\tC: "OO",${m.id},${m.parent}\n`).join('');
  const text = TWO_SKINS.replace(anchor, blocks + anchor).replace(link, link + links);
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

const bonesOf = (buf: ArrayBuffer): readonly BoneSpec[] =>
  parseFbx(buf, 'rig').skeletonParams.bones;
const shape = (bones: readonly BoneSpec[]) =>
  bones.map((b) => [b.name, b.parent >= 0 ? bones[b.parent].name : null]);

/** Every row's skeleton: the root first, alone, and every parent before its children. */
function expectWellFormed(bones: readonly BoneSpec[]): void {
  expect(bones[0].parent).toBe(-1);
  expect(bones.filter((b) => b.parent < 0)).toHaveLength(1);
  bones.forEach((b, i) => expect(b.parent).toBeLessThan(i));
}

describe('parseFbx — the bones are the rig, not one skin', () => {
  it('a bone no mesh is weighted to comes in, under its parent, with its offset', () => {
    const bones = bonesOf(
      withModels([
        { id: 600, name: 'HeadTop_End', type: 'LimbNode', at: [0, 0.25, 0], parent: 200 },
      ]),
    );
    expect(shape(bones)).toEqual([
      ['Hips', null],
      ['Spine', 'Hips'],
      ['HeadTop_End', 'Spine'],
    ]);
    expect(bones[2].position[1]).toBeCloseTo(0.0025, 9);
    expectWellFormed(bones);
  });

  it("a bone's children come in the loader's order — ascending FBX node ID — whatever the file's order", () => {
    // The loader builds its node map with `for (const id in Objects.Model)`, and integer keys
    // iterate ascending (`FBXLoader.js`, `parseModels`). The retarget aligns a bone by the
    // first child it maps (#1186), so this order is behaviour until that stops being true.
    const low = (name: string): ExtraModel => ({
      id: 600,
      name,
      type: 'LimbNode',
      at: [1, 0, 0],
      parent: 200,
    });
    const high = (name: string): ExtraModel => ({
      id: 700,
      name,
      type: 'LimbNode',
      at: [-1, 0, 0],
      parent: 200,
    });
    const names = (models: ExtraModel[]) => bonesOf(withModels(models)).map((b) => b.name);
    expect(names([low('Zed'), high('Arm')])).toEqual(['Hips', 'Spine', 'Zed', 'Arm']);
    expect(names([high('Arm'), low('Zed')])).toEqual(['Hips', 'Spine', 'Zed', 'Arm']);
    expect(names([low('Arm'), high('Zed')])).toEqual(['Hips', 'Spine', 'Arm', 'Zed']);
  });

  it('a second skeleton stays out, whichever comes first in the file', () => {
    const prop: ExtraModel[] = [
      { id: 600, name: 'Prop', type: 'LimbNode', at: [5, 0, 0], parent: 0 },
      { id: 700, name: 'PropTip', type: 'LimbNode', at: [0, 1, 0], parent: 600 },
    ];
    const bones = bonesOf(withModels(prop));
    expect(shape(bones)).toEqual([
      ['Hips', null],
      ['Spine', 'Hips'],
    ]);
    // Connected before Hips too: the rig is the skin's, not the first one found.
    const hipsLink = '\tC: "OO",100,0\n';
    const propLink = '\tC: "OO",600,0\n';
    const text = new TextDecoder().decode(withModels(prop));
    expect(text.includes(hipsLink) && text.includes(propLink)).toBe(true);
    const propFirst = text.replace(hipsLink, '').replace(propLink, propLink + hipsLink);
    expect(propFirst.indexOf(propLink)).toBeLessThan(propFirst.indexOf(hipsLink));
    expect(shape(bonesOf(new TextEncoder().encode(propFirst).buffer as ArrayBuffer))).toEqual([
      ['Hips', null],
      ['Spine', 'Hips'],
    ]);
  });

  it('a Null between two bones is a bone; a Null with no bone under it is not', () => {
    const bones = bonesOf(
      withModels([
        { id: 600, name: 'Mid', type: 'Null', at: [0, 0.5, 0], parent: 200 },
        { id: 700, name: 'Tip', type: 'LimbNode', at: [0, 0.5, 0], parent: 600 },
        { id: 800, name: 'Socket', type: 'Null', at: [0, 0.1, 0], parent: 200 },
      ]),
    );
    expect(shape(bones)).toEqual([
      ['Hips', null],
      ['Spine', 'Hips'],
      ['Mid', 'Spine'],
      ['Tip', 'Mid'],
    ]);
    expect(bones[2].position[1]).toBeCloseTo(0.005, 9);
    expect(bones[3].position[1]).toBeCloseTo(0.005, 9);
    expectWellFormed(bones);
  });
});

describe('parseFbx — a Null inside a chain, from a Blender export', () => {
  // `null-in-chain.fbx`: a 3-bone chain `Hips → Mid → Tip` exported by Blender, with `Mid`
  // patched from `LimbNode` to a `Null` with no cluster (Blender's own `parse_fbx` +
  // `encode_bin`). Blender 5.1.1 re-imports it as one armature, `Hips → Mid → Tip`, with Mid's
  // head 1 and Tip's 1.5 file units from Hips' (import_fbx.py:2511-2513, the fake bone). The
  // transform ABOVE Hips (the armature node) is #1190's, so heads are compared relative to Hips.
  const bones = bonesOf(readBinary('null-in-chain.fbx'));

  it("keeps the chain Blender keeps, with Blender's distances from Hips", () => {
    expect(shape(bones)).toEqual([
      ['Hips', null],
      ['Mid', 'Hips'],
      ['Tip', 'Mid'],
    ]);
    expectWellFormed(bones);
    const { bones: rig } = specToThreeSkeleton(bones);
    rig[0].updateMatrixWorld(true);
    const heads = rig.map((b) => new Vector3().setFromMatrixPosition(b.matrixWorld));
    const fromHips = (i: number) => heads[i].distanceTo(heads[0]);
    expect(fromHips(1)).toBeCloseTo(0.01, 9);
    expect(fromHips(2)).toBeCloseTo(0.015, 9);
  });
});
