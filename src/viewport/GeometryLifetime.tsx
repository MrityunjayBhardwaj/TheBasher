// GeometryLifetime — the mount that gives `geometrySweep` its heartbeat (#587).
//
// A component rather than a module-level timer for one reason that is load-bearing: it must
// run AFTER React has committed. `useFrame` fires in R3F's rAF loop, which runs after the
// commit that attached this frame's geometries, so an instance built during a render is
// already on its `Mesh` by the time the sweep looks at the scene. A `setInterval` would have
// no such guarantee and would eventually fire between a build and its attachment — freeing a
// geometry a millisecond before it draws, silently, and only sometimes.
//
// It also takes the scene from `useFrame`'s state rather than from a store. That is not
// convenience: `sweep` cannot distinguish an empty live set from a missing one, and the two
// want opposite responses. Taking the root from R3F means a null scene is unrepresentable
// here instead of being a check someone could remove.
//
// Renders nothing. Production and dev alike — this is the lifetime, not instrumentation.
//
// REF: src/viewport/geometrySweep.ts (the cadence + the walk); src/app/geometryRegistry.ts
//      (`sweep`); issues #587, #544.

import { useFrame } from '@react-three/fiber';
import { sweepIfDue } from './geometrySweep';

export function GeometryLifetime(): null {
  useFrame(({ scene }) => {
    sweepIfDue(scene);
  });
  return null;
}
