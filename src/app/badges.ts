// Centralised badge registry.
//
// A "badge" tags a subject with a small, filterable status. Today the only
// subject is an op in the agent diff (a #423 wrong-half write that was accepted
// but changed nothing); the design is deliberately subject-agnostic so the same
// vocabulary can later tag NODES — e.g. filter the scene tree by the badge a
// node carries. That is why badge KINDS live here in one config rather than as
// inline strings at each surface: one place to declare a kind, one place a
// future filter reads.
//
// Layering: core (src/core/dag/ops.ts) emits an OPAQUE badge-kind id on a
// `Reportable`; this app-layer registry owns how each kind renders (label,
// tone). `badgeLabel` narrows an unknown core-emitted id safely.
//
// Adding a kind: extend `BadgeKind` + `BADGES`. `badges.test.ts` walks the
// registry so a kind with no entry fails loudly.

export type BadgeKind = 'stripped-write';

export type BadgeTone = 'warning' | 'error' | 'info';

export interface BadgeContext {
  paramPath?: string;
  nodeId?: string;
  reason?: string;
}

export interface BadgeDef {
  kind: BadgeKind;
  tone: BadgeTone;
  /** Human label for one badge instance, rendered from its context. */
  label: (ctx: BadgeContext) => string;
}

export const BADGES: Record<BadgeKind, BadgeDef> = {
  'stripped-write': {
    kind: 'stripped-write',
    tone: 'warning',
    label: ({ paramPath, nodeId, reason }) =>
      `Ignored ${paramPath ?? 'write'} on ${nodeId ?? '?'}` +
      (reason ? ` — ${reason}` : '') +
      ' (changed nothing)',
  },
};

/** Render a badge label from a possibly-unknown core-emitted kind id. */
export function badgeLabel(badge: string, ctx: BadgeContext): string {
  const def = (BADGES as Record<string, BadgeDef | undefined>)[badge];
  return def ? def.label(ctx) : `Ignored ${ctx.paramPath ?? 'write'} (${badge})`;
}
