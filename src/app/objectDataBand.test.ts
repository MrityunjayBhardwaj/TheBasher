// The band → channel-path rule, pinned directly.
//
// This file pins the RULE in isolation. It is deliberately small: on its own it can
// only prove the function returns what it says, which is nearly a tautology. The load
// -bearing test is the R4 road in `splitKinds.roads.test.ts`, which pushes a real
// channel through the real `overlayChannels` and asserts the renderer can still SEE
// the overlaid value — that is where a wrong band reproduces the actual symptom (an
// animated param that silently freezes) rather than merely a red assertion.
//
// What this file adds on top of that: the two answers are stated once, in one place,
// so a future band's author reads the decision instead of inferring it from whichever
// hook they happened to copy.

import { describe, expect, it } from 'vitest';
import { channelPathForBand, type SplitBand } from './objectDataBand';

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
    const ALL_BANDS: Record<SplitBand, true> = { children: true, lights: true };
    for (const band of Object.keys(ALL_BANDS) as SplitBand[]) {
      expect(typeof channelPathForBand(band, 'x')).toBe('string');
    }
  });
});
