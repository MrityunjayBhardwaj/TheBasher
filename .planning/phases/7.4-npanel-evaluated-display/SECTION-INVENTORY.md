# Phase 7.4 — Section Inventory (W2.6 §B11 HOW re-validation pass)

**Date:** 2026-05-19
**Wave:** W4.1 (final wave)
**Phase:** 7.4 — NPanel evaluated display (closes #69, H40 NPanel sibling)
**Protocol:** UI-REVIEW.md §B11 (HOW re-validation cadence — the cycle that catches "decision-correct-at-authoring but adjacent chrome evolved")

---

## Scope of touch

Phase 7.4 changed the **value source seam** inside NPanel's `NumericField` and `VectorField` (the displayed `input.value` now comes from `resolveTransformParam(state, nodeId, paramPath, playing) ?? params.value`, gated by a `data-readonly-while-playing` attribute when `playing && resolved !== null`). It added ZERO new sections, ZERO new testids, ZERO new visible affordances. The write path (`onChange` → `dispatch(setParam)` → `autoKeyCommit`) is byte-unchanged (D-02 fence, verified via `git diff main -- src/app/NPanel.tsx | grep -E "onChange=|autoKeyCommit\("` returning zero +/− lines inside handlers).

The four no-touch grep gates from `PLAN.md §"Explicit no-touch grep gates"` all pass at HEAD:

| Gate | Command | Verdict |
|------|---------|---------|
| 1 — no raw `evaluate()` in helper/NPanel | `git grep -n "evaluate(" src/app/NPanel.tsx src/app/resolveTransformParam.ts` | 4 matches, all inside `//` comments documenting the anti-trap (zero call sites) — PASS |
| 2 — ParamDiamond body byte-identical | `git diff main -- src/app/NPanel.tsx \| awk '/^@@/{print}'` | No hunks span the ParamDiamond function body — PASS |
| 3 — onChange/autoKeyCommit handlers unchanged | `git diff main -- src/app/NPanel.tsx \| grep -E "onChange=\|autoKeyCommit\("` | zero +/− lines inside those handlers — PASS |
| 4 — D-04 ParamDiamond fence | (same as gate 2) | PASS |

---

## Per-surface verdict

| Surface | Owner | Touched by 7.4? | Sections / testids changed? | Verdict |
|---------|-------|-----------------|----------------------------|---------|
| **NPanel Inspector** (`src/app/NPanel.tsx`) | D-UX-8 (canonical Inspector — P6 W2.6 restore ledger; §5.8) | YES — value source seam in `NumericField` (line ~184-211) + `VectorField` (line ~272-339) + new `data-readonly-while-playing` attr | NO — same `inspectorSections` declaration, same section cards, same field testids, ParamDiamond body untouched (D-04 fence) | **no shift** |
| **TopToolbar** (`src/app/TopToolbar.tsx`) | D-UX-2 (mode/snap canonical home — P6 W5) | NO | NO | **no shift** |
| **FloatingViewportToolbar** (`src/app/FloatingViewportToolbar.tsx`) | D-UX-12 (R8 — P6 W7) | NO | NO | **no shift** |
| **ParamDiamond** (`src/app/NPanel.tsx` function body) | D-04 (7.4 — diamond body untouched fence) | NO (explicit fence in 7.4 PLAN) | NO — grep-gate 2 + 4 confirm zero hunks span the function body | **no shift** |

---

## Distinctness ledger verdict

**No shifts — value source changed inside `NumericField` / `VectorComponent` / `VectorField`, surface inventory byte-identical.**

- **D-UX-2** (TopToolbar mode/snap) — holds; not touched.
- **D-UX-8** (NPanel canonical Inspector) — holds; the inspector remains the single source for per-node param affordances. The internal value-source change strengthens it (the inspector now displays what the user sees rendered, closing the H40 sibling that was the open structural gap).
- **D-UX-12** (R8 FloatingViewportToolbar) — holds; not touched.
- **D-04** (7.4 ParamDiamond fence) — holds; diamond body byte-identical.

**No D-UX restored / overridden / advanced** in 7.4.

---

## anvi-ui-checker BLOCK risk

ZERO. Phase 7.4 added no new visual surface that would require a new D-UX entry, no new testid that would require a new mirror, and no chrome-section reshape that would require a re-pin of an existing D-UX. The seam change is invisible at the surface-inventory level — the §B11 HOW re-validation cycle has nothing to retire or amend here.

---

## Outstanding (NOT a section inventory issue — surfaced for the H40 / H36 catalogue)

The 7.4 W3.1 boundary-pair e2e (`tests/e2e/p7.4-npanel-evaluated-display.spec.ts` Test 3, line ~411) runtime-observed that the NPanel inspector's `onChange` path lacks the gizmo's `routeAnimatedGrab` short-circuit (`src/app/Gizmo.tsx:301-324`) — a paused edit on an animated param still double-writes (`dispatch(setParam)` AND `autoKeyCommit`). The surface user contract holds (a keyframe IS created — Test 3 passes with channel keyframe count 2→3); the structural H36 defense is one surface short of complete. This is **NOT a section inventory shift** (no surface area changed); it is an open H36-class follow-up filed as a tracking issue and noted on the H40 entry (`.anvi/hetvabhasa.md` H40 "Open variant" line). Out of scope for 7.4 (CONTEXT D-02 = write path NOT modified). 7.5 candidate.

---

## Sign-off

- Inventory pass complete; verdict **no shifts**.
- D-UX ledger untouched.
- W2.6 §B11 cadence honored.
- Next chrome wave inherits the same distinctness claims, no retire/amend needed for 7.4's touch.
