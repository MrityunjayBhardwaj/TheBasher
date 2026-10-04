// The scene's frame rate: the grid the playhead's `frame` counts on (`timeStore`), and the grid a
// retarget or a bake fills a curve on between keys (#1456). One number, kept here so node code can
// read it without reaching into an app store.

export const FRAMES_PER_SECOND = 60;
