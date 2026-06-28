import { describe, expect, it } from 'vitest';
import { comfyUploadExt, resolveComfyImageBindings } from './comfyImageBinding';

describe('comfyUploadExt', () => {
  it('keeps a known video container extension, else falls back to png', () => {
    expect(comfyUploadExt('user-imports/clip/moving.mp4')).toBe('mp4');
    expect(comfyUploadExt('a/b/c.WEBM')).toBe('webm'); // case-insensitive
    expect(comfyUploadExt('x/y.mov')).toBe('mov');
    // images (and anything non-video) upload as png bytes; ComfyUI sniffs content
    expect(comfyUploadExt('media/pose.jpg')).toBe('png');
    expect(comfyUploadExt('media/pose.png')).toBe('png');
    expect(comfyUploadExt('no-extension')).toBe('png');
  });
});

describe('resolveComfyImageBindings', () => {
  it('rewrites an image binding to a stable `.png` filename (unchanged image path)', () => {
    expect(resolveComfyImageBindings({ '10.image': 'media/depth.png' })).toEqual([
      {
        nodeId: '10',
        inputName: 'image',
        filename: 'basher_img_10_image.png',
        upload: { path: 'media/depth.png', filename: 'basher_img_10_image.png' },
      },
    ]);
  });

  it('rewrites a video binding to a filename that KEEPS the container extension', () => {
    expect(resolveComfyImageBindings({ '14.video': 'user-imports/clip/moving.mp4' })).toEqual([
      {
        nodeId: '14',
        inputName: 'video',
        filename: 'basher_img_14_video.mp4',
        upload: { path: 'user-imports/clip/moving.mp4', filename: 'basher_img_14_video.mp4' },
      },
    ]);
  });

  it('skips malformed keys and empty paths', () => {
    expect(resolveComfyImageBindings({ nodot: 'x', '3.': 'y', '5.image': '' })).toEqual([]);
    expect(resolveComfyImageBindings(undefined)).toEqual([]);
  });
});
