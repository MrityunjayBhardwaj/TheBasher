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

const missing = new Set(KEEP);
const frames = raw.source.frames.map((f) => {
  const bones = {};
  for (const name of KEEP) {
    const b = f.bones[name];
    if (!b || !Array.isArray(b.pos)) continue;
    missing.delete(name);
    // POSITIONS ONLY. The dump also carries a per-bone quaternion; the
    // differential compares joint ANGLES computed from positions, so keeping the
    // quaternions would ship a second, unread answer to the same question — and
    // the first thing that goes stale is the copy nobody reads.
    bones[name] = b.pos.slice(0, 3).map(round4);
  }
  return { frame: f.frame, bones };
});

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
    '— see issues #857 and #858. Positions only, 4dp, for the joints the differential compares.',
  method: raw.method,
  scene: raw.scene,
  source: { armature: raw.source.armature, frames },
};

writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
console.log(
  `wrote ${outPath} — ${frames.length} frames x ${KEEP.length} joints ` +
    `(from ${raw.source.frames[0] ? Object.keys(raw.source.frames[0].bones).length : 0} in the dump)`,
);
