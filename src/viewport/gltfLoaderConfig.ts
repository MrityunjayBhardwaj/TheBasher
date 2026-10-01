// Self-hosted decoder paths for glTF imports (#80).
//
// Why self-hosted: a decoder fetched from a CDN is a network call into the import
// path — non-deterministic (THESIS §48) and silently failing offline or behind a
// CSP. Real-world `.glb` exports almost always use Draco mesh compression, so the
// decoder ships with the app under `public/`.
//
// Decoder assets (committed under `public/`):
//   - `/draco/`  — `draco_decoder.{js,wasm}`, `draco_wasm_wrapper.js`,
//                  copied from `three/examples/jsm/libs/draco/`. Loaded by
//                  `src/app/asset/dracoDecoder.ts`.
//
// No KTX2/Basis transcoder ships (#1417): the import refuses a KTX2 texture by name
// (#1063) rather than reading it, so a transcoder would be bytes nothing loads. It
// comes back in the same change as the reader that needs it.
//
// REF: #80, #1063, #1417, THESIS §48.

/** Self-hosted decoder path. Served from `public/` at the app root. */
export const DRACO_DECODER_PATH = '/draco/';
