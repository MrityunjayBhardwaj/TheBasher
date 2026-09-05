// #458 — the ONE inspector section-body dispatcher.
//
// An inspector section renders two things: zero or more CUSTOM controls (a
// curve's point rows, a camera's lens block, the modifier stack…) and the
// generic ParamRows for the params that route into it. Which controls a
// section gets was written out TWICE — once in the main-node block and once in
// LinkedDataSections (the "Object Data" tab that renders a split Object's data
// half) — and the second copy carried exactly one of the arms. So a data node
// declaring any other custom section rendered an EMPTY section, with typecheck
// and the unit suite green; only a browser catches it. That is the bug this
// file removes: both sites now read this table, so a control cannot exist on
// one road and silently no-op on the other.
//
// TWO PROPERTIES ARE LOAD-BEARING — do not weaken either:
//
// 1. THE TABLE IS TYPE-FREE. Every predicate asks what a node OWNS, never what
//    it IS. `SectionCtx` deliberately does not carry the node type, so a
//    `type === 'PerspectiveCamera'` gate cannot be written here even by
//    accident. This is not tidiness: the split retires fused types, so a gate
//    naming one is a section that renders empty the day the kind splits — the
//    very failure above, reintroduced by its own fix. Where a section is
//    genuinely polymorphic (`material` has three possible controls) a
//    discriminator picks WHICH; nothing here decides WHETHER by identity.
//    Declaring the section IS the assertion of ownership: a node that declares
//    `camera` owns camera params, whatever it is called.
//
// 2. ONE TABLE BACKS BOTH THE RENDER AND THE GUARD. `sectionRendersCustomControl`
//    is the predicate the registry test asks ("does every declared section
//    actually render something?"). It reads this same table, so the guard
//    cannot pass on a table the UI does not use.
//
// The control COMPONENTS are not imported here. Seven of them are private to
// NPanel.tsx, so importing them would make this module and NPanel a cycle.
// Instead the caller supplies a `SectionControlRenderers` map, which is a
// `Record<ControlKey, …>` — exhaustive, so a control added to this table
// without a renderer is a COMPILE error rather than another empty section.
//
// REF: docs/UNIFICATION-PRINCIPLES.md (the possession principle and why it is
// also what survives a subgraph UI); src/app/inspectorSections.ts (`SectionId`,
// `paramToSection`); #458, prerequisite for #387.

import { Fragment, type ReactNode } from 'react';
import { z } from 'zod';
import { getNodeType } from '../core/dag/registry';
import type { Node } from '../core/dag/types';
import type { SectionId } from './inspectorSections';

/** What a section body is rendered against.
 *
 *  Two ids, not one. A split object's params live on its DATA half while its
 *  pose lives on the Object, so a control whose value spans the split (the
 *  camera's focus distance is `|position − lookAt|` — lens params on the data
 *  half, pose on the Object) needs both. Guessing one fails SILENTLY, because a
 *  poseless node resolves to a fallback rather than an error. The precedent is
 *  `bareChannelNodesForSubject(nodes, subjectId, dataId)`.
 *
 *  There is deliberately NO node type here — see property 1 in the header.
 */
export type SectionCtx = {
  /** The node whose params these rows and controls author: the DATA half for a
   *  linked data section, the selected node everywhere else. */
  paramsNodeId: string;
  /** The node that POSES it — the selected Object. Equal to `paramsNodeId` for
   *  a node that is not the linked half of a split. */
  objectNodeId: string;
  /** `paramsNodeId`'s params. */
  params: Readonly<Record<string, unknown>>;
  /** "Does this node own a param under `key`?" — asked of the node's declared
   *  SCHEMA first, then its live params. Reading the params object alone is not
   *  a statement of ownership: zod defaults materialize only when the node is
   *  created (loading a project re-parses the generic node shape, not each
   *  type's param schema), and an `.optional()` param never materializes at
   *  all. `MaterialOverride.slotIndex` is exactly that — asking the instance
   *  would hide the slot selector until a slot was chosen, which is the control
   *  you choose it with. */
  ownsParam: (key: string) => boolean;
  /** "Does this node declare an INPUT SOCKET under `key`?" — the edge-side twin of
   *  `ownsParam`, read off the node type's declared `inputs` (#921).
   *
   *  Added because a control can be owned by what a node TAKES rather than by what it
   *  stores: the bone-map editor belongs to a node that accepts a bone map over an
   *  edge, and that node's own params are just a name. Without this the only way to
   *  ask was `whenDeclared`, which hands the control to every node declaring the
   *  section — the channels included — and `sectionRendersCustomControl` correctly
   *  refuses that. Still possession, never identity: it asks the DECLARATION, so it
   *  stays true through a rename and false for a node that merely resembles one. */
  ownsInput: (key: string) => boolean;
  /** Whether Apply-Transform would accept `objectNodeId`. Resolved by the
   *  caller through the shared `canApplyTransform` predicate so the control is
   *  offered exactly when the dispatcher would accept it. */
  canApplyTransform: boolean;
};

/** Names the control a table row renders. The renderer map is keyed on this,
 *  so the union is what makes "declared but never wired" a compile error. */
export type ControlKey =
  | 'slotSelector'
  | 'gltfMaterialEditor'
  | 'gltfMaterialReadout'
  | 'sceneEnvironment'
  | 'cameraLens'
  | 'modifierStack'
  | 'materialStack'
  | 'materialLink'
  | 'constraintStack'
  | 'driverStack'
  | 'curvePoints'
  | 'channelExtend'
  | 'channelModifiers'
  | 'boneMap'
  | 'applyTransform'
  | 'setOrigin'
  | 'objectSlots';

export type SectionControl = {
  key: ControlKey;
  /** Possession, never identity. */
  applies: (ctx: SectionCtx) => boolean;
  /** `before` renders above the generic rows, `after` below them. */
  placement: 'before' | 'after';
  /** This control authors the WHOLE section — suppress every generic row. The
   *  params still route to the section (that is what keeps them out of the
   *  unrouted bucket); the control owns their presentation. */
  suppressesAllRows?: boolean;
  /** Param keys this control owns — omitted from the generic rows so they do
   *  not double-render beneath it. Scoped to the section rather than applied
   *  globally: `points` routes only to `curve` and the extend keys only to
   *  `animate`, so this is identical today and strictly tighter for any future
   *  node that happens to reuse one of the names. */
  omitRowKeys?: readonly string[];
};

/** A section whose control renders whenever the section is declared. */
const whenDeclared = () => true;

/** #178 S4 — a GltfChild that captured OpenPBR materials at import gets the
 *  EDITABLE lobe editor; one with none (a pre-#178 save, an empty bone) and the
 *  whole-asset GltfAsset keep the read-only readout. */
function hasCapturedMaterials(ctx: SectionCtx): boolean {
  const m = (ctx.params as { materials?: unknown }).materials;
  return Array.isArray(m) && m.length > 0;
}

/**
 * Every section's custom controls, in render order.
 *
 * EXHAUSTIVE over `SectionId` rather than `Partial<…>`: `SectionId` is a closed
 * union, so a new section id reddens the build here instead of quietly getting
 * no entry. An empty array is the explicit statement "this section is plain
 * param rows".
 */
export const SECTION_CONTROLS: Record<SectionId, readonly SectionControl[]> = {
  // Phase 151 / #376 — bake TRS into a BakedMesh. Asked through the shared
  // canApplyTransform predicate so offer == accept.
  // #228 Slice D — Set Origin to Geometry, for a node whose origin is its own
  // `pivot` row above (a Group today).
  transform: [
    { key: 'applyTransform', applies: (c) => c.canApplyTransform, placement: 'after' },
    { key: 'setOrigin', applies: (c) => c.ownsParam('pivot'), placement: 'after' },
  ],
  mesh: [],
  // v0.6 #2 (#178 W6) — the per-submesh slot selector, for a node that
  // addresses a submesh by index. #178 S4 — the glTF material editor / readout.
  material: [
    // #394 S3d — the data-block row FIRST, because it answers the question everything
    // below it depends on: where does this material come from? Blender's Material
    // properties open the same way. Like `materialStack` this is `whenDeclared` and the
    // component decides on possession, for the same reason: "does this node take a
    // material over an EDGE?" is a registry question and `SectionCtx` carries no registry.
    { key: 'materialLink', applies: whenDeclared, placement: 'before' },
    {
      key: 'slotSelector',
      applies: (c) => c.ownsParam('slotIndex'),
      placement: 'before',
      // Routes to no section of its own, so without this it would surface as a
      // raw row in the unrouted bucket beside the selector that renders it.
      omitRowKeys: ['slotIndex'],
    },
    { key: 'gltfMaterialEditor', applies: hasCapturedMaterials, placement: 'before' },
    {
      key: 'gltfMaterialReadout',
      applies: (c) => c.ownsParam('assetRef') && !hasCapturedMaterials(c),
      placement: 'before',
    },
    // #394 S3d — the material operator stack, the fourth OperatorStackRows caller.
    //
    // `whenDeclared` rather than a possession test, and the reason is a limit of this
    // table rather than a looser rule: "is this node a DATA-LANE SOURCE?" is answered by
    // evaluating it (`resolveDataKind`), and `SectionCtx` deliberately carries no store
    // and no evaluator — it is a pure, allocation-free predicate over params. Five other
    // node types declare 'material' without being on the lane (`Material` itself, the
    // scene-band `MaterialOverride`, `GltfChild`, `GltfAsset`, `ScatterNode`), so the
    // control renders NOTHING for them, decided inside `MaterialStackControls` where the
    // question can actually be asked. Stated here so the split does not read as an
    // oversight: the table gates on declaration, the component gates on the lane.
    //
    // 'before', like every other stack: Blender's Material Properties tab leads with the
    // slot list and puts the shading settings under it, and the modifier stack already
    // reads that way here. The two 'after' controls stay the only two.
    { key: 'materialStack', applies: whenDeclared, placement: 'before' },
  ],
  render: [],
  // #270 the per-side extend rules, #274 (D2) the F-Modifier stack — for a
  // channel that owns those params (Number/Vec2/Vec3 today; the Color/Quat/
  // Text/Image channels do not declare them, and asking possession is what
  // keeps that distinction correct as channel kinds change).
  animate: [
    {
      key: 'channelExtend',
      applies: (c) => c.ownsParam('extendBefore'),
      placement: 'before',
      omitRowKeys: ['extendBefore', 'extendAfter'],
    },
    {
      key: 'channelModifiers',
      applies: (c) => c.ownsParam('modifiers'),
      placement: 'before',
      omitRowKeys: ['modifiers'],
    },
    // #921 — the bone-map editor, for a node that takes a bone map over an EDGE.
    //
    // The first version said `whenDeclared` and left possession to the component, on
    // the precedent `materialStack` sets above. `inspectorSectionBody.test.ts` refused
    // it, and was right to: `sectionRendersCustomControl` is also the registry guard,
    // so a control claiming a section it will not draw makes that guard lie for every
    // channel kind that declares `animate` and owns no map. The gap was in the CONTEXT,
    // not in the rule — possession by declared INPUT was simply not askable. It is now.
    //
    // 'before': it answers the question the rows underneath depend on — which bones of
    // the source rig reach this character at all.
    { key: 'boneMap', applies: (c) => c.ownsInput('boneMap'), placement: 'before' },
  ],
  channel: [],
  // #312 / #316 — the constraint and driver stacks (OperatorStackRows over
  // different enumerators). Ungated: declaring the section is the assertion.
  constraint: [{ key: 'constraintStack', applies: whenDeclared, placement: 'before' }],
  driver: [{ key: 'driverStack', applies: whenDeclared, placement: 'before' }],
  // #321 — a Curve's control points. A variable-length vec3 list has no generic
  // row, so it renders through a dedicated control and is omitted below.
  curve: [
    {
      key: 'curvePoints',
      applies: whenDeclared,
      placement: 'before',
      omitRowKeys: ['points'],
    },
  ],
  light: [],
  // #209 — the geometry OperatorStack UI.
  modifier: [{ key: 'modifierStack', applies: whenDeclared, placement: 'before' }],
  effect: [],
  // UX #9 / UX #12 — the environment and lens sections lead with one control; their
  // params route here only to stay out of the unrouted bucket. Both are ungated: the
  // four other one-control sections already are, and the camera's
  // `type === 'PerspectiveCamera' || 'OrthographicCamera'` gate was an artifact of
  // predating the object↔data split, not a rule — carrying it here would mean a split
  // camera's data half matches neither and the lens panel renders empty.
  environment: [
    {
      key: 'sceneEnvironment',
      applies: whenDeclared,
      placement: 'before',
      suppressesAllRows: true,
    },
  ],
  // #387 — the lens control OWNS NINE KEYS, it does not own the section.
  //
  // It used to say `suppressesAllRows`, which was true while every param routed to
  // `camera` was one the control authors. A split `CameraData` breaks that: it declares
  // ONLY `camera`, so its `lookAt`, `roll` and `projection` route here too — and
  // `CameraLensControls` authors none of the three. Under whole-section suppression
  // they would render NOWHERE: no row, no control, no error, and a "does the card
  // render?" guard cannot see it, because the card is not empty. Listing the nine keys
  // the control actually writes lets the rest fall through as labelled generic rows,
  // which is the shape `lightKind`/`target`/`lookAt` already have on a LightData.
  //
  // Byte-identical for a FUSED camera: it declares `transform` as well, so its
  // `lookAt`/`roll` match the transform arm first and still render there.
  //
  // The nine are exactly the keys `paramToSection` routes to `camera` and exactly the
  // keys `CameraLensControls` writes — the two lists were re-derived against each other
  // rather than assumed equal, and `inspectorSectionBody.test.ts` pins that any key
  // dropped from here reappears as a stray row.
  camera: [
    {
      key: 'cameraLens',
      applies: whenDeclared,
      placement: 'before',
      omitRowKeys: [
        'fov',
        'sensorSize',
        'zoom',
        'near',
        'far',
        'dofEnabled',
        'focusDistance',
        'fStop',
        'focusOnTarget',
      ],
    },
  ],
  layout: [],
  // #645 — the OBJECT's per-slot override list. Declared only by `ObjectNode`, so the
  // control renders exactly where the section does.
  //
  // `whenDeclared`, NOT a possession test, and the reason is worth stating because the
  // neighbouring controls read the other way. `slotOverrides` is `.optional()` with no
  // default, so it does not materialize on a node until the first override is written —
  // `ownsParam('slotOverrides')` is therefore FALSE for every Object that has yet to
  // override anything, which is every Object the director would be trying to author one on.
  // Gating on possession would hide the only affordance that creates the possession.
  //
  // `suppressesAllRows` because the control IS the presentation of that one param: the
  // generic row for a record of material specs would be an unreadable blob beside a slot
  // list that already draws it. The param still routes here (see `ObjectNode.home`), which
  // is what keeps it out of the unrouted bucket.
  slots: [
    { key: 'objectSlots', applies: whenDeclared, placement: 'before', suppressesAllRows: true },
  ],
};

/** Every row key a control owns across the sections a node declares.
 *
 *  A caller needs this BEFORE grouping params into sections, because a key a
 *  control owns may route to no section at all (`slotIndex` does), and would
 *  then surface as a raw row in the unrouted bucket — beside the control that
 *  already renders it. Reading it off the table keeps "which keys a control
 *  owns" in one place instead of splitting it between the table and a skip list
 *  in each caller.
 */
export function controlOwnedRowKeys(
  declaredSections: readonly SectionId[],
  ctx: SectionCtx,
): ReadonlySet<string> {
  const owned = new Set<string>();
  for (const sectionId of declaredSections) {
    for (const control of activeControls(sectionId, ctx)) {
      for (const key of control.omitRowKeys ?? []) owned.add(key);
    }
  }
  return owned;
}

/** The controls that actually apply to `ctx`, in table order. */
function activeControls(sectionId: SectionId, ctx: SectionCtx): readonly SectionControl[] {
  return SECTION_CONTROLS[sectionId].filter((c) => c.applies(ctx));
}

/**
 * Which of a section's generic rows survive its custom controls.
 *
 * `SectionBody` renders through this, and so does the exposed-param projection, for the
 * same reason the table itself is shared: "a control replaces these rows" is a decision,
 * and a second site that re-derives it is a second answer that will eventually differ.
 * The projection cannot import `SectionBody` (it emits data, not React), so without this
 * it would have to re-filter `SECTION_CONTROLS` itself — which is exactly the drift the
 * one-table property exists to prevent.
 *
 * Note the SCOPE: `omitted` is per SECTION, not global. A key one section's control owns
 * still renders as a row in a different section it routes to. The main-node panel block
 * additionally pre-filters by `controlOwnedRowKeys` (the union across declared sections)
 * before grouping, because a control-owned key may route to no section at all and would
 * otherwise land in the unrouted bucket beside the control that renders it.
 */
export function sectionRowFilter(
  sectionId: SectionId,
  ctx: SectionCtx,
): { suppressAllRows: boolean; omitted: ReadonlySet<string> } {
  const active = activeControls(sectionId, ctx);
  return {
    suppressAllRows: active.some((c) => c.suppressesAllRows === true),
    omitted: new Set(active.flatMap((c) => c.omitRowKeys ?? [])),
  };
}

/**
 * Does this section render a custom control for this node?
 *
 * The guard's predicate. A section that routes no param to a generic row AND
 * renders no custom control is an empty card — the failure this file exists to
 * make impossible. Reads the same table the UI renders from, so it cannot
 * certify behaviour the UI does not have.
 */
export function sectionRendersCustomControl(sectionId: SectionId, ctx: SectionCtx): boolean {
  return activeControls(sectionId, ctx).length > 0;
}

/** Build the context both call sites dispatch against, so they cannot drift.
 *  `objectNodeId` is the posing Object; pass the node's own id for a node that
 *  is not the linked half of a split. */
export function makeSectionCtx(
  node: Node | null | undefined,
  objectNodeId: string,
  canApplyTransform: boolean,
): SectionCtx {
  const params = (node?.params ?? {}) as Record<string, unknown>;
  return {
    paramsNodeId: node?.id ?? objectNodeId,
    objectNodeId,
    params,
    ownsParam: (key) => nodeOwnsParam(node?.type, params, key),
    ownsInput: (key) => declaredInputKeys(node?.type).includes(key),
    canApplyTransform,
  };
}

/** The input socket names a node TYPE declares. The edge-side of `declaredParamKeys`,
 *  and read the same way: off the registry, so it describes the KIND and not one
 *  instance's current wiring. A socket that exists but is unwired still belongs to
 *  the node — the editor for it should appear and say the edge is missing, not vanish. */
export function declaredInputKeys(nodeType: string | undefined): readonly string[] {
  if (!nodeType) return [];
  return Object.keys(getNodeType(nodeType)?.inputs ?? {});
}

/** Ownership of a param: declared by the node type's schema, or present on the
 *  node (a spare param, or a schema field that has materialized). See the
 *  `ownsParam` note on `SectionCtx` for why the schema has to be asked first. */
function nodeOwnsParam(
  nodeType: string | undefined,
  params: Readonly<Record<string, unknown>>,
  key: string,
): boolean {
  return key in params || declaredParamKeys(nodeType).includes(key);
}

/** The param keys a node TYPE declares, read off its schema.
 *
 *  The honest answer to "what params does this kind have?", and the one a guard
 *  has to use: a node's params OBJECT is a snapshot, and not every schema can
 *  even be defaulted into one (`BoxData.size` is a required tuple, so parsing
 *  `{}` fails outright and would leave a sweep looking at nothing). */
export function declaredParamKeys(nodeType: string | undefined): readonly string[] {
  if (!nodeType) return [];
  const schema = getNodeType(nodeType)?.paramSchema;
  if (!(schema instanceof z.ZodObject)) return [];
  return Object.keys(schema.shape as Record<string, unknown>);
}

/**
 * A section's body: the custom controls that apply, the generic rows they do
 * not own, and the controls that render below those rows.
 *
 * Rendering the controls and filtering the rows in ONE place is the point — a
 * control and the suppression of the rows it replaces cannot drift apart.
 *
 * `renderRow` is supplied by the caller because ParamRow's props differ between
 * the two sites (the main-node block decorates rows with override info; the
 * linked-data block does not).
 */
/**
 * One row a section body draws.
 *
 * `key` is the PARAM key — what the section filter and the controls address, so it is the
 * half that must stay a param name. `rowKey` is the React identity, and it is separate
 * because a section can be fed by more than one node (#518, P3): a data-lane material
 * operator and the base data node both contribute to the material section, and two
 * operators in one lane both contribute a `roughness`. Defaults to `key`, so the
 * single-node caller is unchanged.
 *
 * ⚠️ DECLARED UNTESTED, and the first statement of this claim was measurably WRONG. It
 * read "React resolves a duplicate key by dropping one — silently". Falsified: with two
 * override operators stacked in one lane and the identity keyed on the param name, BOTH
 * `roughness` rows rendered. Duplicate sibling keys are still wrong — they make React's
 * reconciliation reuse the wrong element across a reorder, so a focused input's draft can
 * land on another row — but that consequence needs an affordance to REORDER the material
 * lane, and none exists yet. So `rowKey` is kept because it is correct, not because a test
 * proves it matters, and this note is here rather than a passing assertion implying it was
 * checked.
 */
export interface SectionBodyRow {
  readonly key: string;
  readonly value: unknown;
  readonly rowKey?: string;
}

/** Generic in the row so a caller can carry MORE than the body needs — the linked-data
 *  block attaches each row's `nodeId`, and `renderRow` receives it typed. Re-looking it up
 *  from the key would be resolution where provenance already exists, which is the exact
 *  move this slice removes. */
export function SectionBody<R extends SectionBodyRow>({
  sectionId,
  ctx,
  rows,
  renderers,
  renderRow,
}: {
  sectionId: SectionId;
  ctx: SectionCtx;
  rows: readonly R[];
  renderers: SectionControlRenderers;
  renderRow: (row: R) => ReactNode;
}) {
  const active = activeControls(sectionId, ctx);
  const { suppressAllRows, omitted } = sectionRowFilter(sectionId, ctx);
  const at = (placement: 'before' | 'after') =>
    active
      .filter((c) => c.placement === placement)
      .map((c) => <Fragment key={c.key}>{renderers[c.key](ctx)}</Fragment>);
  return (
    <>
      {at('before')}
      {suppressAllRows ? null : rows.filter((r) => !omitted.has(r.key)).map((r) => renderRow(r))}
      {at('after')}
    </>
  );
}

/** How each control is drawn. Exhaustive over `ControlKey`, so a control that
 *  is added to the table but never wired fails the build. */
export type SectionControlRenderers = Record<ControlKey, (ctx: SectionCtx) => ReactNode>;
