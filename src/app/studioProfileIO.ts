// studioProfileIO — JSON import/export for lighting PROFILES (epic #201, slice
// #208; §7.5). Grounded in BLS `light_profiles.py` (`compose_profile` /
// `parse_profile` / Import/ExportProfiles): a profile file is `{version, profiles:
// [{name, center, radius, lights:[…]}]}` — the portable `.bls` model, adapted to
// Basher's params (an AreaLight's position/intensity/color/size/rotation/scale +
// the optional studio `tex`). Export serializes a rig subgraph; import rebuilds it
// as `LightRig` + `AreaLight`s + their `Track-To`s, wired through the
// `LightProfileSelect` ([[V63]]). Pure — compose reads the node table, the import
// builder returns an Op chain (the caller dispatches atomically, V1).
//
// Texture portability: a light's `tex` is an OPFS env-hdri assetRef (content hash,
// V47/V41). Carrying the ref makes profiles portable WITHIN the same app/OPFS
// (copy-between-scenes, the BLS use case). Cross-app transfer needs the texture
// bytes too — that is the `.basher` bundle's job (V41), out of scope for the JSON.
//
// REF: src/app/studioProfiles.ts (the in-app reader/builders); src/nodes/LightRig.ts;
//      src/nodes/AreaLight.ts; src/nodes/TrackTo.ts;
//      /tmp/bls-study/src/light_profiles.py (the grounded reference); vyapti V63.

import { z } from 'zod';
import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { activeProfileSelect, enumerateProfiles, uniqueProfileName } from './studioProfiles';
import { nextConstraintOrder } from './nodeConstraints';
import { isAreaLightNode, lightParamsOf } from './lightNode';

type Vec3 = [number, number, number];

const Vec3Schema = z.tuple([z.number(), z.number(), z.number()]);

export const ProfileLightSchema = z.object({
  position: Vec3Schema,
  intensity: z.number(),
  color: z.string(),
  width: z.number(),
  height: z.number(),
  rotation: Vec3Schema.default([0, 0, 0]),
  scale: Vec3Schema.default([1, 1, 1]),
  tex: z.string().optional(),
});
export type ProfileLightJson = z.infer<typeof ProfileLightSchema>;

export const ProfileSchema = z.object({
  name: z.string(),
  center: Vec3Schema.default([0, 0, 0]),
  radius: z.number().default(6),
  lights: z.array(ProfileLightSchema),
});
export type ProfileJson = z.infer<typeof ProfileSchema>;

export const PROFILES_FORMAT = 'basher-light-profiles';
export const PROFILES_VERSION = 1;

export const ProfilesFileSchema = z.object({
  format: z.literal(PROFILES_FORMAT),
  version: z.number(),
  profiles: z.array(ProfileSchema),
});
export type ProfilesFileJson = z.infer<typeof ProfilesFileSchema>;

function vec3(v: unknown, fallback: Vec3): Vec3 {
  return Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number')
    ? (v as Vec3)
    : fallback;
}

/** Serialize one rig (profile) to the portable JSON shape. Null when not a rig. */
export function composeProfile(state: DagState, rigId: string): ProfileJson | null {
  const rig = state.nodes[rigId];
  if (!rig || rig.type !== 'LightRig') return null;
  const rp = rig.params as { name?: unknown; center?: unknown; radius?: unknown };

  // The rig's light node ids in edge order (the SAME order the renderer uses).
  const binding = rig.inputs.lights;
  const refs = Array.isArray(binding) ? binding : binding ? [binding] : [];
  const lights: ProfileLightJson[] = [];
  for (const ref of refs) {
    const ln = state.nodes[ref.node];
    // #386 C3 — a rig light is now an Object posing an Area LightData. The POSE
    // (position/rotation/scale) is on the Object; the SHADING
    // (intensity/color/width/height/tex) is on the LightData. Relaxing only the type gate
    // is NOT enough — the shading reads must reach through `data` (via lightParamsOf) or the
    // export silently emits the fallback constants (5 / #ffffff / 2×2), a silent data loss on
    // round-trip. A still-fused AreaLight resolves both to its own params (coexistence).
    if (!ln || !isAreaLightNode(state.nodes, ref.node)) continue;
    const p = ln.params as Record<string, unknown>;
    const s = lightParamsOf(state.nodes, ref.node) ?? {};
    const light: ProfileLightJson = {
      position: vec3(p.position, [0, 0, 0]),
      intensity: typeof s.intensity === 'number' ? s.intensity : 5,
      color: typeof s.color === 'string' ? s.color : '#ffffff',
      width: typeof s.width === 'number' ? s.width : 2,
      height: typeof s.height === 'number' ? s.height : 2,
      rotation: vec3(p.rotation, [0, 0, 0]),
      scale: vec3(p.scale, [1, 1, 1]),
      ...(typeof s.tex === 'string' && s.tex ? { tex: s.tex } : {}),
    };
    lights.push(light);
  }

  return {
    name: typeof rp.name === 'string' ? rp.name : 'Profile',
    center: vec3(rp.center, [0, 0, 0]),
    radius: typeof rp.radius === 'number' ? rp.radius : 6,
    lights,
  };
}

/**
 * Serialize profiles to a file object. `rigIds` selects which (default: ALL, in
 * node-table order) — mirrors BLS "Export Selected Profile" vs "Export All".
 */
export function composeProfilesFile(state: DagState, rigIds?: readonly string[]): ProfilesFileJson {
  const ids = rigIds ?? enumerateProfiles(state).map((p) => p.rigId);
  const profiles: ProfileJson[] = [];
  for (const id of ids) {
    const p = composeProfile(state, id);
    if (p) profiles.push(p);
  }
  return { format: PROFILES_FORMAT, version: PROFILES_VERSION, profiles };
}

/** Parse + validate a profiles file (throws on a bad shape). */
export function parseProfilesFile(raw: unknown): ProfilesFileJson {
  return ProfilesFileSchema.parse(raw);
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

export interface ImportProfilesResult {
  readonly ops: Op[];
  /** The name of the first imported profile (activated), or null when none. */
  readonly activatedName: string | null;
}

/**
 * Build the Op chain to import profiles: each becomes a `LightRig` + its
 * `AreaLight`s (each aimed at the rig centre by a fresh `Track-To`), wired into the
 * scene's `LightProfileSelect` (created on the first need, like buildAddProfileOps).
 * The first imported profile is activated. Imported names are SUFFIXED when they
 * collide with an existing profile (BLS appends a timestamp; we append " (N)") so
 * the name-keyed select stays unambiguous. Returns no-op result when there is no
 * scene or no profiles.
 */
export function buildImportProfilesOps(
  state: DagState,
  file: ProfilesFileJson,
): ImportProfilesResult {
  const sceneRef = state.outputs.scene;
  if (!sceneRef || file.profiles.length === 0) return { ops: [], activatedName: null };
  const sceneId = sceneRef.node;

  const ops: Op[] = [];
  // Track names minted in THIS import too, so two same-named imported profiles also
  // de-dupe against each other (not just against existing ones).
  const mintedNames = new Set<string>();

  // Ensure a select exists + feeds the scene.
  let selId = activeProfileSelect(state);
  if (!selId) {
    selId = newId('profsel');
    ops.push(
      {
        type: 'addNode',
        nodeId: selId,
        nodeType: 'LightProfileSelect',
        params: { selectedProfile: '' },
      },
      {
        type: 'connect',
        from: { node: selId, socket: 'out' },
        to: { node: sceneId, socket: 'lightRig' },
      },
    );
  }

  let activatedName: string | null = null;
  for (const profile of file.profiles) {
    // De-dupe against existing profiles AND names minted earlier in this import
    // (the select keys by name, V63 — collisions make the active profile ambiguous).
    const name = uniqueProfileName(state, profile.name, mintedNames);
    mintedNames.add(name);
    if (activatedName === null) activatedName = name;
    const rigId = newId('rig');
    ops.push({
      type: 'addNode',
      nodeId: rigId,
      nodeType: 'LightRig',
      params: { name, center: profile.center, radius: profile.radius },
    });
    ops.push({
      type: 'connect',
      from: { node: rigId, socket: 'out' },
      to: { node: selId, socket: 'rigs' },
    });

    for (const light of profile.lights) {
      const lightId = newId('light');
      const dataId = newId('data');
      const ttId = newId('tt');
      // #386 Stage C (C3) — an imported studio light is split-native: a LightData (the Area
      // shading + `lookAt` aim) and an Object (pose) that inherits `lightId`, so the rig
      // `lights` wire, the Track-To target, and the panel's `data`-aware enumeration all
      // resolve exactly as before the split.
      ops.push(
        {
          type: 'addNode',
          nodeId: dataId,
          nodeType: 'LightData',
          params: {
            lightKind: 'Area',
            intensity: light.intensity,
            color: light.color,
            width: light.width,
            height: light.height,
            lookAt: profile.center,
            ...(light.tex ? { tex: light.tex } : {}),
          },
        },
        {
          type: 'addNode',
          nodeId: lightId,
          nodeType: 'Object',
          params: {
            position: light.position,
            rotation: light.rotation,
            scale: light.scale,
          },
        },
        {
          type: 'connect',
          from: { node: dataId, socket: 'out' },
          to: { node: lightId, socket: 'data' },
        },
        {
          type: 'connect',
          from: { node: lightId, socket: 'out' },
          to: { node: rigId, socket: 'lights' },
        },
        {
          type: 'addNode',
          nodeId: ttId,
          nodeType: 'TrackTo',
          params: {
            name: 'aim',
            target: lightId,
            aimNode: '',
            aimPoint: profile.center,
            up: [0, 1, 0],
            mute: false,
            // #317 — through the shared top-of-stack rule, like every other creation
            // road. A freshly-created light has an empty stack → 0: byte-identical.
            order: nextConstraintOrder(state.nodes, lightId),
          },
        },
      );
    }
  }

  // Activate the first imported profile.
  if (activatedName !== null) {
    ops.push({
      type: 'setParam',
      nodeId: selId,
      paramPath: 'selectedProfile',
      value: activatedName,
    });
  }

  return { ops, activatedName };
}
