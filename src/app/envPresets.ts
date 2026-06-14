// UX #9 — the catalog of drei built-in environment presets (HDRIs drei fetches
// from a CDN at runtime). Shared by the renderer (SceneEnvironment, narrowing to
// drei's PresetsType) and the inspector control (the preset dropdown), so the
// list has ONE source. drei-free on purpose — the inspector must not pull the
// drei type just to render a <select>.
//
// REF: @react-three/drei environment-assets (PresetsType); vyapti V47.

export const ENV_PRESET_NAMES = [
  'apartment',
  'city',
  'dawn',
  'forest',
  'lobby',
  'night',
  'park',
  'studio',
  'sunset',
  'warehouse',
] as const;

export type EnvPresetName = (typeof ENV_PRESET_NAMES)[number];

export function isEnvPresetName(name: string): name is EnvPresetName {
  return (ENV_PRESET_NAMES as readonly string[]).includes(name);
}
