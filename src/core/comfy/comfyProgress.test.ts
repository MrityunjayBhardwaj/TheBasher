// comfyProgress — pure parser tests for ComfyUI's /ws stream. The binary frame
// format is grounded in server.py encode_bytes + send_image (design §8/§16 Q-F).

import { describe, expect, it } from 'vitest';
import { comfyWsUrl, parseComfyWsMessage } from './comfyProgress';

/** Build a binary PREVIEW_IMAGE frame: [uint32 event=1][uint32 typeNum][image bytes]. */
function previewFrame(typeNum: number, image: number[]): ArrayBuffer {
  const buf = new ArrayBuffer(8 + image.length);
  const view = new DataView(buf);
  view.setUint32(0, 1); // PREVIEW_IMAGE
  view.setUint32(4, typeNum);
  new Uint8Array(buf, 8).set(image);
  return buf;
}

describe('parseComfyWsMessage — text events', () => {
  it('parses a progress event (sampler step k/N)', () => {
    const e = parseComfyWsMessage(
      JSON.stringify({ type: 'progress', data: { value: 7, max: 20, node: '3' } }),
    );
    expect(e).toEqual({ kind: 'progress', value: 7, max: 20, node: '3' });
  });

  it('parses an executing event', () => {
    expect(parseComfyWsMessage(JSON.stringify({ type: 'executing', data: { node: '8' } }))).toEqual({
      kind: 'executing',
      node: '8',
    });
    // executing with node:null (the end-of-prompt signal)
    expect(
      parseComfyWsMessage(JSON.stringify({ type: 'executing', data: { node: null } })),
    ).toEqual({ kind: 'executing', node: null });
  });

  it('ignores status / executed / unknown / malformed text', () => {
    expect(parseComfyWsMessage(JSON.stringify({ type: 'status', data: {} }))).toBeNull();
    expect(parseComfyWsMessage(JSON.stringify({ type: 'executed', data: {} }))).toBeNull();
    expect(parseComfyWsMessage('not json')).toBeNull();
    expect(parseComfyWsMessage(JSON.stringify({ nope: 1 }))).toBeNull();
  });
});

describe('parseComfyWsMessage — binary preview frames', () => {
  it('parses a PNG preview (type_num 2) — image bytes start at offset 8', () => {
    const e = parseComfyWsMessage(previewFrame(2, [0x89, 0x50, 0x4e, 0x47]));
    expect(e?.kind).toBe('preview');
    if (e?.kind === 'preview') {
      expect(e.mime).toBe('image/png');
      expect(Array.from(e.bytes)).toEqual([0x89, 0x50, 0x4e, 0x47]);
    }
  });

  it('parses a JPEG preview (type_num 1)', () => {
    const e = parseComfyWsMessage(previewFrame(1, [0xff, 0xd8, 0xff]));
    expect(e?.kind).toBe('preview');
    if (e?.kind === 'preview') {
      expect(e.mime).toBe('image/jpeg');
      expect(Array.from(e.bytes)).toEqual([0xff, 0xd8, 0xff]);
    }
  });

  it('parses a PREVIEW_IMAGE_WITH_METADATA frame (event 4)', () => {
    const meta = new TextEncoder().encode(JSON.stringify({ image_type: 'image/jpeg' }));
    const image = [1, 2, 3];
    const buf = new ArrayBuffer(8 + meta.length + image.length);
    const view = new DataView(buf);
    view.setUint32(0, 4); // PREVIEW_IMAGE_WITH_METADATA
    view.setUint32(4, meta.length);
    new Uint8Array(buf, 8, meta.length).set(meta);
    new Uint8Array(buf, 8 + meta.length).set(image);
    const e = parseComfyWsMessage(buf);
    expect(e?.kind).toBe('preview');
    if (e?.kind === 'preview') {
      expect(e.mime).toBe('image/jpeg');
      expect(Array.from(e.bytes)).toEqual(image);
    }
  });

  it('returns null for a too-short or unknown binary frame', () => {
    expect(parseComfyWsMessage(new ArrayBuffer(4))).toBeNull(); // < 8 bytes
    const unknown = new ArrayBuffer(8);
    new DataView(unknown).setUint32(0, 99); // unknown event
    expect(parseComfyWsMessage(unknown)).toBeNull();
  });
});

describe('comfyWsUrl', () => {
  it('maps http→ws and https→wss, appends the bound clientId', () => {
    expect(comfyWsUrl('http://127.0.0.1:8188', 'abc')).toBe('ws://127.0.0.1:8188/ws?clientId=abc');
    expect(comfyWsUrl('https://host/', 'x y')).toBe('wss://host/ws?clientId=x%20y');
  });
});
