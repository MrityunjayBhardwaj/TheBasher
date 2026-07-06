// layeredChannels — the NLA enumeration seam (epic #283 Phase 2).
//
// The ONE place strips + bare channels are unified into the `KeyframeChannelValue[]`
// that BOTH fold seams already consume (the render `overlayChannels` and the read
// `resolveEvaluatedParam`). A bare channel is a degenerate single-strip; a Strip
// placing an Action emits one synthetic channel value per param it touches. Because
// both seams route through here, a placed strip lights up render AND read at once
// (H40 — the one-consumer trap is closed by construction).
//
// SLICE A = a STUB: it delegates verbatim to the bare direct-channel path, so the
// empty-strip-set byte-identity anchor test (layeredChannels.byteIdentity.test.ts)
// is green from Slice A and stays the falsify anchor through C–E. Slice C replaces
// the body with the real strip enumerator (flat type-scan mirroring nodeChannels,
// R4 membership gate, track order/mute/solo, touched-domain, retime).
//
// REF: docs/NLA-DESIGN.md §3.1/§6 (Phase 2, Slices A/C); vyapti V57/V88 D2/D3;
//      krama K21; RESEARCH.md "Injection strategy (option a)".

import { directChannelValuesForTarget } from './nodeChannels';
import type { KeyframeChannelValue } from '../nodes/types';

/** Minimal node shape read here (a DagState node subset — the strip/track/channel
 *  scan universe lives in the same node table). */
interface NodeLike {
  readonly id: string;
  readonly type: string;
  readonly params?: unknown;
  readonly inputs?: Readonly<Record<string, unknown>>;
}

/**
 * Every {@link KeyframeChannelValue} driving `targetId` — bare direct channels
 * AND strip-derived synthetic channels (once Slice C lands). This is the array
 * both fold seams consume.
 *
 * STUB (Slice A): returns exactly the bare direct-channel values, so an empty
 * strip set is byte-identical by construction. Slice C prepends/merges the
 * strip-derived values here.
 */
export function layeredChannelValues(
  nodes: Readonly<Record<string, NodeLike>>,
  targetId: string,
): KeyframeChannelValue[] {
  return directChannelValuesForTarget(nodes, targetId);
}
