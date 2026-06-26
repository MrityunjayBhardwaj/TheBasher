// saveRenderPassesToProject — lock the saved-pass naming the user specified:
// `render_<frame>_<pass>.png`. The path is what a video-mode image input references;
// the name is what the project-image picker shows.

import { describe, expect, it } from 'vitest';
import { renderPassName, renderPassPath } from './saveRenderPassesToProject';

describe('render pass naming', () => {
  it('paths are renders/render_<frame>_<pass>.png', () => {
    expect(renderPassPath(0, 'beauty')).toBe('renders/render_0_beauty.png');
    expect(renderPassPath(12, 'depth')).toBe('renders/render_12_depth.png');
    expect(renderPassPath(7, 'normal')).toBe('renders/render_7_normal.png');
  });

  it('names are render_<frame>_<pass> (the picker label)', () => {
    expect(renderPassName(0, 'beauty')).toBe('render_0_beauty');
    expect(renderPassName(3, 'normal')).toBe('render_3_normal');
  });
});
