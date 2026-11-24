// gpuComposite — the compositor's working space: float, linear light, on the GPU (#1883).
//
// The 2D canvas the composite used to draw on holds 8 bits per channel in display colour, so
// every blend, opacity and grade happened on sRGB-encoded numbers: a 50% mix of black and white
// came out at 128 instead of linear mid-grey (188 once encoded), and anything above 1.0 was
// clipped at the first layer. Here every source is converted INTO linear light on the way in
// (an sRGB picture through an sRGB texture, decoded by the hardware before filtering; a float
// picture as it is), layers blend in a half-float buffer, and the result is converted OUT to
// display colour once, at the end. That last conversion is where the tone curve and display
// transform will sit (#1872, #1876).
//
// One WebGL2 context, shared by the live viewer and the export (both call `drawComposite`), so
// what you see and what you export come from the same pass. When WebGL2 or float render targets
// are missing, `gpuCompositor()` returns null with a reason and the caller falls back to the 2D
// canvas path (display colour, as before) — a fallback that is reported, never silent.
//
// Pass order per frame (ping-pong between two RGBA16F buffers, premultiplied alpha):
//   clear → per draw: a LAYER (sample its texture through the inverse of its 2D transform,
//   premultiply, blend over the buffer so far) or an ADJUSTMENT (grade the buffer so far) →
//   OUTPUT (the comp background under it, encode to sRGB, into the canvas).
// A layer's OWN effects grade its texture first, in a float buffer of the texture's size.
//
// REF: issue #1883; composite.ts (planComposite + the 2D fallback); compositeDecode.ts (the
//      decode that hands over the pictures).

import type { EffectOp } from './composite';

/** A picture already in linear light, straight (not premultiplied) RGBA floats, row 0 at the
 *  top. The seam float sources (EXR #1885, render passes #1884) arrive through. */
export interface LinearImage {
  readonly kind: 'linear';
  readonly width: number;
  readonly height: number;
  readonly data: Float32Array;
}

/** A display-colour (sRGB) picture: a decoded frame, still or video. */
export type DisplayImage = CanvasImageSource & { width: number; height: number };

/** Anything a layer can draw. */
export type CompositeImage = DisplayImage | LinearImage;

export function isLinearImage(img: CompositeImage): img is LinearImage {
  return (img as { kind?: unknown }).kind === 'linear';
}

/** One step of the GPU pass, in back→front order. */
export type GpuDraw =
  | {
      readonly kind: 'layer';
      readonly image: CompositeImage;
      /** A stable key for `image`'s pixels (its upload is cached by it). */
      readonly imageKey: string;
      /** Comp pixel (top-left origin) → layer UV, column-major 3×3. */
      readonly inverse: Float32Array;
      readonly opacity: number;
      readonly blendMode: 'normal' | 'add' | 'multiply' | 'screen';
      /** The layer's own effects, base → top. */
      readonly effects: readonly EffectOp[];
    }
  | { readonly kind: 'adjust'; readonly effects: readonly EffectOp[] };

/**
 * The inverse of the 2D canvas transform a layer is drawn with (`drawComposite`): translate to
 * the comp centre plus `position`, rotate by `rotationDeg`, scale, then draw the picture fitted
 * to `dw`×`dh` centred on the origin. Maps a comp pixel (top-left origin, y down) to the layer's
 * UV (0..1, v down). Column-major 3×3. Null when the scale collapses the layer. PURE.
 */
export function layerInverseMatrix(
  W: number,
  H: number,
  position: readonly [number, number],
  rotationDeg: number,
  scale: readonly [number, number],
  dw: number,
  dh: number,
): Float32Array | null {
  const [sx, sy] = scale;
  if (sx === 0 || sy === 0 || dw <= 0 || dh <= 0) return null;
  const r = (rotationDeg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const tx = W / 2 + position[0];
  const ty = H / 2 + position[1];
  // u = ( c·(x−tx) + s·(y−ty)) / (sx·dw) + ½
  // v = (−s·(x−tx) + c·(y−ty)) / (sy·dh) + ½
  const a = c / (sx * dw);
  const b = s / (sx * dw);
  const d = -s / (sy * dh);
  const e = c / (sy * dh);
  const fu = -(a * tx + b * ty) + 0.5;
  const fv = -(d * tx + e * ty) + 0.5;
  // Column-major: [col0 | col1 | col2] where u = m0·x + m3·y + m6, v = m1·x + m4·y + m7.
  return new Float32Array([a, d, 0, b, e, 0, fu, fv, 1]);
}

/** sRGB-encoded 0..1 → linear light (the IEC 61966-2-1 curve). PURE. */
export function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** Linear light → sRGB-encoded (the IEC 61966-2-1 curve). PURE. */
export function linearToSrgb(v: number): number {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

const VERT = `#version 300 es
in vec2 aPos;
uniform vec2 uSize;
out vec2 vPx;
void main() {
  // Comp pixel coordinates, top-left origin, y down. Row 0 of every buffer is the comp's
  // BOTTOM row (GL's convention), and the output pass writes straight through, so the canvas
  // shows it the right way up.
  vPx = vec2((aPos.x * 0.5 + 0.5) * uSize.x, (0.5 - aPos.y * 0.5) * uSize.y);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const LAYER_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uBack;
uniform sampler2D uLayer;
uniform mat3 uInv;
uniform float uOpacity;
uniform int uMode;
in vec2 vPx;
out vec4 o;
void main() {
  vec4 b = texelFetch(uBack, ivec2(gl_FragCoord.xy), 0);
  vec2 uv = (uInv * vec3(vPx, 1.0)).xy;
  // #1888 — how much of this pixel the layer's rectangle covers, from the pixel's distance to
  // each edge measured in pixels (uv per pixel = fwidth). A pixel centre half a pixel inside
  // the edge is fully covered, so a layer drawn 1:1 is unchanged; a rotated or scaled edge
  // shades off over one pixel instead of stepping.
  vec2 inside = min(uv, 1.0 - uv) / max(fwidth(uv), vec2(1e-6));
  vec2 cov2 = clamp(inside + 0.5, 0.0, 1.0);
  float cov = cov2.x * cov2.y;
  // The layer texture is already linear and premultiplied (#1889), so filtering it does not
  // pull a transparent pixel's colour into its neighbours.
  vec4 s = cov > 0.0 ? texture(uLayer, clamp(uv, 0.0, 1.0)) : vec4(0.0);
  s *= cov * uOpacity;
  vec3 c;
  float a;
  if (uMode == 1) {        // add: src + dst (alpha too, clamped, as the canvas 'lighter')
    c = s.rgb + b.rgb;
    a = min(s.a + b.a, 1.0);
  } else {
    a = s.a + b.a * (1.0 - s.a);
    if (uMode == 2) {      // multiply (W3C separable blend, premultiplied)
      c = s.rgb * (1.0 - b.a) + b.rgb * (1.0 - s.a) + s.rgb * b.rgb;
    } else if (uMode == 3) { // screen
      c = s.rgb + b.rgb - s.rgb * b.rgb;
    } else {               // normal (source-over)
      c = s.rgb + b.rgb * (1.0 - s.a);
    }
  }
  o = vec4(c, a);
}`;

const GRADE_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec3 uBCS;      // brightness (gain), contrast (power about 18% grey), saturation
uniform int uPremult;   // 1: the buffer is premultiplied (the working buffer)
out vec4 o;
void main() {
  vec4 p = texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0);
  if (uPremult == 1 && p.a <= 0.0) { o = p; return; }
  vec3 c = uPremult == 1 ? p.rgb / p.a : p.rgb;
  c *= uBCS.x;
  c = 0.18 * pow(max(c, vec3(1e-8)) / 0.18, vec3(uBCS.y));
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = vec3(l) + uBCS.z * (c - vec3(l));
  o = vec4(uPremult == 1 ? c * p.a : c, p.a);
}`;

const PREP_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
out vec4 o;
void main() {
  // #1889 — a picture as uploaded (an sRGB texture, decoded to linear by texelFetch; or a
  // float picture, already linear), straight alpha, into a half-float buffer of its own size,
  // PREMULTIPLIED. GL row 0 is the texture's row 0, so this is a texel-for-texel copy.
  vec4 p = texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0);
  o = vec4(p.rgb * p.a, p.a);
}`;

const OUT_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec4 uBg;       // linear, straight; a = 0 for no background
out vec4 o;
vec3 enc(vec3 v) {
  vec3 lo = v * 12.92;
  vec3 hi = 1.055 * pow(max(v, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
  return mix(hi, lo, vec3(lessThanEqual(v, vec3(0.0031308))));
}
void main() {
  vec4 w = texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0);
  vec4 bg = vec4(uBg.rgb * uBg.a, uBg.a);
  vec4 p = w + bg * (1.0 - w.a);           // the background goes UNDER everything
  vec3 straight = p.a > 0.0 ? p.rgb / p.a : vec3(0.0);
  o = vec4(enc(clamp(straight, 0.0, 1.0)) * p.a, p.a); // the canvas is premultiplied
}`;

interface Program {
  readonly prog: WebGLProgram;
  readonly u: Record<string, WebGLUniformLocation | null>;
}

interface Target {
  readonly fbo: WebGLFramebuffer;
  readonly tex: WebGLTexture;
  readonly w: number;
  readonly h: number;
}

const TEX_CACHE_CAP = 32;

/** The shared GPU compositor. One per page; resized to whatever comp it is asked to draw. */
export interface GpuCompositor {
  /** The canvas the last `render` drew into (display colour, premultiplied alpha). */
  readonly canvas: HTMLCanvasElement;
  /** Draw `draws` at `W`×`H` over `background` (any CSS colour; '' = none). Synchronous: read
   *  `canvas` in the same task. */
  render(W: number, H: number, background: string, draws: readonly GpuDraw[]): void;
  /** The last frame's linear, premultiplied value at comp pixel (`x`, `y`), before the
   *  background and the display encoding. For measurement (float readback). */
  readLinear(x: number, y: number): [number, number, number, number];
}

let shared: GpuCompositor | null = null;
let unavailable: string | null = null;

/** The shared compositor, or null with `gpuUnavailableReason()` set when this browser can't
 *  run it (no WebGL2, or no float render targets). Recreated after a lost context. */
export function gpuCompositor(): GpuCompositor | null {
  if (shared) return shared;
  if (unavailable) return null;
  try {
    shared = create();
  } catch (e) {
    unavailable = e instanceof Error ? e.message : String(e);
    return null;
  }
  return shared;
}

/** Why the GPU compositor is not in use, or null when it is (or has not been asked for yet). */
export function gpuUnavailableReason(): string | null {
  return unavailable;
}

function create(): GpuCompositor {
  if (typeof document === 'undefined') throw new Error('no document');
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
  });
  if (!gl) throw new Error('WebGL2 is not available');
  if (!gl.getExtension('EXT_color_buffer_float')) {
    throw new Error('float render targets (EXT_color_buffer_float) are not available');
  }
  canvas.addEventListener('webglcontextlost', () => {
    if (shared?.canvas === canvas) shared = null;
  });

  const compile = (type: number, src: string) => {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error(`shader: ${gl.getShaderInfoLog(sh)}`);
    }
    return sh;
  };
  const vs = compile(gl.VERTEX_SHADER, VERT);
  const program = (frag: string, names: readonly string[]): Program => {
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, frag));
    gl.bindAttribLocation(prog, 0, 'aPos');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(`program: ${gl.getProgramInfoLog(prog)}`);
    }
    const u: Record<string, WebGLUniformLocation | null> = {};
    for (const n of names) u[n] = gl.getUniformLocation(prog, n);
    return { prog, u };
  };
  const layerP = program(LAYER_FRAG, ['uSize', 'uBack', 'uLayer', 'uInv', 'uOpacity', 'uMode']);
  const gradeP = program(GRADE_FRAG, ['uSize', 'uSrc', 'uBCS', 'uPremult']);
  const prepP = program(PREP_FRAG, ['uSize', 'uSrc']);
  const outP = program(OUT_FRAG, ['uSize', 'uSrc', 'uBg']);

  // One full-screen triangle.
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  /** A half-float render target; `mips` allocates a full mip chain (filled by generateMipmap
   *  after it is drawn) so a picture shrunk on screen is sampled without aliasing. */
  const makeTarget = (w: number, h: number, mips = false): Target => {
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const levels = mips ? Math.floor(Math.log2(Math.max(w, h))) + 1 : 1;
    gl.texStorage2D(gl.TEXTURE_2D, levels, gl.RGBA16F, w, h);
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_MIN_FILTER,
      mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error('a half-float framebuffer is incomplete');
    }
    return { fbo, tex, w, h };
  };
  const dropTarget = (t: Target) => {
    gl.deleteFramebuffer(t.fbo);
    gl.deleteTexture(t.tex);
  };

  // The working buffers, ping-ponged; reallocated when the comp size changes.
  let work: [Target, Target] | null = null;
  let cur = 0;
  const ensureWork = (W: number, H: number) => {
    if (work && work[0].w === W && work[0].h === H) return;
    if (work) work.forEach(dropTarget);
    work = [makeTarget(W, H), makeTarget(W, H)];
  };

  const pass = (p: Program, target: Target | null, w: number, h: number) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(p.prog);
    gl.uniform2f(p.u.uSize, w, h);
  };
  const bindTex = (unit: number, tex: WebGLTexture, loc: WebGLUniformLocation | null) => {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(loc, unit);
  };
  const draw = () => gl.drawArrays(gl.TRIANGLES, 0, 3);

  // Prepared layer pictures (linear, premultiplied, mipmapped), by image key — an LRU:
  // insertion order, re-inserted on use.
  const texCache = new Map<string, Target>();
  const upload = (key: string, img: CompositeImage): Target => {
    const hit = texCache.get(key);
    if (hit) {
      texCache.delete(key);
      texCache.set(key, hit);
      return hit;
    }
    // 1. The picture as it comes, straight alpha: sRGB bytes into an sRGB texture (decoded to
    //    linear when read), or floats as they are.
    const raw = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, raw);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    if (isLinearImage(img)) {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA16F,
        img.width,
        img.height,
        0,
        gl.RGBA,
        gl.FLOAT,
        img.data,
      );
    } else {
      // The decode hands ImageBitmaps; of the 2D canvas's sources only an SVG image could not
      // be uploaded, and none reaches here.
      const tsrc = img as TexImageSource;
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, tsrc);
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    // 2. Into linear light, premultiplied, then the mip chain — all BEFORE any filtering, so
    //    a shrunk or rotated picture is resampled as light with its alpha already applied.
    const prepared = makeTarget(img.width, img.height, true);
    pass(prepP, prepared, img.width, img.height);
    bindTex(0, raw, prepP.u.uSrc);
    draw();
    gl.deleteTexture(raw);
    gl.bindTexture(gl.TEXTURE_2D, prepared.tex);
    gl.generateMipmap(gl.TEXTURE_2D);
    texCache.set(key, prepared);
    while (texCache.size > TEX_CACHE_CAP) {
      const [oldKey, old] = texCache.entries().next().value as [string, Target];
      dropTarget(old);
      texCache.delete(oldKey);
    }
    return prepared;
  };

  /** Grade `src` into `dst` through one Color Correct. */
  const grade = (src: Target, dst: Target, e: EffectOp, premult: boolean) => {
    pass(gradeP, dst, dst.w, dst.h);
    bindTex(0, src.tex, gradeP.u.uSrc);
    gl.uniform3f(gradeP.u.uBCS, e.brightness, e.contrast, e.saturation);
    gl.uniform1i(gradeP.u.uPremult, premult ? 1 : 0);
    draw();
  };

  const bgCache = new Map<string, [number, number, number, number]>();
  const parseBg = (css: string): [number, number, number, number] => {
    if (!css) return [0, 0, 0, 0];
    const hit = bgCache.get(css);
    if (hit) return hit;
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    const x = c.getContext('2d');
    let rgba: [number, number, number, number] = [0, 0, 0, 1];
    if (x) {
      x.fillStyle = css;
      x.fillRect(0, 0, 1, 1);
      const d = x.getImageData(0, 0, 1, 1).data;
      rgba = [
        srgbToLinear(d[0] / 255),
        srgbToLinear(d[1] / 255),
        srgbToLinear(d[2] / 255),
        d[3] / 255,
      ];
    }
    bgCache.set(css, rgba);
    return rgba;
  };

  const MODE = { normal: 0, add: 1, multiply: 2, screen: 3 } as const;

  return {
    canvas,
    render(W, H, background, draws) {
      if (canvas.width !== W) canvas.width = W;
      if (canvas.height !== H) canvas.height = H;
      ensureWork(W, H);
      const buf = work!;
      cur = 0;
      gl.disable(gl.BLEND);
      gl.bindFramebuffer(gl.FRAMEBUFFER, buf[0].fbo);
      gl.viewport(0, 0, W, H);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      for (const d of draws) {
        const src = buf[cur];
        const dst = buf[1 - cur];
        if (d.kind === 'adjust') {
          let from = src;
          let to = dst;
          for (const e of d.effects) {
            grade(from, to, e, true);
            [from, to] = [to, from];
          }
          cur = buf.indexOf(from);
          continue;
        }
        const up = upload(d.imageKey, d.image);
        let layerTex = up.tex;
        const scratch: Target[] = [];
        if (d.effects.length) {
          // The layer's own effects: grade the prepared picture into a float buffer of its
          // size (premultiplied, as the picture now is), ping-ponging for each effect.
          let from = up;
          for (const e of d.effects) {
            const to = makeTarget(up.w, up.h);
            scratch.push(to);
            grade(from, to, e, true);
            from = to;
          }
          layerTex = from.tex;
        }
        pass(layerP, dst, W, H);
        bindTex(0, src.tex, layerP.u.uBack);
        bindTex(1, layerTex, layerP.u.uLayer);
        gl.uniformMatrix3fv(layerP.u.uInv, false, d.inverse);
        gl.uniform1f(layerP.u.uOpacity, Math.max(0, Math.min(1, d.opacity)));
        gl.uniform1i(layerP.u.uMode, MODE[d.blendMode] ?? 0);
        draw();
        scratch.forEach(dropTarget);
        cur = 1 - cur;
      }

      pass(outP, null, W, H);
      bindTex(0, buf[cur].tex, outP.u.uSrc);
      const bg = parseBg(background);
      gl.uniform4f(outP.u.uBg, bg[0], bg[1], bg[2], bg[3]);
      draw();
    },
    readLinear(x, y) {
      if (!work) return [0, 0, 0, 0];
      const t = work[cur];
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
      const out = new Float32Array(4);
      gl.readPixels(Math.floor(x), t.h - 1 - Math.floor(y), 1, 1, gl.RGBA, gl.FLOAT, out);
      return [out[0], out[1], out[2], out[3]];
    },
  };
}
