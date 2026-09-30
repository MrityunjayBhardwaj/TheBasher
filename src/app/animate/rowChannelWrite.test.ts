// rowChannelWrite — the diamond rule (#912). The row resolver and the mute / solo ops are pinned
// where their rows live: `layerCurveMute.test.ts` and `computedSourceRows.test.ts`.
//
// This file was `clipRowMint.test.ts`; its clip-row, clone-bone and embedded-clip cases went with
// the clone road (#1053).

import { describe, expect, it } from 'vitest';
import { diamondActivation } from './rowChannelWrite';

describe('#912 — what a diamond activation means', () => {
  it('ALT with nothing authored REFUSES — it must never fall through and key', () => {
    // The whole bug in one row: the old gate sent exactly this case to the keying
    // path.
    expect(diamondActivation(true, 'none')).toBe('refuse-nothing-authored');
    expect(diamondActivation(true, 'none')).not.toBe('key');
  });

  it('ALT on a param that HAS an authored channel still deletes — no regression', () => {
    expect(diamondActivation(true, 'on-key')).toBe('delete');
    expect(diamondActivation(true, 'animated')).toBe('delete');
  });

  it('a plain click with nothing authored keys', () => {
    expect(diamondActivation(false, 'none')).toBe('key');
    expect(diamondActivation(false, 'animated')).toBe('key');
  });

  it("a plain click ON a key still deletes it — Blender's toggle", () => {
    expect(diamondActivation(false, 'on-key')).toBe('delete');
  });

  it('ALT never keys, for ANY authored state — the property, not three examples', () => {
    // The three rows above are instances; this is the rule they are instances
    // of. A future state added to the enum has to satisfy it too, which is the
    // half that a table of examples cannot express.
    for (const st of ['none', 'animated', 'on-key'] as const) {
      expect(diamondActivation(true, st)).not.toBe('key');
    }
  });
});
