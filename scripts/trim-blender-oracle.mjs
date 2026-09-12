// Trim a raw `blender-retarget-oracle.py` dump down to the fixture the
// differential actually reads (#858).
//
// WHY THIS EXISTS AS A SCRIPT. The committed fixture is not what the Blender
// script emits. The raw dump is 538 KB — 78 bones a frame, plus a `target`
// block and a rest pose the differential never opens — and the committed file
// is 68 KB: 24 bones, positions only, 4dp. That trim was tribal knowledge, and
// #858 warns that regenerating this fixture is exactly where the risk is. A
// regeneration that skipped the trim would land an 8x file of a different shape
// and read as an ordinary update.
//
// Usage:
//   "/Applications/Blender 2.app/Contents/MacOS/Blender" --background \
//       --python scripts/blender-retarget-oracle.py -- \
//       --glb public/fixtures/rig/standin-character.glb \
//       --bvh public/fixtures/anim/soma-walk.bvh \
//       --out /tmp/oracle-raw.json
//   node scripts/trim-blender-oracle.mjs /tmp/oracle-raw.json \
//       src/core/import/__fixtures__/blender-oracle-soma-walk.json
//   npx prettier --write src/core/import/__fixtures__/blender-oracle-soma-walk.json

import { readFileSync, writeFileSync } from 'node:fs';

/** The joints the differential compares, plus the two toe bases and Root that
 *  the committed fixture has always carried. Kept as a literal rather than
 *  derived from the test, because a fixture that silently followed its own
 *  consumer could never disagree with it. */
const KEEP = [
  'Root',
  'Hips',
  'Spine1',
  'Spine2',
  'Chest',
  'Neck1',
  'Neck2',
  'Head',
  'LeftShoulder',
  'LeftArm',
  'LeftForeArm',
  'LeftHand',
  'RightShoulder',
  'RightArm',
  'RightForeArm',
  'RightHand',
  'LeftLeg',
  'LeftShin',
  'LeftFoot',
  'LeftToeBase',
  'RightLeg',
  'RightShin',
  'RightFoot',
  'RightToeBase',
];

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error('usage: node scripts/trim-blender-oracle.mjs <raw.json> <out.json>');
  process.exit(2);
}

const raw = JSON.parse(readFileSync(inPath, 'utf8'));
const round4 = (n) => Number(n.toFixed(4));
// Quaternions get two more digits than positions, and the reason is not
// symmetry — it is that the orientation rows compare a NEAR-IDENTITY residual,
// whose angle goes as the SQUARE ROOT of the component error. 4dp would put the
// floor at ~1.2°, 6dp puts it at ~0.16°, and Blender's own float32 storage caps
// the useful floor at ~0.13° however many digits are written — so 6 is the last
// digit that buys anything. Measured both ways on #979.
const round6 = (n) => Number(n.toFixed(6));

const missing = new Set(KEEP);
const frames = raw.source.frames.map((f) => {
  const bones = {};
  for (const name of KEEP) {
    const b = f.bones[name];
    if (!b || !Array.isArray(b.pos)) continue;
    missing.delete(name);
    // POSITIONS AND ORIENTATION. This carried positions only until #979, on the
    // stated ground that the quaternions would be "a second, unread answer to
    // the same question". That was right while the differential compared joint
    // ANGLES built from positions — and it was also the reason the gate could
    // not see a bone rolling about its own axis, which is the dimension the open
    // leg defects live in (#854, #960). There is a reader now, so the copy is no
    // longer unread and the fence comes down deliberately rather than by
    // accident.
    if (!Array.isArray(b.quat) || b.quat.length !== 4) {
      console.error(`raw dump has no quaternion for ${name} — regenerate with the current script`);
      process.exit(1);
    }
    bones[name] = { pos: b.pos.slice(0, 3).map(round4), quat: b.quat.map(round6) };
  }
  return { frame: f.frame, bones };
});

// The dump runs a fixed frame count, and Blender HOLDS the last pose once the
// action ends — this clip is 31 frames and the default dump is 61, so half of it
// was thirty byte-identical copies of frame 31. A held pose carries no
// information and no row reads past the clip, so the tail goes. Dropped from the
// END only: an identical frame in the middle of a clip is real data.
let last = frames.length - 1;
const key = (f) => JSON.stringify(f.bones);
while (last > 0 && key(frames[last]) === key(frames[last - 1])) last -= 1;
if (last < frames.length - 1) {
  console.log(`dropping ${frames.length - 1 - last} trailing frames that hold the last pose`);
  frames.length = last + 1;
}

// A joint the dump does not carry would silently vanish from the fixture and
// the differential would then compare eleven triples while reporting twelve.
if (missing.size > 0) {
  console.error(`raw dump is missing joints the fixture needs: ${[...missing].join(', ')}`);
  process.exit(1);
}

const out = {
  note:
    `What Blender computes for ${raw.method.bvh}. Regenerate with ` +
    'scripts/blender-retarget-oracle.py, then trim with scripts/trim-blender-oracle.mjs ' +
    '— see issues #857, #858 and #979. Positions at 4dp and world orientation at ' +
    '6dp, for the joints the differential compares.',
  method: raw.method,
  scene: raw.scene,
  source: { armature: raw.source.armature, frames },
};

writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
console.log(
  `wrote ${outPath} — ${frames.length} frames x ${KEEP.length} joints ` +
    `(from ${raw.source.frames[0] ? Object.keys(raw.source.frames[0].bones).length : 0} in the dump)`,
);
