// stackFrameModel — what the frame around the inspector's stacks shows (#1957, design board 14d).
//
// The frame is one box: a Modifiers · Constraints · Materials switch with counts, a flow strip in
// the order the stacks apply (Anim layers → Constraints → Modifiers), and the stack the switch picks,
// drawn inside it by the section bodies that drew it before (#1959). This file answers, without a
// browser:
//   - which object a selection's stacks hang off (the object, or the object a selected row is in);
//   - which stacks apply to it, and how many rows each holds;
//   - which stack a selected row belongs to, so picking a row keeps its stack up;
//   - which stack shows: the selected row's, else the one last picked where it applies;
//   - which inspector sections the frame takes in (#1959), so they are not drawn again outside it.
//
// A stack applies when its panel would draw something: modifiers and materials need a data lane
// (`resolveDataKind`, the question their panels ask) whose kind can ever take them (not a camera
// or a light: `dataSectionCapability` says "never"), constraints any Object. Counts are read the
// way each panel lists its rows; a constraint on both constraint lists counts once.
//
// No stack presets exist anywhere yet, so the frame has no presets bar: a bar with nothing to
// offer would be a dead control.
//
// REF: issue #1957; design board 14d; src/app/operatorStack.ts; src/app/constraintStack.ts;
//      src/app/stackTree.ts; src/timeline/animLayersModel.ts.

import { getNodeType } from '../core/dag/registry';
import type { SectionId } from './inspectorSections';
import type { DagState } from '../core/dag/state';
import { animLayersView } from '../timeline/animLayersModel';
import { constraintStackEntries } from './constraintStack';
import { dataSectionCapability, type ObjectDataKind } from './dataSectionCapability';
import {
  enumerateMaterialStack,
  enumerateModifierStack,
  resolveStackBase,
  resolveStackObject,
} from './operatorStack';
import { stackObjectOf } from './stackPanelModel';
import { stackOf } from './stackTree';

export type StackKind = 'modifiers' | 'constraints' | 'materials';

/** The switch's order, as the board draws it. */
export const STACK_KINDS: readonly StackKind[] = ['modifiers', 'constraints', 'materials'];

export const STACK_LABELS: Record<StackKind, string> = {
  modifiers: 'Modifiers',
  constraints: 'Constraints',
  materials: 'Materials',
};

export interface StackSummary {
  readonly kind: StackKind;
  readonly count: number;
  /** The node ids of the stack's rows, to tell which stack a selected row belongs to. */
  readonly members: readonly string[];
  /**
   * False where the object can never take this stack (#1960): a camera or a light has no mesh for
   * a modifier to reshape. The switch still shows the tab, so the note saying why has a home inside
   * the frame, but the frame never falls back to it and the flow strip leaves it out.
   */
  readonly available: boolean;
}

export interface StackFrameView {
  /** The object the stacks hang off. */
  readonly object: string;
  /** The stacks that apply to it, in the switch's order. */
  readonly stacks: readonly StackSummary[];
  /** The character's pose layers above the base, when the object is (or deforms by) one. */
  readonly animLayers: { readonly subject: string; readonly count: number } | null;
  /** The stack the selection is a row of, or null when the object itself is selected. */
  readonly member: StackKind | null;
}

/** The object a selection's stacks hang off, or null. */
function objectOf(state: DagState, selectedId: string): string | null {
  const node = state.nodes[selectedId];
  if (!node) return null;
  if (node.type === 'Object') return selectedId;
  if (getNodeType(node.type)?.worldStep) {
    const object = stackObjectOf(state, selectedId);
    return state.nodes[object]?.type === 'Object' ? object : null;
  }
  const wearer = resolveStackObject(state, selectedId);
  return wearer && state.nodes[wearer]?.type === 'Object' ? wearer : null;
}

/**
 * The constraints stack, counted once per constraint. Constraints come two ways today: edge-less
 * ones (`target` + order, the classic stack) and steps wired into the object's constraints lane
 * (#1817), and one constraint is often both. The lane starts from the object's own world (an
 * `OwnWorld` node), which is where the chain begins, not a row of it.
 */
function constraintSummary(state: DagState, object: string): StackSummary {
  const edgeless = constraintStackEntries(state, object).map((e) => e.nodeId);
  const top = stackOf(state, { node: object, socket: 'out' })[0];
  const lane = top?.kind === 'node' ? top.groups.filter((g) => g.socket === 'constraints') : [];
  const wired = lane
    .flatMap((g) => g.rows)
    .filter((row) => row.kind === 'node' && row.nodeType !== 'OwnWorld')
    .map((row) => row.nodeId);
  const members = [...new Set([...edgeless, ...wired])];
  return { kind: 'constraints', count: members.length, members, available: true };
}

/** What a data node is (`resolveDataKind`, which evaluates); the caller supplies it with its cache. */
export type DataKindOf = (state: DagState, dataId: string) => ObjectDataKind | null;

export function stackFrameOf(
  state: DagState,
  selectedId: string | null,
  dataKindOf: DataKindOf,
): StackFrameView | null {
  if (!selectedId) return null;
  const object = objectOf(state, selectedId);
  if (object === null) return null;
  const base = resolveStackBase(state, object);
  const kind = base !== object ? dataKindOf(state, base) : null;
  // Where the panel could only say "never" (a camera, a light), the stack cannot be taken.
  const never = (section: 'modifier' | 'material') =>
    kind !== null && dataSectionCapability(kind, section).state === 'never';
  const offered = (section: 'modifier' | 'material') => kind !== null && !never(section);
  const ids = (entries: readonly { nodeId: string }[]) => entries.map((e) => e.nodeId);
  const stacks: StackSummary[] = [];
  if (offered('modifier')) {
    const modifiers = ids(enumerateModifierStack(state, base));
    stacks.push({
      kind: 'modifiers',
      count: modifiers.length,
      members: modifiers,
      available: true,
    });
  } else if (never('modifier')) {
    // #1960 — the Object declares a Modifier section whatever its data, and that section's note
    // ("Modifiers reshape mesh data…") is the answer to "why no modifiers here?". The frame owns
    // it as a tab the object cannot take, so the inspector has one home for its stacks. Materials
    // need no such tab: a camera's or a light's data declares no Material section at all.
    stacks.push({ kind: 'modifiers', count: 0, members: [], available: false });
  }
  stacks.push(constraintSummary(state, object));
  if (offered('material')) {
    const materials = ids(enumerateMaterialStack(state, base));
    stacks.push({
      kind: 'materials',
      count: materials.length,
      members: materials,
      available: true,
    });
  }
  const layers = animLayersView(state, object);
  return {
    object,
    stacks,
    animLayers:
      layers.subject !== null ? { subject: layers.subject, count: layers.rows.length } : null,
    member:
      selectedId === object
        ? null
        : (stacks.find((s) => s.members.includes(selectedId))?.kind ?? null),
  };
}

export interface FlowStep {
  readonly kind: 'animLayers' | 'constraints' | 'modifiers';
  readonly label: string;
  readonly count: number;
}

/** The flow strip: the stacks in the order they apply — the pose, then the object, then its shape. */
export function flowOf(view: StackFrameView): FlowStep[] {
  const out: FlowStep[] = [];
  if (view.animLayers) {
    out.push({ kind: 'animLayers', label: 'Anim layers', count: view.animLayers.count });
  }
  for (const kind of ['constraints', 'modifiers'] as const) {
    const stack = view.stacks.find((s) => s.kind === kind && s.available);
    if (stack) out.push({ kind, label: STACK_LABELS[kind], count: stack.count });
  }
  return out;
}

/**
 * The stack that shows: the selected row's, else `stored` where it applies, else the first.
 *
 * `drawable` (#1959) narrows "applies" to the stacks the inspector can draw for this selection: a
 * selected data node carries its Material section but not its object's Modifier section, so a
 * stored "Modifiers" would show an empty frame there. Left out, every offered stack counts.
 *
 * A stack the object cannot take (#1960) is never fallen back to, and a stored pick does not reach
 * it: a camera opens on its Constraints even when a box's Modifiers were picked last. It shows only
 * while `peek` names it, which is the frame saying the director picked that tab on this object.
 */
export function effectiveStack(
  view: StackFrameView,
  stored: StackKind,
  drawable?: readonly StackKind[],
  peek?: StackKind | null,
): StackKind {
  if (view.member) return view.member;
  const canDraw = (k: StackKind) => !drawable || drawable.includes(k);
  if (peek && view.stacks.some((s) => s.kind === peek && !s.available) && canDraw(peek)) {
    return peek;
  }
  const offered = view.stacks.filter((s) => s.available).map((s) => s.kind);
  const candidates = offered.filter(canDraw);
  if (candidates.includes(stored)) return stored;
  return candidates[0] ?? offered[0] ?? 'constraints';
}

/**
 * The inspector sections that draw each stack (#1959): the frame draws these sections' bodies
 * inside itself, and the inspector stops drawing them as separate cards. The constraints stack is
 * two sections today (the classic edge-less list, and the stack panel on the object's lane).
 */
export const FRAME_SECTIONS: Record<StackKind, readonly SectionId[]> = {
  modifiers: ['modifier'],
  constraints: ['constraint', 'stack'],
  materials: ['material'],
};

/**
 * The stack whose frame takes `section` in, or null when the section stays a card of its own:
 * no frame shows, the section draws no stack, or the frame does not show that stack at all. A
 * stack the object cannot take is still shown, as an unavailable tab (#1960), so a camera's
 * Modifier section, with its note saying why the stack stays empty, is drawn inside the frame.
 */
export function frameStackOf(view: StackFrameView | null, section: SectionId): StackKind | null {
  if (!view) return null;
  for (const stack of view.stacks) {
    if (FRAME_SECTIONS[stack.kind].includes(section)) return stack.kind;
  }
  return null;
}
