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
2. ☑ **Floating-island panels (Spline-style) — DONE (2026-06-14).** Every chrome panel is now a
   detached, rounded island floating OVER a full-bleed viewport, not a docked grid band. Two slices:
   _(a) side islands_ — the `tree | viewport | inspector` grid collapsed to one full-bleed column;
   the outliner (left) + inspector (right) mount as absolute rounded islands inside `<main>`,
   TOP-anchored and stopping short of a reserved `BOTTOM_BAND` so the already-floating bottom-right
   orbit gizmo + Persp/Ortho stay clear (no widget has to dodge the inspector — the H91/V45
   overlap trap). _(b) bottom islands_ — the agentdock + timeline grid rows are gone; the agent chat
   + timeline float as a **stacked bottom-center** island group (chat above, timeline below;
   user-chosen arrangement), so the viewport reads full-bleed top→bottom. New `src/app/layoutIslands.ts`
   is the single source of truth for island geometry. Island wrappers reuse the FloatingViewportToolbar
   surface tokens (rounded-2xl border bg-bg-2/95 shadow-xl backdrop-blur-md — V39/contrast-matrix
   covered); inner panels render transparent. The toolbar pill (centered over the full-bleed viewport)
   is width-capped (`CENTER_SIDE_RESERVED`) so it can't slide under a side island; right-click on a
   panel stops propagation so it no longer pops the viewport Add menu; the orbit hint moved above the
   bottom stack. Fixed-position, collapsible (V35), non-draggable. Gates: vitest 1519 / tsc 0 /
   eslint 0 / prettier / e2e (new `ux2-floating-islands` 7 + updated spline-wc/wf geometry).
3. ☑ **Remove the STUB/LIVE toggle** (top-right corner). _(ComfyStatusIndicator unmounted from ProjectTabs.)_
4. ☑ **Remove Save + Projects from the top-right corner.** Move the projects list under **File**.
   _(Save → File ▸ Save / Cmd+S; projects → File ▸ Switch Project submenu.)_
5. ☑ **Fix the toolbar menus — DONE end-to-end (2026-06-14).** Three slices:
   _(a) toolbar-menu OPEN POSITION_ `5fd98d1` [[H91]] — the "+ Add" menu anchored at the
   button's TOP edge (leftover from the bottom pill that "opened upward") rendered OVER the
   toolbar row; now a shared `toolbarMenuAnchor` opens it just below the WHOLE pill,
   left-aligned (gate `ux5-toolbar-menu-position.spec.ts`).
   _(b) submenu EDGE-AWARE PLACEMENT_ `4f5ead1` — MenuBar's Submenu and AddMenu's group
   submenus hardcoded `left-full` and ran off the right viewport edge (observed 56px @640w
   and 191px @1280w near the edge). One shared `useFlyoutSide` hook now measures the trigger
   on open and places the panel by preference (open right → flip left → clamp to the edge;
   the left-aligned bar is too near x=0 for a pure flip, so it needs a clamp). AddMenu's root
   clamp also gained `Math.max(8, …)` lower bounds on both axes (gate
   `ux5-menu-submenu-edge.spec.ts`). _(c) BEHAVIOUR_ `ee1f9ed` — MenuBar gained hover-switch
   (once a menu is open, hovering another top-level button switches to it; the first still
   needs a click) and keyboard navigation (ArrowLeft/Right between top-level menus,
   ArrowDown/Up/Home/End rove the open panel's enabled items) (gate
   `ux5-menubar-behaviour.spec.ts`). Shared primitive over N per-menu patches (V34).
   _Known follow-ups (minor, not observed in use): submenu VERTICAL overflow near the bottom
   isn't clamped (only horizontal); `src/app/ProjectsMenu.tsx` is dead code superseded by
   File ▸ Switch Project (#4) and can be removed._
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
   part drills to its GltfChild. _(Wider follow-up CLOSED 2026-06-14, `54c249e`: per-child TRS +
   suppression in GltfAssetR now resolve by the stamped `basherGltfChildId` (name fallback for
   pre-UX#7 saves) via the shared `gltfChildObjects.ts` helper — material overrides were already
   slot-index based, not by-name. [[H90]] follow-up resolved.)_

## Materials / textures / lighting

8. ☑ **glTF materials visible/inspectable (read-only) — DONE (2026-06-14, `d28542f`).** A glTF's
   embedded materials live only on the three.js clone, never in the DAG, so the inspector's MATERIAL
   section was empty (asset) / absent (child). Now the renderer publishes a read-only per-slot
   material projection (`readGltfMaterials` → `gltfMaterialStore`, the V33 pattern) and the inspector's
   MATERIAL section renders it for a GltfAsset (all slots) or GltfChild (its slots): material name,
   base-color swatch, metalness, roughness, opacity, bound texture maps. Editing stays with the
   MaterialOverride wrapper (scope chosen: read-only inspect). _(Notes: shows POST-override = what's
   drawn; a pure-transform parent child shows "No materials on this part"; full editable per-child
   extraction was the larger option not taken.)_
9. ☐ **HDRI support.** Add environment/HDRI lighting.
10. ☑ **Textures in the UV editor — DONE (2026-06-15).** The UV editor now paints the
    selected mesh's bound **base-color (albedo)** map as a dimmed backdrop UNDER the UV
    islands, Blender-style (it used to draw only green island outlines on an empty 0..1
    grid — the director couldn't see which part of the texture each island maps to).
    Resolved through ONE pure producer-aware `resolveMeshTexture` — the V33 read-only-
    projection SIBLING of `resolveMeshUVs`, so the panel and the `__basher_uv_texture`
    side-B seam never drift (H40): glTF clone `material.map` (sync); BakedMesh / primitive
    `maps.albedo` via a new non-throwing `peekBakedTexture` (status `loading` reuses the
    existing retry; a decode failure → grid-only, never a crash). The backdrop's vertical
    orientation follows the texture's `flipY` so the texel a UV vertex samples sits BEHIND
    it (glTF maps are flipY=false / top-left origin → drawn flipped to register with the
    islands' V-up `(1-v)` display — V48). A header **Texture** toggle (shown only when a map
    resolves) hides/shows it. Observed on a 64×64 asymmetric fixture (UV(0,0)'s green corner
    lands exactly where glTF sampling predicts) AND the real 100MB cicada (706 children; a
    textured child shows its 1024×1024 atlas with islands registered). Defaults: base color,
    UV0, 0.6 dim; an opacity slider + per-map picker are open follow-ups (no observed
    friction — multi-material whole-asset selection shows only the first map by design).
    Gates: vitest 1536 / tsc 0 / eslint 0 / prettier / e2e `ux10-uv-texture` 2/2.

## Animation

11. ☐ **Dopesheet / graph-editor timeline** modelled on
    [reze-studio](https://github.com/AmyangXYZ/reze-studio).

## Camera

12. ☐ **Blender-grade camera.** Full properties — FOV, depth of field, etc.

---

Each item, when started, gets a one-paragraph friction observation + plan in its commit body.
