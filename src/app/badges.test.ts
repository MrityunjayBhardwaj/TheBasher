// Registry sweep for the centralised badge config. A badge kind registered with
// no label (or missing entirely) would ship a surfaced status the DiffBar cannot
// render — the same class of silent hole the split's inspector-sections sweep
// guards. Walk the registry and guard-the-guard so it can't go vacuous.

import { describe, expect, it } from 'vitest';
import { BADGES, badgeLabel, type BadgeKind } from './badges';

describe('badge registry', () => {
  it('every registered badge kind renders a non-empty, context-bearing label', () => {
    const kinds = Object.keys(BADGES) as BadgeKind[];
    expect(kinds.length).toBeGreaterThan(0); // guard-the-guard: a vacuous walk fails
    for (const kind of kinds) {
      const def = BADGES[kind];
      expect(def.kind).toBe(kind);
      const label = def.label({
        paramPath: 'material.base.color',
        nodeId: 'n1',
        reason: 'not a param',
      });
      expect(label.length).toBeGreaterThan(0);
      // The label must actually use its context, not be a static string.
      expect(label).toContain('material.base.color');
    }
  });

  it('badgeLabel narrows an unknown core-emitted kind without throwing', () => {
    const label = badgeLabel('some-future-kind', { paramPath: 'radius' });
    expect(label).toContain('radius');
  });
});
