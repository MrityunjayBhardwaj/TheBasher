// Box (marquee) selection geometry — the PURE core of #226. The viewport supplies
// a `project` function (world point → screen px + visibility) and the candidate
// world origins; this decides which candidates fall inside the drawn marquee.
//
// Blender parity: object-mode box-select tests the object ORIGIN (not its full
// screen bounds), and only objects in front of the camera can be hit. Both rules
// live here so they're unit-testable independent of THREE / the camera.
//
// PURE — no THREE, no React, no store reads. The real perspective projection is
// injected as `project` (tested via the e2e boundary-pair on the live camera).

export interface ScreenPoint {
  x: number;
  y: number;
  /** False when the world point is behind the camera (NDC z > 1) — never a hit. */
  visible: boolean;
}

/** A marquee in canvas-relative CSS pixels: the drag start (x0,y0) → current (x1,y1). */
export interface PixelRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface NormRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Order-independent bounds of a drag rect (the user may drag up-left or down-right). */
export function normalizeRect(r: PixelRect): NormRect {
  return {
    minX: Math.min(r.x0, r.x1),
    minY: Math.min(r.y0, r.y1),
    maxX: Math.max(r.x0, r.x1),
    maxY: Math.max(r.y0, r.y1),
  };
}

export function rectContains(r: NormRect, x: number, y: number): boolean {
  return x >= r.minX && x <= r.maxX && y >= r.minY && y <= r.maxY;
}

/** A marquee smaller than `threshold` px on BOTH axes is a click, not a drag — the
 *  caller cancels (Blender's B-then-click cancels box mode without changing the set). */
export function isDragRect(r: PixelRect, threshold = 4): boolean {
  return Math.abs(r.x1 - r.x0) >= threshold || Math.abs(r.y1 - r.y0) >= threshold;
}

export interface BoxCandidate {
  id: string;
  world: [number, number, number];
}

/**
 * The ids whose projected ORIGIN is visible AND inside the marquee. Insertion
 * order follows `candidates` (the caller makes the last hit the active node).
 */
export function boxSelectHits(
  candidates: readonly BoxCandidate[],
  rect: PixelRect,
  project: (world: [number, number, number]) => ScreenPoint,
): string[] {
  const norm = normalizeRect(rect);
  const hits: string[] = [];
  for (const c of candidates) {
    const p = project(c.world);
    if (!p.visible) continue;
    if (rectContains(norm, p.x, p.y)) hits.push(c.id);
  }
  return hits;
}
