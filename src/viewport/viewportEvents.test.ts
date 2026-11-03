import { describe, expect, it } from 'vitest';
import { events as pointerEvents } from '@react-three/fiber';
import { UNHANDLED_3D_EVENTS, viewportEvents } from './viewportEvents';

type Store = Parameters<typeof pointerEvents>[0];
// R3F's event handler reads the store first, before it ray-tests the scene: a read here means the
// handler went on to intersect.
const store = {
  getState: () => {
    throw new Error('read the store (would ray-test the scene)');
  },
} as unknown as Store;
const event = new Event('pointerup');

describe('#1755 — the viewport does not ray-test on events no 3D element handles', () => {
  it('a wheel or a pointer-up never reaches the scene intersect', () => {
    const handlers = viewportEvents(store).handlers!;
    for (const name of UNHANDLED_3D_EVENTS) expect(() => handlers[name](event)).not.toThrow();
  });

  it('CONTROL: every other R3F event still runs R3F’s own handler (click-select, curve points)', () => {
    const handlers = viewportEvents(store).handlers!;
    for (const name of ['onClick', 'onPointerDown', 'onPointerMove'] as const)
      expect(() => handlers[name](event)).toThrow(/read the store/);
    // …and R3F's own wheel / pointer-up handlers do intersect: what the first test rules out.
    const stock = pointerEvents(store).handlers!;
    for (const name of UNHANDLED_3D_EVENTS)
      expect(() => stock[name](event)).toThrow(/read the store/);
  });
});
