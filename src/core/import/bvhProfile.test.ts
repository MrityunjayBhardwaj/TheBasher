// readBvhProfile — the facts a clip states about itself.
//
// Every arm here is a shape a real generator produces and the repo's own fixtures
// did not: a translating joint that is NOT the root, leaves with no End Site, and
// a header whose channel count disagrees with its rows.
//
// REF: src/core/import/bvhProfile.ts; issue #790.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BvhProfileError, readBvhProfile } from './bvhProfile';

/** Root translates; one child rotates. The conventional shape. */
const ROOT_MOVES = `HIERARCHY
ROOT Hips
{
  OFFSET 0.0 1.0 0.0
  CHANNELS 6 Xposition Yposition Zposition Xrotation Yrotation Zrotation
  JOINT Spine
  {
    OFFSET 0.0 0.5 0.0
    CHANNELS 3 Xrotation Yrotation Zrotation
    End Site
    {
      OFFSET 0.0 0.5 0.0
    }
  }
}
MOTION
Frames: 3
Frame Time: 0.0333333333333333
0 1 0 0 0 0 0 5 0
0 1 1 0 0 0 0 6 0
0 1 2 0 0 0 0 7 0
`;

/**
 * A `Root` wrapper that never moves, with the translation on `Hips` — the shape a
 * real Kimodo clip has, and the one that makes "read the world path off the root"
 * silently wrong. Leaves carry no End Site, also faithful to that exporter.
 */
const HIPS_MOVES = `HIERARCHY
ROOT Root
{
  OFFSET 0 0 0
  CHANNELS 6 Xposition Yposition Zposition Zrotation Yrotation Xrotation
  JOINT Hips
  {
    OFFSET 0 100 0
    CHANNELS 6 Xposition Yposition Zposition Zrotation Yrotation Xrotation
    JOINT Spine
    {
      OFFSET 0 10 0
      CHANNELS 3 Zrotation Yrotation Xrotation
    }
  }
}
MOTION
Frames: 3
Frame Time: 0.02
0 0 0 0 0 0 0 96 0 0 0 0 0 4 0
0 0 0 0 0 0 0 96 3 0 0 0 0 5 0
0 0 0 0 0 0 0 97 6 0 0 0 0 6 0
`;

describe('the clip states its own sampling rate', () => {
  it('derives fps, frame count and duration from the header', () => {
    const p = readBvhProfile(ROOT_MOVES);
    expect(p.fps).toBeCloseTo(30, 6);
    expect(p.frames).toBe(3);
    // (frames - 1) * frameTime — the last sample sits AT the end, which is what
    // the imported clip's duration comes out as.
    expect(p.duration).toBeCloseTo(2 / 30, 6);
  });

  it('reads a rate that is not 30 — the value is the clip’s, not a default', () => {
    expect(readBvhProfile(HIPS_MOVES).fps).toBeCloseTo(50, 6);
  });
});

describe('which joint carries world translation', () => {
  it('names the root when the root is what moves', () => {
    expect(readBvhProfile(ROOT_MOVES).rootMotionJoint).toBe('Hips');
  });

  it('names Hips when the root is authored but never varies', () => {
    // The failure this exists to prevent: `Root` has six channels and looks like
    // the mover, and every one of its position values is zero for the whole clip.
    // A consumer reading the world path off joint 0 sees a character walking in
    // place — and sees it for a clip that is entirely correct.
    const p = readBvhProfile(HIPS_MOVES);
    expect(p.joints[0]).toBe('Root');
    expect(p.rootMotionJoint).toBe('Hips');
  });

  it('returns null for a clip that does not travel, rather than guessing', () => {
    const stationary = HIPS_MOVES.replace(/ 3 0 0 0 0 5 0/, ' 0 0 0 0 0 5 0').replace(
      / 97 6 0 0 0 0 6 0/,
      ' 96 0 0 0 0 0 6 0',
    );
    expect(readBvhProfile(stationary).rootMotionJoint).toBeNull();
  });

  it('enumerates joints in declaration order and skips End Site blocks', () => {
    // An End Site has an OFFSET and no CHANNELS, so counting it shifts no column
    // — but it would put an unnamed entry in the joint list and move every index
    // a caller reads back.
    expect(readBvhProfile(ROOT_MOVES).joints).toEqual(['Hips', 'Spine']);
    expect(readBvhProfile(HIPS_MOVES).joints).toEqual(['Root', 'Hips', 'Spine']);
  });
});

describe('a clip that cannot state its own rate is refused, never guessed at', () => {
  it('refuses text with no MOTION section', () => {
    expect(() => readBvhProfile('HIERARCHY\nROOT Hips\n{\n}\n')).toThrow(BvhProfileError);
  });

  it.each([
    ['Frame Time: 0', 'Frame Time: 0'],
    ['a negative frame time', 'Frame Time: -0.03'],
    ['a non-numeric frame time', 'Frame Time: NaN'],
  ])('refuses %s — it reads back as an absurd or infinite rate', (_label, line) => {
    expect(() => readBvhProfile(ROOT_MOVES.replace(/Frame Time: .*/, line))).toThrow(/Frame Time/);
  });

  it('refuses a frame count the rows do not support', () => {
    expect(() => readBvhProfile(ROOT_MOVES.replace('Frames: 3', 'Frames: 9'))).toThrow(
      /9 frames but carries 3/,
    );
  });
});

describe('against the generated-motion fixture', () => {
  const soma = readFileSync(
    resolve(process.cwd(), 'public/fixtures/anim/soma-generated.bvh'),
    'utf8',
  );

  it('the header and the rows agree on how many channels there are', () => {
    // The property the fixture did NOT have: it declared 237 channels and wrote
    // 240 values per row, so every joint after Hips read its predecessor's
    // rotation. Nothing complained — three's loader does not check, and the tests
    // over it assert names and parentage, which a channel shift does not touch.
    // readBvhProfile is now the thing that would notice, so it is asserted here.
    const declared = soma
      .slice(0, soma.indexOf('MOTION'))
      .split('\n')
      .filter((l) => l.trim().startsWith('CHANNELS'))
      .reduce((n, l) => n + Number(l.trim().split(/\s+/)[1]), 0);
    const firstRow = soma.split('MOTION')[1].split('\n')[3].trim().split(/\s+/).length;
    expect(firstRow).toBe(declared);
  });

  it('has SOMA’s Root wrapper, with the translation on Hips', () => {
    const p = readBvhProfile(soma);
    expect(p.joints).toHaveLength(78);
    expect(p.joints[0]).toBe('Root');
    expect(p.rootMotionJoint).toBe('Hips');
    expect(p.fps).toBeCloseTo(30, 9);
  });
});
