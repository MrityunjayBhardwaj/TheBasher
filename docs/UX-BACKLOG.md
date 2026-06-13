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
5. ☑ **Fix the toolbar menus.** _(2026-06-14, `5fd98d1`.)_ The "+ Add" menu
   anchored at the button's TOP edge (a leftover from when the pill lived at the
   viewport bottom and "opened upward") so it rendered OVER the toolbar row,
   covering the +Add button; Assets used a different anchor. Both now share one
   `toolbarMenuAnchor` helper that opens them just below the WHOLE pill,
   left-aligned to the clicked button (gate `ux5-toolbar-menu-position.spec.ts`).
6. ☑ **Left panel → drop Import/Library/Help & Feedback.** _(2026-06-14, `dd31707`.)_
   Done as a **left-panel tab** (user redirect from the bottom-drawer idea): the left
   panel is now `Outliner | Assets`. The Outliner tab keeps search + Scenes + tree; the
   **Assets** tab hosts the asset **Library** (samples + my imports + per-row manage) plus
   an **Import…** button — Blender's asset-browser model, a persistent browser beside the
   tree. The footer (Library/Import/Help & Feedback) is dropped; Help & Feedback (no system
   behind it) removed. One library home (V34): the floating `AssetsPopover` is deleted —
   the toolbar **Assets** button now expands the sidebar + selects the Assets tab.

## Selection / scene

7. ☑ **Select anything, even inside a group — Blender/Spline-style.** _(2026-06-13)_ Double-click
   drills ONE level deeper toward the sub-mesh under the cursor (whole import → body → wheel →
   leaf); repeat to go deeper; **Esc** pops back up a level. The deep glTF mesh maps to its
   GltfChild via `GltfAsset.nodeNameMap`; drill depth lives in a dedicated `drillStore` (survives
   the single-click that precedes every double-click). Single click still selects the whole
   import. **✅ Fixed for real models _(2026-06-14, `c5f18fc`, [[H90]] RESOLVED)_:** drill now
   addresses children by a STAMPED node-INDEX id, not by name. GltfAssetR stamps each clone object's
   `userData.basherGltfChildId` via `gltf.parser.associations` × the persisted `keyByGltfNodeIndex`;
   `buildGltfDrillChain` walks the hit's ancestors reading those stamps (name-match kept as a fallback
   for pre-2026-06-14 saves). Observed on the real cicada: 0 undrillable meshes (was ~28%), a named
   part drills to its GltfChild. _(Wider follow-up still open: per-child TRS/material OVERRIDES in
   GltfAssetR also address by name and silently no-op on name-mismatched children — fixable via the
   same stamp; tracked in [[H90]].)_

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
