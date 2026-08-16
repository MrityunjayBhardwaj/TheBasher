// #633 (ns-1) — the domain census: every KNOWN domain has an answer at every dispatch site,
// and every exemption is counted rather than assumed.
//
// ── WHY A GATE AND NOT JUST THE COMPILER ──────────────────────────────────────────────
//
// `attributes.ts` splits the domain identifier in two: OPEN as data (`DomainId = string`,
// so a fifth domain never costs a project-format migration) and CLOSED as code
// (`KnownDomain`, consumed with a `never` default so a switch without an answer does not
// compile). The compiler half is the stronger mechanism and it does most of the work.
//
// What it cannot do is make the OPEN half safe. Two holes it structurally cannot see:
//
//   1. A dispatch site that iterates `KNOWN_DOMAINS` at runtime — a lookup table, a
//      record built by hand — has no `never` position for the compiler to reject. It just
//      returns `undefined` for the new member and the caller reads a missing answer as a
//      zero.
//   2. `npm run typecheck` runs against `tsconfig.app.json`, which EXCLUDES every
//      `*.test.ts`. A dispatch answered only in a fixture is invisible to it.
//
// So the exhaustiveness claim is made here, at runtime, by PROBING each registered site
// with each known domain — plus a source-level remainder check, because a census whose
// subject list is hand-maintained reports clean the moment someone adds a site and
// forgets the list.
//
// ── THE ESCAPE HATCH IS COUNTED, NOT FLOORED ──────────────────────────────────────────
//
// A dispatch site may legitimately have no answer for a domain (an edge-domain answer in a
// face-only consumer, say). That is declared in `DOMAIN_NOT_APPLICABLE` with a reason and
// asserted EXACTLY — the list is compared whole, not by length bound — so an exemption can
// never be added silently and a shrinking list cannot pass by accident.
//
// REF: src/nodes/attributes.ts (the subject);
//      .anvi/project_management/phases/ns-1-attribute-domains/PLAN.md §5.4;
//      tools/gates/sourceFiles.ts (the shared enumeration);
//      src/app/registryDoors.gate.test.ts (the remainder-check technique this reuses);
//      issues #395, #633.

import { describe, expect, it } from 'vitest';
import { sourceFiles } from '../../tools/gates/sourceFiles';
import { stripComments } from '../test-utils/sourceScan';
import {
  ATTRIBUTE_TYPES,
  KNOWN_DOMAINS,
  attributeLengthMismatch,
  componentsOf,
  elementCountFor,
  isKnownDomain,
  type AttributeData,
  type KnownDomain,
  type MeshElementCounts,
} from './attributes';
import { componentCountOf } from './componentSelection';
import type { GeometryDescriptor } from './types';

/** A twelve-face box — the descriptor the second dispatch site is probed against. */
const BOX_DESCRIPTOR: GeometryDescriptor = { kind: 'box', size: [1, 1, 1] };

/** A topology with four DISTINCT counts, so a site answering the wrong domain is visible. */
const COUNTS: MeshElementCounts = { points: 8, edges: 12, faces: 6, corners: 24 };

/** A site that dispatches on the CLOSED domain type, and how to ask it for an answer. */
interface DispatchSite {
  /** `src/`-relative module, matching what the remainder scan below reports. */
  readonly module: string;
  /** The dispatching export, named so a red says which function has the hole. */
  readonly what: string;
  /** Ask for this domain's answer. Throws, or returns `undefined`, when there is none. */
  readonly probe: (domain: KnownDomain) => unknown;
}

const DISPATCH_SITES: readonly DispatchSite[] = [
  {
    module: 'src/nodes/attributes.ts',
    what: 'elementCountFor',
    probe: (domain) => elementCountFor(domain, COUNTS),
  },
  {
    // ns-2 (#607) — the second consumer of the closed half, and the one that made the
    // remainder check below earn its keep: this module was caught the moment it existed.
    module: 'src/nodes/componentSelection.ts',
    what: 'componentCountOf',
    probe: (domain) => componentCountOf(domain, BOX_DESCRIPTOR),
  },
];

/**
 * Declared exemptions — asserted EXACTLY below.
 *
 * 🔴 THIS LIST WAS EMPTY UNTIL ns-2, AND THE THREE ENTRIES ARE A DEFERRAL, NOT A
 * NOT-APPLICABLE. A component selection at `point`, `edge` or `corner` is a perfectly
 * sensible thing to want; what is missing is a way to COUNT those elements from a
 * descriptor, which is the same arithmetic that decided ns-2 ships `face` alone. Written
 * here rather than left implicit, because a census whose exemptions carry no reason is a
 * list of things nobody has to justify again.
 */
const DOMAIN_NOT_APPLICABLE: readonly {
  readonly module: string;
  readonly what: string;
  readonly domain: KnownDomain;
  readonly reason: string;
}[] = [
  {
    module: 'src/nodes/componentSelection.ts',
    what: 'componentCountOf',
    domain: 'point',
    reason:
      'a point count is not derivable from a descriptor — a box tessellates to 24 seam-split points, not 8, so the number cannot be read off the params (ns-2 D4)',
  },
  {
    module: 'src/nodes/componentSelection.ts',
    what: 'componentCountOf',
    domain: 'edge',
    reason: 'there is no edge buffer on a built geometry, so there is nothing to count',
  },
  {
    module: 'src/nodes/componentSelection.ts',
    what: 'componentCountOf',
    domain: 'corner',
    reason:
      'a corner count follows the point count and inherits its problem; it is deferred with `point`',
  },
];

/** The module that DECLARES the vocabulary is not a consumer of it. */
const DECLARING_MODULE = 'src/nodes/attributes.ts';

describe('#633 domain census — every known domain has an answer at every dispatch site', () => {
  it('pins the known set, so adding a domain forces this file to be read', () => {
    // Not a restatement of the type: this list is what the two cases below iterate, and a
    // domain added to `attributes.ts` alone would otherwise be censused against itself.
    expect([...KNOWN_DOMAINS]).toEqual(['point', 'edge', 'face', 'corner']);
  });

  it('every registered dispatch site answers every known domain', () => {
    const missing: string[] = [];

    for (const site of DISPATCH_SITES) {
      for (const domain of KNOWN_DOMAINS) {
        const exempt = DOMAIN_NOT_APPLICABLE.some(
          (e) => e.module === site.module && e.what === site.what && e.domain === domain,
        );
        if (exempt) continue;

        let answer: unknown;
        try {
          answer = site.probe(domain);
        } catch (err) {
          missing.push(`${site.module} ${site.what}: domain '${domain}' threw — ${String(err)}`);
          continue;
        }
        if (answer === undefined) {
          missing.push(`${site.module} ${site.what}: domain '${domain}' has no answer`);
        }
      }
    }

    expect(missing).toEqual([]);
  });

  it('answers the domain it was asked for, not merely some number', () => {
    // A site returning a constant would satisfy the case above. The four counts differ, so
    // the mapping itself is pinned.
    expect(elementCountFor('point', COUNTS)).toBe(8);
    expect(elementCountFor('edge', COUNTS)).toBe(12);
    expect(elementCountFor('face', COUNTS)).toBe(6);
    expect(elementCountFor('corner', COUNTS)).toBe(24);
  });

  it('counts the not-applicable exemptions EXACTLY', () => {
    // Exact, not a floor. An exemption is how a hole gets a permanent excuse, so the set is
    // pinned by (module, what, domain) and every entry is re-checked below against the
    // registered sites and the known domains.
    expect(DOMAIN_NOT_APPLICABLE.map((e) => `${e.module} ${e.what} ${e.domain}`)).toEqual([
      'src/nodes/componentSelection.ts componentCountOf point',
      'src/nodes/componentSelection.ts componentCountOf edge',
      'src/nodes/componentSelection.ts componentCountOf corner',
    ]);

    // Should one ever be added: it must name a REGISTERED site and a KNOWN domain, or the
    // exemption exempts nothing and the hole it hides stays open.
    for (const exemption of DOMAIN_NOT_APPLICABLE) {
      expect(
        DISPATCH_SITES.some((s) => s.module === exemption.module && s.what === exemption.what),
      ).toBe(true);
      expect(isKnownDomain(exemption.domain)).toBe(true);
      expect(exemption.reason.length).toBeGreaterThan(0);
    }
  });

  it('leaves no unclassified remainder — every module naming the closed type is registered', () => {
    // The census above is only as honest as `DISPATCH_SITES`. A module that mentions
    // `KnownDomain` or iterates `KNOWN_DOMAINS` is dispatching on the domain by definition,
    // so it must be registered here or the list has silently narrowed.
    const registered = new Set(DISPATCH_SITES.map((s) => s.module));
    const remainder = sourceFiles()
      .filter(([path]) => path !== DECLARING_MODULE)
      .filter(([, src]) => /\bKnownDomain\b|\bKNOWN_DOMAINS\b/.test(stripComments(src)))
      .map(([path]) => path)
      .filter((path) => !registered.has(path));

    expect(remainder).toEqual([]);
  });
});

describe('#633 the domain identifier is open as DATA and closed as CODE', () => {
  it('crosses from open to closed at exactly one place', () => {
    for (const domain of KNOWN_DOMAINS) expect(isKnownDomain(domain)).toBe(true);
    expect(isKnownDomain('curve')).toBe(false);
    expect(isKnownDomain('')).toBe(false);
  });

  it('carries an unknown domain unchanged rather than narrowing it on the way in', () => {
    // The whole reason the data identifier is a string: a value that fails to round-trip is
    // data loss, and a fifth domain must not cost a project-format migration.
    const foreign: AttributeData = {
      domain: 'curve',
      type: 'float',
      count: 3,
      data: new Float32Array([0, 1, 2]),
    };
    expect(foreign.domain).toBe('curve');
    expect(isKnownDomain(foreign.domain)).toBe(false);
  });
});

describe('#633 attribute value types', () => {
  it('declares a width for every type', () => {
    for (const type of ATTRIBUTE_TYPES) {
      expect(componentsOf(type)).toBeGreaterThan(0);
    }
    expect(componentsOf('int')).toBe(1);
    expect(componentsOf('float2')).toBe(2);
    expect(componentsOf('float3')).toBe(3);
  });

  it('names the mismatch between declared element count and carried components', () => {
    const uvs: AttributeData = {
      domain: 'corner',
      type: 'float2',
      count: 3,
      data: new Float32Array([0, 0, 1, 0, 0, 1]),
    };
    expect(attributeLengthMismatch(uvs)).toBeNull();

    const short: AttributeData = { ...uvs, data: new Float32Array([0, 0, 1, 0]) };
    const message = attributeLengthMismatch(short);
    expect(message).toContain('count=3');
    expect(message).toContain('float2');
    expect(message).toContain('4');
  });
});
