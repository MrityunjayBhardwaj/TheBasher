# UX Backlog — Spline/Blender-grade editor polish

Working list captured 2026-06-12 from director-use friction. Branch off `ux-overhall`,
one fix per atomic commit, friction-first (observe the live app before + after).
Status: ☐ todo · ◐ in progress · ☑ done.

## Chrome / layout

1. ☑ **Transform gizmo head — NOT A BUG (closed 2026-06-13).** The "heads only point
   positive / +Y points down" is stock `three-stdlib` `TransformControls` design: both the
   `fwd` + `bwd` arrowheads sit at the **+end** of each axis (`TransformControls.js:795-808`);
   a per-frame `axis·eye` test (`:642-674`, `AXIS_FLIP_TRESHOLD=0`) flips **which** cone lights,
   never relocating it to the −end — so from below, the +Y cone points back toward centre.
   Live Playwright intel proved it is **transform-independent** (identical cones across identity /
   rot180 / mirror-Y / neg-scale on a real GltfChild) → kills every H89 transform hypothesis.
   Decision: **accept the flip** (it's standard, Blender's Move gizmo is similar). See [[H89]].
2. ☐ **Floating-island panels (Spline-style).** Make every panel a floating island — outliner,
   inspector, **timeline, and chat box** — detached rounded surfaces over the viewport, not
   docked grid bands.
3. ☑ **Remove the STUB/LIVE toggle** (top-right corner). _(ComfyStatusIndicator unmounted from ProjectTabs.)_
4. ☑ **Remove Save + Projects from the top-right corner.** Move the projects list under **File**.
   _(Save → File ▸ Save / Cmd+S; projects → File ▸ Switch Project submenu.)_
5. ☐ **Fix the toolbar menus.** (Menus opening from the toolbar are off — position/behaviour.)
6. ☐ **Left panel → drop Import/Library/Help & Feedback.** Replace with a **bottom drawer**
   (like the floating timeline) hosting the asset **Library** — Blender's asset-browser model.

## Selection / scene

7. ☑ **Select anything, even inside a group — Blender/Spline-style.** _(2026-06-13)_ Double-click
   drills ONE level deeper toward the sub-mesh under the cursor (whole import → body → wheel →
   leaf); repeat to go deeper; **Esc** pops back up a level. The deep glTF mesh maps to its
   GltfChild via `GltfAsset.nodeNameMap`; drill depth lives in a dedicated `drillStore` (survives
   the single-click that precedes every double-click). Single click still selects the whole
   import. _(Limitation: scopes the asset by hit-name match — multiple imports of the same model
   with shared child names is a heuristic.)_

## Materials / textures / lighting

8. ☐ **glTF materials not visible — fix.** Can't see/inspect a glTF model's materials.
9. ☐ **HDRI support.** Add environment/HDRI lighting.
10. ☐ **Textures in the UV editor.** Show the bound texture under the UV layout, Blender-style.

## Animation

11. ☐ **Dopesheet / graph-editor timeline** modelled on
    [reze-studio](https://github.com/AmyangXYZ/reze-studio).

## Camera

12. ☐ **Blender-grade camera.** Full properties — FOV, depth of field, etc.

---

Each item, when started, gets a one-paragraph friction observation + plan in its commit body.
