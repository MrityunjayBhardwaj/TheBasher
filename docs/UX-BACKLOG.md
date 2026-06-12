# UX Backlog — Spline/Blender-grade editor polish

Working list captured 2026-06-12 from director-use friction. Branch off `ux-overhall`,
one fix per atomic commit, friction-first (observe the live app before + after).
Status: ☐ todo · ◐ in progress · ☑ done.

## Chrome / layout

1. ☐ **Fix the transform gizmo head.** The translate gizmo arrowheads/handles render wrong.
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

7. ☐ **Select anything, even inside a group — Blender-style.** Repeated double-clicks drill
   deeper into groups → sub-groups, selecting the leaf under the cursor.

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
