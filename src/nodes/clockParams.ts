// #1688 — which clock an object runs on: the scene's (slowed by the Scene's speed), or the
// playhead's (film time, which keeps moving in bullet time). A camera always runs on the
// playhead (#1594, no setting). Everything else inherits its parent's clock, so a camera rig set
// to `film` carries the camera, and anything else hung from it, through a slowed moment, while a
// car a camera is mounted on stays on scene time and the camera stays with it.
//
// Spread into ObjectParams and GroupParams: the node types that can be a rig (an imported Empty is
// a Group). `.optional()` for the reason `visibilityParams` is: absent means inherit, so a project
// that sets no clock saves byte-identical. Read through `clockOf` (src/app/subjectClock.ts), never
// by hand.

import { z } from 'zod';

/** The values of the Clock setting. `inherit` is what absent means. */
export const CLOCK_SETTINGS = ['inherit', 'film'] as const;
export type ClockSetting = (typeof CLOCK_SETTINGS)[number];

/** The one param, spread into the param schema of every node type that can carry a camera. */
export const clockParams = {
  clock: z.enum(CLOCK_SETTINGS).optional(),
};
