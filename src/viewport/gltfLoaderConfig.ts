// glTF loader configuration — registers KTX2 (Basis Universal texture
// compression) on the GLTFLoader drei's `useGLTF` builds internally, and
// points Draco at a self-hosted decoder under `/draco/` (NOT the Google
// CDN drei defaults to).
//
// Why this exists (#80):
//   - drei's default `useGLTF(url)` (no extra args) wires `dracoLoader`
//     pointing at `https://www.gstatic.com/draco/versioned/decoders/...`
//     (drei `Gltf.js:8`). That CDN fetch is (a) non-deterministic per
//     THESIS §48 (network call into the render path) and (b) fails
//     silently offline / behind a CSP. Real-world `.glb` exports almost
//     always use Draco mesh compression (Blender's default exporter,
//     Sketchfab, glTF-Transform pipelines), so the failure mode is
//     "imports a hand-made cube but anything real silently doesn't
//     load." Fix: pass a SELF-HOSTED path (`/draco/`) — drei wires the
//     DRACOLoader for us, just at our own decoder.
//   - `MeshoptDecoder` is already wired by drei (default
//     `useMeshopt=true`) — no extra work needed here, kept for the
//     record so a future reader doesn't go looking.
//   - `KTX2Loader` (Basis Universal textures — KHR_texture_basisu,
//     extremely common in size-optimised exports) is NOT wired by drei
//     at all. We register it via `extendLoader`, which drei calls on
//     the GLTFLoader instance before Draco/Meshopt wiring. KTX2 needs
//     the renderer for transcoder format detection
//     (`.detectSupport(gl)`), so this is a hook that takes the live
//     R3F renderer from `useThree`.
//
// Self-hosted decoder assets (committed under `public/`):
//   - `/draco/`  — `draco_decoder.{js,wasm}`, `draco_wasm_wrapper.js`,
//                  copied from `three/examples/jsm/libs/draco/`.
//   - `/basis/`  — `basis_transcoder.{js,wasm}`, copied from
//                  `three/examples/jsm/libs/basis/`.
//
// V20 / V8 / V1: pure config wiring. No DAG mutation, no React state
// in the helper itself (the hook subscribes to `useThree(s => s.gl)`,
// which is the canonical R3F renderer accessor; cadence is renderer-
// change, not per-frame).
//
// REF: #80, THESIS §39 (P1 node types), THESIS §48 (determinism — no
// CDN nondeterminism), `src/viewport/SceneFromDAG.tsx` GltfAssetR
// (the consumer).

import { useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import { KTX2Loader } from 'three-stdlib';
import type { GLTFLoader } from 'three-stdlib';
import type { WebGLRenderer } from 'three';

/** Self-hosted decoder paths. Served from `public/` at the app root. */
export const DRACO_DECODER_PATH = '/draco/';
export const KTX2_TRANSCODER_PATH = '/basis/';

/**
 * Builds a memoised `extendLoader` for drei's `useGLTF` that wires
 * KTX2 (Basis Universal) onto the GLTFLoader. Draco is handled by
 * drei itself via the `useDraco` arg (string → self-hosted path).
 *
 * Memoised on the renderer instance: a new R3F Canvas root (rare —
 * usually one Canvas per app) gets a fresh KTX2Loader with that
 * renderer's transcoder-support probed. Same renderer → same loader.
 *
 * Returns `undefined` when no renderer is available yet (first render
 * before `useThree.gl` is populated). drei tolerates undefined; the
 * GLTFLoader runs without KTX2 — Draco/Meshopt still work. The next
 * render once `gl` is populated triggers the real wire-up.
 */
export function useGltfLoaderExtend(): ((loader: GLTFLoader) => void) | undefined {
  const gl = useThree((s) => s.gl) as WebGLRenderer | undefined;

  return useMemo(() => {
    if (!gl) return undefined;
    const ktx2 = new KTX2Loader();
    ktx2.setTranscoderPath(KTX2_TRANSCODER_PATH);
    ktx2.detectSupport(gl);
    return (loader: GLTFLoader) => {
      loader.setKTX2Loader(ktx2);
    };
  }, [gl]);
}
