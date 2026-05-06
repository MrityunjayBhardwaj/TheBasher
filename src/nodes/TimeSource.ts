// TimeSource — the project-wide Time producer.
//
// THESIS.md §49 mandates that time enter every animation/render evaluator
// through a typed `Time` socket, never via closure or global. The evaluator
// (src/core/dag/evaluator.ts) has no concept of "current time" injected into
// pure-node hashes — pure caches by (params, inputs). So a node that wants
// to be `pure: true` cannot read `ctx.time`; it must consume Time through
// its inputs. The producer of those inputs MUST be impure so that its cache
// key (which DOES include `ctx.time` for impure nodes) flips when time
// flips, propagating a fresh hash downstream.
//
// TimeSource is that producer. It is the ONLY node in v0.5 that reads
// `ctx.time` directly. Animation, locomotion, and render-time nodes all
// wire their `time` input to a TimeSource and stay pure.
//
// Singleton convention: each project has exactly one TimeSource node, by
// convention seeded at id `time` during boot (K1 step 3).
//
// REF: THESIS.md §49, vyapti V3, krama K7.

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { TimeValue } from './types';

export const TimeSourceParams = z.object({});
export type TimeSourceParams = z.infer<typeof TimeSourceParams>;

export const TimeSourceNode: NodeDefinition<TimeSourceParams, TimeValue> = {
  type: 'TimeSource',
  version: 1,
  pure: false, // V3: time enters here; downstream pure consumers wire to its `out` socket.
  cost: 'cheap',
  paramSchema: TimeSourceParams,
  inputs: {},
  outputs: { out: { type: 'Time', cardinality: 'single' } },
  evaluate(_params, _inputs, ctx) {
    return {
      frame: ctx.time.frame,
      seconds: ctx.time.seconds,
      normalized: ctx.time.normalized,
    };
  },
};
