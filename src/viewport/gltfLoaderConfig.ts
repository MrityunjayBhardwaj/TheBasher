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
//   - `/basis/`  — `basis_transcoder.{js,wasm}`, copied from
//                  `three/examples/jsm/libs/basis/`. NOTHING LOADS IT TODAY: the
//                  loader hook that wired KTX2 belonged to the clone renderer and
//                  went with it (#1053). The import refuses a KTX2 texture by name
//                  (#1063) rather than reading it.
//
// REF: #80, #1063, THESIS §48.

/** Self-hosted decoder paths. Served from `public/` at the app root. */
export const DRACO_DECODER_PATH = '/draco/';
export const KTX2_TRANSCODER_PATH = '/basis/';
