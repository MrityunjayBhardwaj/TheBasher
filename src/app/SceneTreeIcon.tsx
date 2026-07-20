// SceneTreeIcon — per-node-type line glyph for the Spline scene outliner
// (redesign Wave B). Spline shows a monochrome icon left of every row name;
// this maps the DAG node type to a small inline SVG drawn in `currentColor`
// so it inherits the row's text color (selected = accent, idle = fg-dim).
//
// Pure presentation — the component takes an already-resolved `IconKind` and
// draws it. No DAG read, no state, no type matching. Deciding WHICH kind a row
// is belongs to `iconKindForNode` below, which is the only part that needs the
// graph.
//
// #414 — that split exists because "what kind of thing is this row?" stopped
// being answerable from the node type alone. A cube is an `Object` pointing at a
// `BoxData`: the Object carries the pose, the data node carries what it IS. The
// old code matched `nodeType` against a list of mesh types, `'Object'` matched
// none of them, and every cube in the outliner fell through to the generic dot —
// silently, because a dot is a real icon and nothing errors.
//
// REF: docs/UI-SPEC.md §5.5 (LeftSidebar outliner); THESIS.md §12 (projection);
//      src/app/resolveDataParamOwner.ts (the one place the `data` reach lives).

import type { ReactNode } from 'react';
import type { DagState } from '../core/dag/state';
import { linkedDataNodeId } from './resolveDataParamOwner';

const SIZE = 13;

function Svg({ children }: { children: ReactNode }): ReactNode {
  return (
    <svg
      width={SIZE}
      height={SIZE}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
    >
      {children}
    </svg>
  );
}

type IconKind =
  | 'scene'
  | 'group'
  | 'transform'
  | 'material'
  | 'mesh'
  | 'light'
  | 'camera'
  | 'skeleton'
  | 'scatter'
  | 'curve'
  | 'dot';

// Map a DAG node type to a visual icon family. Suffix matches (…Light / …Camera
// / …Data) absorb the five light kinds, two camera kinds and the split's data
// nodes without enumerating each. Unknown types → 'dot'.
//
// `'Object'` is deliberately ABSENT: an Object is a pose pointing at data, so its
// type says nothing about what it is. `iconKindForNode` resolves it through the
// `data` edge instead — see there.
function kindForNodeType(nodeType: string): IconKind {
  if (nodeType === 'Scene') return 'scene';
  if (nodeType === 'Group') return 'group';
  if (nodeType === 'Transform') return 'transform';
  if (nodeType === 'MaterialOverride') return 'material';
  if (nodeType === 'Scatter') return 'scatter';
  if (nodeType === 'Curve' || nodeType === 'CurveData') return 'curve';
  if (nodeType === 'GltfSkeleton') return 'skeleton';
  if (nodeType.endsWith('Light')) return 'light';
  if (nodeType.endsWith('Camera')) return 'camera';
  if (
    nodeType === 'SphereMesh' ||
    nodeType === 'BakedMesh' ||
    nodeType === 'GltfAsset' ||
    nodeType === 'GltfChild' ||
    nodeType.endsWith('Mesh') ||
    // The split's mesh-data nodes (BoxData today; SphereData and the baked/
    // modified data kinds as the per-kind rollout lands). An Object delegates
    // here through its `data` edge, so this arm is what a cube actually hits.
    nodeType.endsWith('Data')
  ) {
    return 'mesh';
  }
  return 'dot';
}

/**
 * The icon family for the scene-tree row produced by `nodeId` — the ONE place
 * that decides, and the only part of this module that reads the graph.
 *
 * An `Object` carries a pose, not an identity: what it IS lives on the node its
 * `data` edge points at. So an Object DELEGATES — the same reach
 * `resolveDataParamOwner` already owns for material and size, rather than a
 * second spelling of it here (V101). A cube resolves Object → BoxData → 'mesh'.
 *
 * An Object with no data is an Empty — a pure transform with nothing hanging off
 * it — which is what the transform glyph already means. That is a deliberate
 * choice, not a fallthrough: it must NOT land on 'dot', because 'dot' is the
 * "I don't know what this is" answer and we know exactly what an Empty is.
 *
 * NOTE ON THE GUARD: node types are strings, not a closed union, so the compiler
 * cannot force a new data kind to be answered here the way an exhaustive switch
 * would. `SceneTreeIcon.test.ts` substitutes for that by walking the REGISTRY:
 * every registered node type that can sit on an Object's `data` socket must
 * resolve to a non-'dot' icon. Stage C's SphereData / CurveData / LightData /
 * CameraData will redden that test the moment they register without an arm.
 */
export function iconKindForNode(state: DagState, nodeId: string, nodeType: string): IconKind {
  if (nodeType !== 'Object') return kindForNodeType(nodeType);
  const dataId = linkedDataNodeId(state, nodeId);
  if (!dataId) return 'transform'; // an Empty — a pose with no data
  return kindForNodeType(state.nodes[dataId]?.type ?? '');
}

const GLYPHS: Record<IconKind, ReactNode> = {
  // An S-bend through two control points — the path (#321).
  curve: (
    <>
      <path d="M2 12c3 0 3.5-8 6.5-8S12 12 14 12" />
      <circle cx="2.5" cy="12" r="1.3" />
      <circle cx="13.5" cy="12" r="1.3" />
    </>
  ),
  // Stacked layers — the scene root.
  scene: (
    <>
      <path d="M8 2 2 5l6 3 6-3-6-3Z" />
      <path d="M2 8l6 3 6-3" />
      <path d="M2 11l6 3 6-3" />
    </>
  ),
  // Folder.
  group: (
    <>
      <path d="M2 4.5h4l1.2 1.5H14v6.5H2V4.5Z" />
    </>
  ),
  // Move crosshair.
  transform: (
    <>
      <path d="M8 2v12M2 8h12" />
      <path d="M8 2 6.4 3.6M8 2l1.6 1.6M8 14l-1.6-1.6M8 14l1.6-1.6M2 8l1.6-1.6M2 8l1.6 1.6M14 8l-1.6-1.6M14 8l-1.6 1.6" />
    </>
  ),
  // Paint droplet (material override).
  material: (
    <>
      <path d="M8 2.5C8 2.5 3.5 7 3.5 10a4.5 4.5 0 0 0 9 0c0-3-4.5-7.5-4.5-7.5Z" />
    </>
  ),
  // Cube (any mesh).
  mesh: (
    <>
      <path d="M8 2 2.5 5v6L8 14l5.5-3V5L8 2Z" />
      <path d="M2.5 5 8 8l5.5-3M8 8v6" />
    </>
  ),
  // Sun (lights).
  light: (
    <>
      <circle cx="8" cy="8" r="2.6" />
      <path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1" />
    </>
  ),
  // Camera.
  camera: (
    <>
      <path d="M2 5.5h7.5v5H2v-5Z" />
      <path d="M9.5 7.2 14 5v6l-4.5-2.2" />
    </>
  ),
  // Skeleton / bone joints.
  skeleton: (
    <>
      <circle cx="4.5" cy="4.5" r="1.6" />
      <circle cx="11.5" cy="11.5" r="1.6" />
      <path d="M5.7 5.7 10.3 10.3" />
    </>
  ),
  // Scatter — dots.
  scatter: (
    <>
      <circle cx="4" cy="4" r="1" />
      <circle cx="11" cy="5" r="1" />
      <circle cx="6" cy="9" r="1" />
      <circle cx="12" cy="11" r="1" />
      <circle cx="4" cy="12" r="1" />
    </>
  ),
  // Generic fallback dot.
  dot: (
    <>
      <circle cx="8" cy="8" r="2.4" />
    </>
  ),
};

/** Draws an already-resolved icon kind. Callers resolve with {@link iconKindForNode},
 *  which is the only thing that reads the graph — this stays pure presentation. */
export function SceneTreeIcon({ kind }: { kind: IconKind }): ReactNode {
  return <Svg>{GLYPHS[kind]}</Svg>;
}
