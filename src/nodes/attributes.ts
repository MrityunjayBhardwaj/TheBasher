// Typed, named, per-element geometry attributes — the vocabulary half of #395 (ns-1).
//
// ── WHAT THIS MODULE IS, AND WHAT IT DELIBERATELY IS NOT ──────────────────────────────
//
// This is the DECLARATION only: the domain identifier, the value types, and the shape a
// named attribute takes. No node writes one yet and no consumer reads one yet — that is
// the next two slices (#634 material at FACE, #635 UVs at CORNER). Declaring the
// vocabulary in its own commit is what makes those slices reviewable as behaviour
// changes rather than as behaviour-plus-a-new-type-system.
//
// The root defect this closes: `GeometryDescriptor` (types.ts) is four build recipes and
// two references, with NOWHERE to put an attribute. Material and UVs therefore ride as
// SIBLING fields on `EvaluatedMesh`, one value each, which is why a per-face material
// assignment is not merely unimplemented but unrepresentable.
//
// ── WHERE AN ATTRIBUTE LIVES, AND WHY NOT ON THE HANDLE ───────────────────────────────
//
// Never on `GeometryRef`. That handle is a LOOKUP KEY into one process-wide content-keyed
// cache — ten identical boxes resolve to ONE `BufferGeometry` (pinned by
// `geometrySharing.gate.test.ts`), so anything hung off the handle is hung off something
// several objects hold at once. An attribute set belongs to the VALUE BEHIND the handle.
// See the note at `GeometryRef`'s declaration; this module does not restate it.
//
// ── THE DOMAIN IS TWO THINGS WEARING ONE NAME ─────────────────────────────────────────
//
// A domain identifier plays two roles with opposite requirements, and collapsing them
// costs either a migration or an unchecked switch:
//
//   DATA — what a stored/round-tripped attribute says it is. Must be OPEN: a closed union
//          baked into persisted data makes adding `curve` a project-format migration, and
//          a value that fails to round-trip is data loss. Hence `DomainId = string`.
//   CODE — what a dispatch site must handle. Must be CLOSED: `KNOWN_DOMAINS` +
//          `KnownDomain`, consumed with a `never` default at every switch, so adding a
//          member breaks the compiler at every site that has no answer.
//
// Both roles, no collapse. Storage speaks `DomainId`; dispatch speaks `KnownDomain`.
//
// HONEST WEAKNESS, stated rather than discovered: this is rung 2 of the unrepresentability
// ladder, not rung 3. A fixture can construct an attribute at a domain no dispatch site
// handles, and nothing in the type system stops it — `attributes.gate.test.ts` is what
// makes the escape hatch countable instead of invisible. Rung 3 would cost the migration
// the open identifier exists to avoid.
//
// ── THE FOUR MEMBERS ARE MEASURED, NOT CHOSEN ─────────────────────────────────────────
//
// Blender: `material_index` is a FACE-domain attribute and `UVMap` is a CORNER-domain
// one — read off the reference, not inferred from what would be convenient here. Point
// and edge complete the polygonal set. `corner` is the per-face-vertex domain (Blender's
// name; Houdini calls the same element a vertex).
//
// REF: docs/NORTH-STAR.md §7 Phase 1; .anvi/project_management/phases/ns-1-attribute-domains/PLAN.md §5.4;
//      src/nodes/types.ts (`GeometryRef` — why not on the handle);
//      src/app/geometryRegistry.ts (`availabilityOf` — the sibling closed-with-`never` dispatch);
//      issues #395, #628, #633, #634, #635.

/**
 * A domain as DATA — open, round-trippable, never narrowed on load.
 *
 * An identifier outside {@link KNOWN_DOMAINS} is storable and must survive a
 * save/load cycle unchanged; what it may NOT do is reach a dispatch site without an
 * explicit answer. Use {@link isKnownDomain} to cross from data into code.
 */
export type DomainId = string;

/**
 * A domain as CODE — closed, exhaustive, the switch subject.
 *
 * Adding a member here is deliberately expensive: every `switch` that closes on
 * {@link KnownDomain} with a `never` default stops compiling until it declares an answer,
 * and `attributes.gate.test.ts` reds naming the domain that has none.
 */
export const KNOWN_DOMAINS = ['point', 'edge', 'face', 'corner'] as const;

export type KnownDomain = (typeof KNOWN_DOMAINS)[number];

/** The one crossing from the open data identifier to the closed code one. */
export function isKnownDomain(domain: DomainId): domain is KnownDomain {
  return (KNOWN_DOMAINS as readonly string[]).includes(domain);
}

/**
 * The value types an attribute may carry.
 *
 * Minimal on purpose: `int` covers `material_index`, `float2` covers UVs, and the two
 * remaining members are the ones a polygonal model cannot express itself without. A type
 * that has no producer is a type whose storage rules nothing has ever exercised.
 */
export const ATTRIBUTE_TYPES = ['int', 'float', 'float2', 'float3'] as const;

export type AttributeType = (typeof ATTRIBUTE_TYPES)[number];

/** Components per element. Closed by a `never` — a new type must declare its width here. */
export function componentsOf(type: AttributeType): number {
  switch (type) {
    case 'int':
    case 'float':
      return 1;
    case 'float2':
      return 2;
    case 'float3':
      return 3;
    default: {
      const unreachable: never = type;
      throw new Error(`componentsOf: undeclared attribute type ${String(unreachable)}`);
    }
  }
}

/** The backing store of an attribute's values, flattened component-major. */
export type AttributeArray = Int32Array | Float32Array;

/**
 * One named attribute's values at one domain.
 *
 * `count` is in ELEMENTS, never components — a corner-domain `float2` over 12 corners has
 * `count: 12` and `data.length === 24`. The two disagreeing is the defect
 * {@link attributeLengthMismatch} names, and it is the only way a well-typed attribute can
 * still be wrong.
 */
export interface AttributeData {
  readonly domain: DomainId;
  readonly type: AttributeType;
  readonly count: number;
  readonly data: AttributeArray;
}

/**
 * The attributes a geometry value carries, keyed by name (`material_index`, `UVMap`, …).
 *
 * Names are data, exactly as domains are: this record is deliberately not a closed struct
 * with a field per known attribute, because that shape cannot hold the user-authored
 * attribute the model exists to make possible.
 */
export type AttributeSet = Readonly<Record<string, AttributeData>>;

/**
 * The element counts of a mesh's topology — the denominator every domain resolves against.
 *
 * This is what makes a domain identifier MEAN something rather than label something: an
 * attribute at a domain must carry exactly as many elements as that domain has.
 */
export interface MeshElementCounts {
  readonly points: number;
  readonly edges: number;
  readonly faces: number;
  readonly corners: number;
}

/**
 * How many elements a domain has, for a given topology. The first dispatch site on
 * {@link KnownDomain}, closed by a `never`.
 */
export function elementCountFor(domain: KnownDomain, counts: MeshElementCounts): number {
  switch (domain) {
    case 'point':
      return counts.points;
    case 'edge':
      return counts.edges;
    case 'face':
      return counts.faces;
    case 'corner':
      return counts.corners;
    default: {
      const unreachable: never = domain;
      throw new Error(`elementCountFor: undeclared domain ${String(unreachable)}`);
    }
  }
}

/**
 * The one way a well-typed attribute is still malformed: `data.length` disagrees with
 * `count * componentsOf(type)`.
 *
 * Returns a message naming both numbers, or `null` when the attribute is well formed —
 * a shape a caller can assert on without re-deriving the arithmetic.
 */
export function attributeLengthMismatch(attribute: AttributeData): string | null {
  const expected = attribute.count * componentsOf(attribute.type);
  if (attribute.data.length === expected) return null;
  return `attribute at domain '${attribute.domain}' declares count=${attribute.count} of ${attribute.type} (${expected} components) but carries ${attribute.data.length}`;
}
