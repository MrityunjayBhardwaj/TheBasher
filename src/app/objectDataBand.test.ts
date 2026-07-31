// The band → channel-path rule, pinned directly.
//
// This file pins the RULE in isolation. It is deliberately small: on its own it can
// only prove the function returns what it says, which is nearly a tautology. The load
// -bearing test is the R4 road in `splitKinds.roads.test.ts`, which pushes a real
// channel through the real `overlayChannels` and asserts the renderer can still SEE
// the overlaid value — that is where a wrong band reproduces the actual symptom (an
// animated param that silently freezes) rather than merely a red assertion.
//
// What this file adds on top of that: every band's answer is stated once, in one place,
// so a future band's author reads the decision instead of inferring it from whichever
// hook they happened to copy.
//
// #387 added a SECOND question and a THIRD band, and the two arrived together for a
// reason. `renderReachForBand` asks whether the thing an overlay lands on is what the
// renderer reads — a question the first two bands answered so obviously that nobody had
// to pose it, and the camera answers NO. Its pin below is an equality per band rather
// than an exhaustiveness check, because the `never` closes against a new band and not
// against a wrong answer for an existing one.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../test-utils/sourceScan';
import {
  channelPathForBand,
  OVERLAY_BANDS,
  renderReachForBand,
  type SplitBand,
} from './objectDataBand';

describe('channelPathForBand', () => {
  it('rebases under `data.` for the children band — ObjectR reads value.data.*', () => {
    expect(channelPathForBand('children', 'material.base.color')).toBe('data.material.base.color');
    expect(channelPathForBand('children', 'size')).toBe('data.size');
  });

  it('leaves the path FLAT for the lights band — the recomposed LightValue is flat', () => {
    // The #386 R2 bug in one line: had this returned `data.intensity`, the light
    // renderer (which reads `value.intensity`) would never see the animated value.
    expect(channelPathForBand('lights', 'intensity')).toBe('intensity');
    expect(channelPathForBand('lights', 'color')).toBe('color');
  });

  it('is a pure transform — same inputs, same output, no allocation on the flat band', () => {
    const path = 'intensity';
    // Identity-preserving on the no-rebase band, so callers can keep memo stability
    // by skipping the object copy when the path is unchanged.
    expect(channelPathForBand('lights', path)).toBe(path);
  });

  it('every SplitBand member is exercised here, not just the two we remember', () => {
    // Keyed by the union rather than written as `const bands: SplitBand[] = [...]`,
    // because a widened union still accepts a two-element array and the list would go
    // stale in silence.
    //
    // Be clear about what this does and does not buy, though: `tsconfig.app.json`
    // EXCLUDES `src/**/*.test.ts`, so nothing typechecks this file in CI and the missing
    // key would not be a build error. The real compile-time guard is the `never` in
    // channelPathForBand itself and in renderedValueForBand — both live in files that ARE
    // typechecked, and both were confirmed to red when a third band is added. This is the
    // runtime companion to those, not a substitute for them.
    const ALL_BANDS: Record<SplitBand, true> = { children: true, lights: true, camera: true };
    for (const band of Object.keys(ALL_BANDS) as SplitBand[]) {
      expect(typeof channelPathForBand(band, 'x')).toBe('string');
    }
  });

  it('leaves the path FLAT for the camera band — both camera structs are flat', () => {
    // The recomposed CameraValue is `value.fov`, and the pose resolver writes
    // `pose[path]`. Neither is nested, so there is nothing to rebase.
    expect(channelPathForBand('camera', 'fov')).toBe('fov');
    expect(channelPathForBand('camera', 'far')).toBe('far');
  });
});

// ── renderReachForBand — the guard the `never` is NOT ────────────────────────────
//
// `renderReachForBand`'s exhaustiveness check closes against a NEW band. It does not
// close against a WRONG ANSWER for an existing one, and the difference matters here
// more than anywhere else in this file:
//
//   Flip the camera's arm to 'evaluated-value'. It compiles. R4 in
//   `splitKinds.roads.test.ts` then routes the camera down the value road, where the
//   flat recomposed CameraValue happily accepts an overlay at `fov` — so R4 PASSES,
//   while the actual question ("does an animated fov move the rendered camera?") was
//   never asked. The band would have chosen WHETHER the pose road runs, which is
//   exactly what the descriptor's no-skip rule forbids.
//
// A road cannot guard its own dispatch. So every band's reach is stated ONCE, here, as
// an equality. Falsified by flipping the camera arm and watching THIS test red while
// R4 stays green — that contrast is the whole reason the pin exists.
describe('renderReachForBand', () => {
  it('states each band’s reach as an equality, because the never cannot', () => {
    expect(renderReachForBand('children')).toBe('evaluated-value');
    expect(renderReachForBand('lights')).toBe('evaluated-value');
    // The camera's evaluated value is a render-cache-key ingredient; the picture comes
    // from a CameraPose that activeCamera.ts builds from RAW params.
    expect(renderReachForBand('camera')).toBe('params-resolver');
  });

  it('answers for every band, keyed by the union rather than a remembered list', () => {
    const ALL_BANDS: Record<SplitBand, true> = { children: true, lights: true, camera: true };
    for (const band of Object.keys(ALL_BANDS) as SplitBand[]) {
      expect(['evaluated-value', 'params-resolver']).toContain(renderReachForBand(band));
    }
  });
});

// ── The honest mark on channelPathForBand's camera arm ───────────────────────────
//
// The camera arm returns identity and is CORRECT, but no production code passes
// 'camera' to it: the camera's overlay is applied by `resolveCameraPoseAt`, not by the
// scene-child band's four hooks. An unreached arm documented only by a comment is
// decoration — it reads as coverage and cannot fail. This gate turns the claim into a
// mechanism: it reds the day someone wires a camera through the value overlay, which is
// precisely the day the arm stops being unreached and its answer starts mattering.
//
// Scoped exactly like the retire-a-kind gate, and for the same measured reasons: the
// TRACKED file list (a gate red locally and green in CI gets switched off), non-test
// `src` only, and comments stripped first — this very file, and objectDataBand.ts's own
// header, discuss `channelPathForBand('camera', …)` in prose.
describe('the camera arm of channelPathForBand is unreached, and that is asserted', () => {
  const REPO_ROOT = join(__dirname, '..', '..');
  /** A literal first argument to `channelPathForBand`. */
  const CALL_RE = /\bchannelPathForBand\s*\(\s*['"`]([a-zA-Z-]+)['"`]/g;

  function productionSources(): string[] {
    const out = execFileSync('git', ['ls-files', '-z', 'src'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    return out
      .split('\0')
      .filter((p) => /\.tsx?$/.test(p))
      .filter((p) => !/\.test\.tsx?$/.test(p));
  }

  function literalBandArgs(): { file: string; line: number; band: string }[] {
    const hits: { file: string; line: number; band: string }[] = [];
    for (const file of productionSources()) {
      const src = stripComments(readFileSync(join(REPO_ROOT, file), 'utf8'));
      src.split('\n').forEach((text, i) => {
        for (const m of text.matchAll(CALL_RE)) hits.push({ file, line: i + 1, band: m[1] });
      });
    }
    return hits;
  }

  it('no production call site passes the camera band', () => {
    const camera = literalBandArgs().filter((h) => h.band === 'camera');
    expect(
      camera.map((h) => `${h.file}:${h.line}`),
      'a production site now overlays a camera through the VALUE path. The camera does ' +
        'not render from its evaluated value — check renderReachForBand before deciding ' +
        'this is correct, and update this gate deliberately if it is',
    ).toEqual([]);
  });

  // 🔴 THE POSITIVE CONTROL EXPIRED, AND IT SAID SO — #522.
  //
  // It used to assert the scan found at least four literal band arguments, because the band
  // WAS a literal at each of the four viewport hooks. #522 threads it through two shared
  // hooks instead, so the scan's real subject dropped to zero and this control went red
  // while the assertion above stayed green — which is exactly the job it was written for: an
  // empty subject is how a gate quietly stops biting, and without this control the camera
  // assertion would have kept passing for free and nobody would have known.
  //
  // Re-anchored STRICTER rather than relaxed. The camera can no longer reach the overlay
  // road at the TYPE (`OverlayBand`), which a text scan cannot go blind to, and the two
  // remaining facts a runtime test can still hold are pinned below. The scan and its
  // negative control stay: they still catch a NEW literal call site, which is how a future
  // road would most likely reintroduce the camera.
  it('POSITIVE CONTROL — the overlay road cannot be asked for the camera band', () => {
    // The bands the value overlay may be asked for, as data rather than as a habit. A
    // future edit adding 'camera' here reddens this; passing 'camera' without adding it is
    // a compile error at the hook.
    expect([...OVERLAY_BANDS]).toEqual(['children', 'lights']);
    // …and it is a strict SUBSET of the bands that exist, or the exclusion means nothing.
    const allBands: SplitBand[] = ['children', 'lights', 'camera'];
    expect(OVERLAY_BANDS.length).toBeLessThan(allBands.length);
    for (const band of OVERLAY_BANDS) expect(allBands).toContain(band);
  });

  it('the scan itself still has teeth, measured against a source that DOES call it', () => {
    // The real subject is now empty by construction, so the detector is exercised against
    // the shape it exists to catch. This is the same reasoning as the negative control
    // below, on the other side.
    const live = "channelPathForBand('children', p); channelPathForBand('lights', p);";
    expect([...stripComments(live).matchAll(CALL_RE)].map((m) => m[1])).toEqual([
      'children',
      'lights',
    ]);
  });

  it('NEGATIVE CONTROL — a camera call would be seen, and a commented one would not', () => {
    // The detector, run against synthetic sources, because its real subject is empty by
    // construction and an empty subject proves nothing about the detector.
    const live = "const p = channelPathForBand('camera', 'fov');";
    const prose = "// nothing calls channelPathForBand('camera', …) today";
    expect([...stripComments(live).matchAll(CALL_RE)].map((m) => m[1])).toEqual(['camera']);
    expect([...stripComments(prose).matchAll(CALL_RE)]).toEqual([]);
  });
});
