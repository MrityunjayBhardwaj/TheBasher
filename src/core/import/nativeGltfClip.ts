// #1051 — a glTF clip read into ordinary keyframe channels, or refused by name.
//
// ── WHAT A CLIP BECOMES ─────────────────────────────────────────────────────────────────────────
//
// One channel per animated (node, path): `translation` and `scale` become `KeyframeChannelVec3`
// keys, `rotation` becomes `KeyframeChannelQuat` keys on a node already in quaternion mode — the
// shape Blender's importer produces (`io_scene_gltf2/blender/imp/animation_node.py:73-92`, one
// F-curve group per path on an object in QUATERNION mode). Keys stay at the file's own times: the
// spec starts every clip at t = 0 and clamps outside the keyed range (`Specification.adoc:2806`),
// which is what a channel does, and Blender keeps the times too (`animation_node.py:152-155`).
//
// ── HOW EACH INTERPOLATION LANDS, AND WHERE IT DIFFERS FROM BLENDER ─────────────────────────────
//
//   STEP        → 'constant'. Measured identical to Blender (STEP → CONSTANT, animation_utils.py:73).
//   LINEAR      → 'linear'. On a rotation that is slerp, as the spec defines it (`:3576-3600`).
//                 Blender lerps the four components instead: 7.15° off the spec, measured.
//   CUBICSPLINE → bézier handles at ±Δt/3 carrying the file's tangents, which is the spec's Hermite
//                 curve exactly (2.5e-8 over 12,012 samples, measured). Blender drops the tangents
//                 (`animation_node.py:67-69`, "TODO manage tangent?"): 1.92 units off, measured.
//                 A CUBICSPLINE ROTATION has no handles to land in and is refused (#1157).
//
// ── WHAT IS REFUSED ─────────────────────────────────────────────────────────────────────────────
//
// Refused whole, by name, like every other native-import refusal: a second clip (#1154), a morph
// weights track (#1060), a CUBICSPLINE rotation (#1157), an accessor this reader cannot read
// correctly (sparse, bufferless, interleaved — `readAccessor` would silently misread each), and a
// file that breaks the spec's own rules for animation data. A channel with no target node is
// skipped, which is what the spec says to do with it (`:2782`).
//
// REF: glTF 2.0 `Specification.adoc` §3.11 + Appendix C, `schema/animation.sampler.schema.json`
//      (ref/sources/gltf-spec); Blender `io_scene_gltf2/blender/imp/animation_{node,utils}.py`;
//      issues #1051, #1154, #1157, #1060.

import { readAccessor, type GltfJson } from './glb';
import type { NativeImportRefusal } from './nativeGltfImport';
import type { Quat, Vec3 } from '../../nodes/types';

/** The slice of a glTF document the clip reader looks at. */
export interface ClipGltfJson {
  nodes: { matrix?: number[] }[];
  accessors?: {
    bufferView?: number;
    byteOffset?: number;
    componentType: number;
    count: number;
    type: string;
    normalized?: boolean;
    min?: number[];
    max?: number[];
    sparse?: unknown;
  }[];
  bufferViews?: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }[];
  animations?: {
    name?: string;
    channels: { sampler: number; target: { node?: number; path: string } }[];
    samplers: { input: number; output: number; interpolation?: string }[];
  }[];
}

export interface Vec3ClipKey {
  time: number;
  value: Vec3;
  easing: 'linear' | 'constant' | 'cubic';
  inHandle?: { time: number; value: Vec3 };
  outHandle?: { time: number; value: Vec3 };
}
export interface QuatClipKey {
  time: number;
  value: Quat;
  easing: 'linear' | 'constant';
}

export type ClipChannel =
  | { node: number; path: 'translation' | 'scale'; keyframes: Vec3ClipKey[] }
  | { node: number; path: 'rotation'; keyframes: QuatClipKey[] };

const FLOAT = 5126;
const COMPONENT_BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5126: 4 };
/** The spec's output table (`Specification.adoc:2818-2832`): rotation may be normalized integers. */
const ROTATION_COMPONENTS = new Set([FLOAT, 5120, 5121, 5122, 5123]);
const WIDTH: Record<string, number> = { SCALAR: 1, VEC3: 3, VEC4: 4 };

const vec3 = (a: readonly number[]): Vec3 => [a[0], a[1], a[2]];
const quat = (a: readonly number[]): Quat => [a[0], a[1], a[2], a[3]];

const malformed = (why: string): NativeImportRefusal => ({
  refused: `its animation ${why}, which the glTF spec does not allow`,
  issue: '#1063',
});

/** Why an accessor cannot be read here, or null. `readAccessor` reads a contiguous, dense run. */
function unreadable(json: ClipGltfJson, index: number, what: string): NativeImportRefusal | null {
  const accessor = json.accessors?.[index];
  if (!accessor) return malformed(`${what} names accessor ${index}, which does not exist`);
  if (accessor.sparse !== undefined) {
    return {
      refused: `its animation ${what} is a sparse accessor, which this reader does not expand`,
      issue: '#1063',
    };
  }
  if (typeof accessor.bufferView !== 'number') {
    return {
      refused: `its animation ${what} has no buffer view, which this reader does not read`,
      issue: '#1063',
    };
  }
  const stride = json.bufferViews?.[accessor.bufferView]?.byteStride;
  const element = (COMPONENT_BYTES[accessor.componentType] ?? 0) * (WIDTH[accessor.type] ?? 0);
  if (typeof stride === 'number' && stride !== element) {
    return {
      refused: `its animation ${what} is interleaved, which this reader does not split`,
      issue: '#1063',
    };
  }
  return null;
}

/**
 * The file's clip as channels, or the reason it cannot come across. A file with no animation reads
 * as no channels.
 */
export function readNativeClip(
  json: ClipGltfJson,
  buffers: Uint8Array[],
): { channels: ClipChannel[] } | NativeImportRefusal {
  const animations = json.animations ?? [];
  if (animations.length === 0) return { channels: [] };
  if (animations.length > 1) {
    return {
      refused: `it carries ${animations.length} animation clips, and only one can come across until clips become Actions`,
      issue: '#1154',
    };
  }
  // The loose shape above admits what glTF files carry and `GltfJson` does not type (a `weights`
  // path, a sparse or bufferless accessor), so they can be refused. Each accessor is checked by
  // `unreadable` before `readAccessor` touches it, which is what makes this view of it sound.
  const asGltf = json as unknown as GltfJson;
  const animation = animations[0];
  const seen = new Set<string>();
  const channels: ClipChannel[] = [];
  for (const channel of animation.channels) {
    const { node, path } = channel.target;
    // The spec: a channel with no node is ignored unless an extension supplies the target
    // (`:2782`), and an extension that would is already refused as one this reader does not hold.
    if (typeof node !== 'number') continue;
    if (path === 'weights') {
      return {
        refused: 'it animates morph target weights, which the native model does not hold yet',
        issue: '#1060',
      };
    }
    if (path !== 'translation' && path !== 'rotation' && path !== 'scale') {
      return malformed(`animates a path "${path}"`);
    }
    if (!json.nodes[node]) return malformed(`targets node ${node}, which does not exist`);
    if (json.nodes[node].matrix) {
      return malformed(`animates the ${path} of node ${node}, which is given as a matrix`); // :2786
    }
    const key = `${node}/${path}`;
    if (seen.has(key)) return malformed(`targets node ${node}'s ${path} twice`); // :2796
    seen.add(key);

    const sampler = animation.samplers[channel.sampler];
    if (!sampler) return malformed(`names sampler ${channel.sampler}, which does not exist`);
    const interpolation = sampler.interpolation ?? 'LINEAR';
    if (interpolation !== 'LINEAR' && interpolation !== 'STEP' && interpolation !== 'CUBICSPLINE') {
      return malformed(`uses an interpolation "${interpolation}"`);
    }
    if (interpolation === 'CUBICSPLINE' && path === 'rotation') {
      return {
        refused: `it animates node ${node}'s rotation as CUBICSPLINE, and a quaternion channel has no handles to hold the tangents`,
        issue: '#1157',
      };
    }

    // Input: float scalars with min/max (`:2833`), time[0] >= 0 and strictly increasing (schema).
    const inputRefusal = unreadable(json, sampler.input, 'input');
    if (inputRefusal) return inputRefusal;
    const input = json.accessors![sampler.input];
    if (input.type !== 'SCALAR' || input.componentType !== FLOAT) {
      return malformed(`input ${sampler.input} is not float scalars`);
    }
    if (!Array.isArray(input.min) || !Array.isArray(input.max)) {
      return malformed(`input ${sampler.input} has no min and max`);
    }
    const times = readAccessor(asGltf, buffers, sampler.input);
    if (times.length === 0) return malformed(`input ${sampler.input} has no keys`);
    if (times[0] < 0) return malformed(`input ${sampler.input} starts before 0`);
    for (let i = 1; i < times.length; i++) {
      if (!(times[i] > times[i - 1])) {
        return malformed(`input ${sampler.input} is not strictly increasing`);
      }
    }
    if (interpolation === 'CUBICSPLINE' && times.length < 2) {
      return malformed(`samples CUBICSPLINE from a single key`); // :3614
    }

    // Output: the spec's type table, one value per key (three per key for CUBICSPLINE, `:3615`).
    const outputRefusal = unreadable(json, sampler.output, 'output');
    if (outputRefusal) return outputRefusal;
    const output = json.accessors![sampler.output];
    const width = path === 'rotation' ? 4 : 3;
    const typeOk =
      output.type === (width === 4 ? 'VEC4' : 'VEC3') &&
      (path === 'rotation'
        ? output.componentType === FLOAT ||
          (ROTATION_COMPONENTS.has(output.componentType) && output.normalized === true)
        : output.componentType === FLOAT);
    if (!typeOk) return malformed(`output ${sampler.output} is not a ${path} the spec allows`);
    const perKey = interpolation === 'CUBICSPLINE' ? 3 : 1;
    if (output.count !== times.length * perKey) {
      return malformed(
        `output ${sampler.output} holds ${output.count} values for ${times.length} keys`,
      );
    }
    const values = readAccessor(asGltf, buffers, sampler.output);
    const at = (k: number, slot: number): number[] =>
      Array.from(values.subarray((k * perKey + slot) * width, (k * perKey + slot + 1) * width));

    if (path === 'rotation') {
      const easing = interpolation === 'STEP' ? 'constant' : 'linear';
      channels.push({
        node,
        path,
        keyframes: Array.from(times, (time, k) => ({ time, value: quat(at(k, 0)), easing })),
      });
      continue;
    }
    if (interpolation !== 'CUBICSPLINE') {
      const easing = interpolation === 'STEP' ? 'constant' : 'linear';
      channels.push({
        node,
        path,
        keyframes: Array.from(times, (time, k) => ({ time, value: vec3(at(k, 0)), easing })),
      });
      continue;
    }
    // CUBICSPLINE: per key [in-tangent a, value v, out-tangent b], tangents per second. The spec's
    // Hermite segment p(u) = h00·v_k + Δt·h10·b_k + h01·v_k+1 + Δt·h11·a_k+1 IS the cubic bézier
    // whose inner controls sit at v_k + b_k·Δt/3 and v_k+1 − a_k+1·Δt/3, a third of the span in
    // from each end — and with the time handles at ±Δt/3 the bézier's time is linear in its
    // parameter, so it is sampled at exactly the spec's u. The first in-tangent and last
    // out-tangent are unused (`:3638`), so those handles are not written.
    channels.push({
      node,
      path,
      keyframes: Array.from(times, (time, k) => {
        const key: Vec3ClipKey = { time, value: vec3(at(k, 1)), easing: 'cubic' };
        if (k > 0) {
          const dt = time - times[k - 1];
          key.inHandle = { time: -dt / 3, value: vec3(at(k, 0).map((a) => (-a * dt) / 3)) };
        }
        if (k < times.length - 1) {
          const dt = times[k + 1] - time;
          key.outHandle = { time: dt / 3, value: vec3(at(k, 2).map((b) => (b * dt) / 3)) };
        }
        return key;
      }),
    });
  }
  return { channels };
}
