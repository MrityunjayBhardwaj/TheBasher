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

/**
 * THE ATOM CLASSES A SCOPE MAY BE RESOLVED AT TODAY (#714).
 *
 * `face` ONLY, and the reason is arithmetic rather than taste: a face count is derivable
 * from a descriptor and the other three are not. `point` needs a new count derivation and
 * has 24 seam-split points on a box; `edge` has no buffer at all.
 *
 * ── WHY THIS IS A TYPE AND NOT THE MODULE CONSTANT IT REPLACED ────────────────────────
 *
 * It was `const SCOPE_DOMAIN: KnownDomain = 'face'` — one module-private value that every
 * resolution silently agreed with. Two things were wrong with that, and only the second is
 * about this file. The first: an operator had no way to SAY which class its scope named, so
 * every operator's answer was face whether or not its author had thought about it. The
 * second: widening it was an assignment, and an assignment reds nothing — the sites that
 * would then be wrong go on compiling.
 *
 * As a type the widening is a DETECTOR. Adding `'point'` here stops compiling every
 * `never`-closed switch over a {@link ScopeDomain} until it declares an arm, which is the
 * list of sites that owe an answer, produced by the compiler rather than by a census. And
 * an operator declaring `domain: 'point'` today fails at its own declaration, because
 * `'point'` is not assignable — instead of registering cleanly and quietly behaving as face.
 *
 * ⚠️ THE LIST AND THE TYPE ARE ONE DECLARATION, exactly as `KNOWN_DOMAINS` and
 * {@link KnownDomain} are: the const is the source and the type is read off it, so widening
 * is a single edit and the two halves have no way to drift. The `satisfies readonly
 * KnownDomain[]` is what stops it naming a class the domain vocabulary does not have —
 * deleting a member from `KNOWN_DOMAINS` reds this rather than leaving it pointing at a
 * domain nothing else believes in.
 *
 * 🔴 THERE IS DELIBERATELY NO REGISTRATION-TIME REFUSAL TO MATCH, and the reason is a
 * measurement rather than an oversight. `chain`'s four fields are refused at runtime because
 * the test tier is type-blind and omitting one fails SILENTLY. Omitting a domain does not:
 * it arrives at `componentCountOf` as `undefined` and comes straight back out of that
 * function's `never` default as `componentSelection: undeclared domain undefined`, naming
 * the resolver and the calling test in the stack. Measured while this landed — 88 test-tier
 * call sites went red at once, every one of them pointing at itself. A second refusal would
 * buy an earlier throw for a case the type already closes in production, and would cost
 * `core/dag/registry.ts` a value import into `nodes/`, which the layering row in
 * `componentScopeChannel.gate.test.ts` pins as an exact set precisely so a third file has to
 * argue for itself. This one cannot.
 *
 * 🔴 THIS IS THE *CODE* HALF ONLY. `attributes.ts` draws the split this leans on: storage
 * speaks the open `DomainId` so a foreign class round-trips, dispatch speaks a closed set so
 * every site answers for every member. A scope's domain is dispatch — it is chosen by an
 * operator's declaration, never read off a file — so the closed half is the right one here.
 */
export const SCOPE_DOMAINS = ['face'] as const satisfies readonly KnownDomain[];

export type ScopeDomain = (typeof SCOPE_DOMAINS)[number];

/**
 * ── HOW AN OPERATOR DECLARES ITS CLASS, AND WHY EACH ONE DECLARES ITS OWN ─────────────
 *
 * Stated here, at the type, because it is ONE FACT and it was spelled five times (#680).
 * Every scoped operator carries `const SCOPE_DOMAIN: ScopeDomain = 'face'` and a copy of
 * this reasoning; the VALUE stays copied, deliberately, and the reasoning moved here.
 *
 * 🔑 FIVE OPERATORS CHOOSING `'face'` IS FIVE DECISIONS THAT HAPPEN TO AGREE. That is the
 * whole reason #714 replaced the single module-private constant with a per-operator
 * declaration, and collapsing the five back into one shared value would undo it: the day an
 * operator scopes at a different class, a shared constant is the thing that silently gives
 * it the wrong one. So the duplication of the VALUE is correct and must survive; only the
 * explanation was redundant.
 *
 * Each operator's `const` is declared once and read twice — the `chain` declaration hands it
 * to the evaluator, which resolves the selection at it, and the builder call in `evaluate`
 * hands the same value to the descriptor, which folds it into the cache key. One `const` for
 * both because they must not be able to disagree: a selection resolved at one class and a
 * geometry keyed at another is a mesh built from the wrong set, and both would draw.
 *
 * ⚠️ NOT `selection.domain`, DELIBERATELY, though at runtime it is the same value. A
 * `ComponentSelection` is a general value and its `domain` is the wide {@link KnownDomain} —
 * the memoisation rows construct selections at classes no operator can declare. Reading it
 * there would need a cast back down to {@link ScopeDomain}, and a cast is exactly the thing
 * that keeps compiling when the two sets stop coinciding.
 */

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
 * An empty backing array of the SAME CLASS as `like`, `length` components long.
 *
 * Closed by a `never`, for the same reason {@link componentsOf} is: a new member of
 * {@link AttributeArray} must come here and say how to allocate it. The alternative — a
 * two-arm `instanceof` ternary with the second arm as the fallthrough — compiles unchanged
 * when the union grows and silently allocates the wrong class, which for a numeric buffer
 * means truncation or a precision change with nothing to red (#696).
 *
 * It takes an EXEMPLAR rather than a type tag on purpose. A caller copying values out of an
 * existing attribute wants the class its source actually uses, not the class its declared
 * `type` implies — those two are allowed to disagree, and a helper keyed on the tag would
 * quietly "correct" the disagreement by truncating floats into an `Int32Array`.
 */
export function emptyLike(like: AttributeArray, length: number): AttributeArray {
  if (like instanceof Int32Array) return new Int32Array(length);
  if (like instanceof Float32Array) return new Float32Array(length);
  const unreachable: never = like;
  throw new Error(`emptyLike: undeclared attribute array ${String(unreachable)}`);
}

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
 * The face-domain attribute naming which material SLOT each face uses. Blender's spelling,
 * kept verbatim so an importer and an exporter agree with the reference rather than with us.
 *
 * ⚠️ The bare string also appears in the glTF importer, where it means an index into the
 * glTF DOCUMENT's material array — a different concept entirely. A census on the string
 * reports the union of the two; census the module.
 */
export const MATERIAL_INDEX = 'material_index';

/**
 * The corner-domain UV attribute. Blender's default name for the first UV layer, kept
 * verbatim for the same reason `material_index` is.
 *
 * CORNER, not point: a UV seam is exactly a place where two faces meeting at one point
 * disagree about where they are in texture space, so a per-point layout cannot express one.
 */
export const UV_MAP = 'UVMap';

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
