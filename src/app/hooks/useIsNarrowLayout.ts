// UX-BACKLOG #2 follow-up 2 — narrow-layout detection.
//
// True when the viewport is narrower than the island layout's desktop
// breakpoint (LAYOUT_NARROW_MAX). Above it the side-by-side floating islands
// apply; below it Layout re-docks to the narrow variant (side panels become
// off-canvas drawers, centered surfaces go full-width).
//
// Subscribes to a single matchMedia query (the breakpoint lives in
// layoutIslands, never duplicated as a literal). Guards a missing `matchMedia`
// (SSR / a test env without the API) by assuming the DESKTOP layout — the
// editor's default and what every existing geometry gate asserts, so a unit
// rendering a chrome component in that env keeps the wide behaviour.

import { useEffect, useState } from 'react';

import { NARROW_LAYOUT_QUERY } from '../layoutIslands';

function readMatch(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(NARROW_LAYOUT_QUERY).matches;
}

export function useIsNarrowLayout(): boolean {
  const [narrow, setNarrow] = useState(readMatch);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(NARROW_LAYOUT_QUERY);
    const onChange = () => setNarrow(mql.matches);
    // Re-sync once on mount: the width may have changed between the initial
    // useState read (render) and the effect (commit).
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  return narrow;
}
