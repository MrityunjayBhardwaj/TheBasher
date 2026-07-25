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
  | 'constraintStack'
  | 'driverStack'
  | 'curvePoints'
  | 'channelExtend'
  | 'channelModifiers'
  | 'applyTransform'
  | 'setOrigin';

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
    { key: 'slotSelector', applies: (c) => c.ownsParam('slotIndex'), placement: 'before' },
    { key: 'gltfMaterialEditor', applies: hasCapturedMaterials, placement: 'before' },
    {
      key: 'gltfMaterialReadout',
      applies: (c) => c.ownsParam('assetRef') && !hasCapturedMaterials(c),
      placement: 'before',
    },
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
  // UX #9 / UX #12 — the environment and lens sections are authored ENTIRELY by
  // one control; their params route here only to stay out of the unrouted
  // bucket. Both are ungated: the four other one-control sections already are,
  // and the camera's `type === 'PerspectiveCamera' || 'OrthographicCamera'`
  // gate was an artifact of predating the object↔data split, not a rule —
  // carrying it here would mean a split camera's data half matches neither and
  // the lens panel renders empty.
  environment: [
    {
      key: 'sceneEnvironment',
      applies: whenDeclared,
      placement: 'before',
      suppressesAllRows: true,
    },
  ],
  camera: [
    { key: 'cameraLens', applies: whenDeclared, placement: 'before', suppressesAllRows: true },
  ],
  layout: [],
};

/** The controls that actually apply to `ctx`, in table order. */
function activeControls(sectionId: SectionId, ctx: SectionCtx): readonly SectionControl[] {
  return SECTION_CONTROLS[sectionId].filter((c) => c.applies(ctx));
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
    canApplyTransform,
  };
}

/** Ownership of a param: declared by the node type's schema, or present on the
 *  node (a spare param, or a schema field that has materialized). See the
 *  `ownsParam` note on `SectionCtx` for why the schema has to be asked first. */
function nodeOwnsParam(
  nodeType: string | undefined,
  params: Readonly<Record<string, unknown>>,
  key: string,
): boolean {
  if (key in params) return true;
  if (!nodeType) return false;
  const schema = getNodeType(nodeType)?.paramSchema;
  return schema instanceof z.ZodObject && key in (schema.shape as Record<string, unknown>);
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
export function SectionBody({
  sectionId,
  ctx,
  rows,
  renderers,
  renderRow,
}: {
  sectionId: SectionId;
  ctx: SectionCtx;
  rows: readonly (readonly [string, unknown])[];
  renderers: SectionControlRenderers;
  renderRow: (key: string, value: unknown) => ReactNode;
}) {
  const active = activeControls(sectionId, ctx);
  const suppressAllRows = active.some((c) => c.suppressesAllRows);
  const omitted = new Set(active.flatMap((c) => c.omitRowKeys ?? []));
  const at = (placement: 'before' | 'after') =>
    active
      .filter((c) => c.placement === placement)
      .map((c) => <Fragment key={c.key}>{renderers[c.key](ctx)}</Fragment>);
  return (
    <>
      {at('before')}
      {suppressAllRows
        ? null
        : rows.filter(([key]) => !omitted.has(key)).map(([key, value]) => renderRow(key, value))}
      {at('after')}
    </>
  );
}

/** How each control is drawn. Exhaustive over `ControlKey`, so a control that
 *  is added to the table but never wired fails the build. */
export type SectionControlRenderers = Record<ControlKey, (ctx: SectionCtx) => ReactNode>;
