// goToLayerRow — each lane of the "What changes this" surface routes to the editor it is edited in,
// and a material param routes to Materials whichever lane animates it (#1940 T2).

import { describe, expect, it } from 'vitest';
import { layerRowRoute } from './goToLayerRow';
import type { LayerRowPick } from './ObjectLayerSurfacePanel';
import type { LaneName } from './objectLayerSurface';

const pick = (
  lane: LaneName,
  rowNodeId: string | null,
  paramPath: string | null,
): LayerRowPick => ({
  lane,
  objectId: 'obj',
  rowNodeId,
  paramPath,
});

describe('layerRowRoute', () => {
  it('a modifier row selects the modifier and shows the Modifiers stack', () => {
    expect(layerRowRoute(pick('modifier', 'arr', null))).toEqual({
      select: 'arr',
      stack: 'modifiers',
      drawer: null,
      activeChannel: null,
    });
  });

  it('a constraint row selects the constraint and shows the Constraints stack', () => {
    expect(layerRowRoute(pick('constraint', 'tt', null))).toMatchObject({
      select: 'tt',
      stack: 'constraints',
      drawer: null,
    });
  });

  it('a driver row selects the driver, leaving the frame and the drawer', () => {
    expect(layerRowRoute(pick('driver', 'drv', 'position'))).toEqual({
      select: 'drv',
      stack: null,
      drawer: null,
      activeChannel: null,
    });
  });

  it('a channel row opens the Curves tab on that channel', () => {
    expect(layerRowRoute(pick('channel', 'ch', 'position'))).toEqual({
      select: 'ch',
      stack: null,
      drawer: 'curve',
      activeChannel: 'ch',
    });
  });

  it('a strip row opens NLA on the object (a synthetic strip has no node)', () => {
    expect(layerRowRoute(pick('strip', null, 'position'))).toMatchObject({
      select: 'obj',
      drawer: 'nla',
      activeChannel: null,
    });
  });

  it('a pose row opens Anim Layers on the object', () => {
    expect(layerRowRoute(pick('pose', 'layer1', null))).toMatchObject({
      select: 'obj',
      drawer: 'animLayers',
    });
  });

  it('a material param routes to Materials whichever lane animates it, both spellings', () => {
    for (const lane of ['channel', 'strip', 'driver'] as const) {
      for (const path of ['material.base.color', 'materialSlots.0.base.color']) {
        expect(layerRowRoute(pick(lane, 'n', path)), `${lane} ${path}`).toEqual({
          select: 'obj',
          stack: 'materials',
          drawer: null,
          activeChannel: null,
        });
      }
    }
  });

  it('a param that only starts like a material word is not a material', () => {
    expect(layerRowRoute(pick('channel', 'ch', 'materialness')).stack).toBeNull();
  });
});
