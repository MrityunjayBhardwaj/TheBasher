// SceneTreeIcon — per-node-type line glyph for the Spline scene outliner
// (redesign Wave B). Spline shows a monochrome icon left of every row name;
// this maps the DAG node type to a small inline SVG drawn in `currentColor`
// so it inherits the row's text color (selected = accent, idle = fg-dim).
//
// Pure presentation — keyed only off `nodeType` (the projection's type label).
// No DAG read, no state. New node types fall back to the generic dot, so an
// unmapped type degrades gracefully rather than crashing.
//
// REF: docs/UI-SPEC.md §5.5 (LeftSidebar outliner); THESIS.md §12 (projection).

import type { ReactNode } from 'react';

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
  | 'dot';

// Map a DAG node type to a visual icon family. Suffix matches (…Light /
// …Camera) absorb the five light kinds + two camera kinds without enumerating
// each. Unknown types → 'dot'.
function kindForNodeType(nodeType: string): IconKind {
  if (nodeType === 'Scene') return 'scene';
  if (nodeType === 'Group') return 'group';
  if (nodeType === 'Transform') return 'transform';
  if (nodeType === 'MaterialOverride') return 'material';
  if (nodeType === 'Scatter') return 'scatter';
  if (nodeType === 'GltfSkeleton') return 'skeleton';
  if (nodeType.endsWith('Light')) return 'light';
  if (nodeType.endsWith('Camera')) return 'camera';
  if (
    nodeType === 'BoxMesh' ||
    nodeType === 'SphereMesh' ||
    nodeType === 'BakedMesh' ||
    nodeType === 'GltfAsset' ||
    nodeType === 'GltfChild' ||
    nodeType.endsWith('Mesh')
  ) {
    return 'mesh';
  }
  return 'dot';
}

const GLYPHS: Record<IconKind, ReactNode> = {
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

export function SceneTreeIcon({ nodeType }: { nodeType: string }): ReactNode {
  return <Svg>{GLYPHS[kindForNodeType(nodeType)]}</Svg>;
}
