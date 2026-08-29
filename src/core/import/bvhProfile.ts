// bvhProfile — the facts a BVH clip states about itself, read straight off the
// text rather than accepted as a label beside it.
//
// A BVH file declares its own sampling rate (`Frame Time`) and its own channel
// layout, so a consumer never has to be TOLD them. That matters more than it
// sounds: a reported value can disagree with the artifact it describes and every
// behavioural test still passes, because the tests read the label. A derived
// value cannot disagree with itself.
//
// This module exists because two properties were being assumed instead:
//
//   - the frame rate was a REQUEST field on the motion capability, which asked
//     the caller to choose something the generator decides (#790). Measured
//     against real backends, two of three cannot honour it at all.
//   - which joint carries world translation was assumed to be the root. A real
//     Kimodo clip puts it on `Hips` and leaves the root identically zero for
//     every frame, so anything reading the world path off the root sees a
//     character walking in place.
//
// What is deliberately NOT here is the length UNIT. BVH has no unit declaration
// — the format simply does not carry one — so it cannot be derived and must be
// declared by whoever produced the clip. That asymmetry is the module's shape:
// derive everything the artifact states, declare only what it cannot.
//
// REF: src/core/import/bvh.ts (the parser this sits beside);
//      src/core/motiongen/MotionGenerationCapability.ts (`unitScale`, the
//      declared half); issue #790.

/** One joint as the header declares it, with where its channels sit in a row. */
interface JointChannels {
  readonly name: string;
  /** Column of this joint's first channel within a motion row. */
  readonly start: number;
  readonly count: number;
  /** Columns of Xposition / Yposition / Zposition, or null when it has none. */
  readonly positionColumns: readonly [number, number, number] | null;
}

export interface BvhProfile {
  /** Frames per second, from `Frame Time`. */
  readonly fps: number;
  /** Seconds per frame, verbatim from the header. */
  readonly frameTime: number;
  /** Row count, from `Frames:`. */
  readonly frames: number;
  /**
   * Clip length in seconds. `(frames - 1) * frameTime`, which is what the
   * imported AnimationClip's duration comes out as — the last sample sits AT the
   * end rather than one frame past it.
   */
  readonly duration: number;
  /** Joint names in declaration order, including the root. */
  readonly joints: readonly string[];
  /**
   * The joints that declare position channels — the ones whose translation is
   * ANIMATED rather than fixed at their rest OFFSET.
   *
   * The distinction decides how a joint's local translation is composed, so it
   * has to be read off the header: for a posed joint the channel IS the
   * translation and the OFFSET is that translation's rest value, while for a
   * rotation-only joint the OFFSET is the translation. Applying either rule to
   * the other kind of joint is wrong, and wrong by a whole rest offset.
   */
  readonly posedJoints: readonly string[];
  /**
   * The first joint, in declaration order, whose position channels actually
   * change across the clip — the joint carrying world translation. `null` when
   * nothing translates, which is a stationary clip rather than a malformed one.
   *
   * Declaration order rather than largest-magnitude, so the answer is exact and
   * needs no threshold: the topmost joint that moves is the one the rest hang
   * off. A root that is authored but never varies is correctly skipped, which is
   * the Kimodo case.
   */
  readonly rootMotionJoint: string | null;
}

/**
 * The joints that declare position channels, read from the HEADER alone.
 *
 * Split out from `readBvhProfile` deliberately. The composition rule in
 * `parseBvh` needs exactly this one fact and nothing from the MOTION block, and
 * `readBvhProfile` refuses a clip whose frame count or frame time is degenerate —
 * correctly, at the capability boundary where a producer's output is being
 * judged. Routing the importer through that check would have quietly NARROWED
 * what a dropped file is allowed to be, as a side effect of a change about
 * offsets. A function should not be able to reject an input over a fact it never
 * reads.
 */
export function readPosedJoints(text: string): readonly string[] {
  const lines = text.split(/\r?\n/);
  const motionAt = lines.findIndex((line) => line.trim() === 'MOTION');
  const header = motionAt === -1 ? lines : lines.slice(0, motionAt);
  return readChannelLayout(header)
    .filter((j) => j.positionColumns !== null)
    .map((j) => j.name);
}

export class BvhProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BvhProfileError';
  }
}

/**
 * Read a clip's self-declared properties.
 *
 * Scans the header for the channel layout and the MOTION block for the sampling
 * rate and rows. Deliberately independent of three's BVHLoader: the loader
 * projects straight to a skeleton and a clip, and by then the channel LAYOUT —
 * which joint owned which column — has been absorbed into the result. The layout
 * is the whole question here.
 */
export function readBvhProfile(text: string): BvhProfile {
  const lines = text.split(/\r?\n/);
  const motionAt = lines.findIndex((line) => line.trim() === 'MOTION');
  if (motionAt === -1) {
    throw new BvhProfileError('BVH has no MOTION section — nothing declares a frame rate.');
  }

  const joints = readChannelLayout(lines.slice(0, motionAt));
  if (joints.length === 0) {
    throw new BvhProfileError('BVH declares no joints.');
  }

  const { frames, frameTime } = readMotionHeader(lines, motionAt);
  const rows = readMotionRows(lines, motionAt + 3, frames);

  return {
    fps: 1 / frameTime,
    frameTime,
    frames,
    duration: (frames - 1) * frameTime,
    joints: joints.map((j) => j.name),
    posedJoints: joints.filter((j) => j.positionColumns !== null).map((j) => j.name),
    rootMotionJoint: findTranslatingJoint(joints, rows),
  };
}

/**
 * Joints in declaration order with their column spans.
 *
 * `End Site` blocks never become joints, and no special case is needed for that:
 * a block is only recorded when a `CHANNELS` line follows a `ROOT` or `JOINT`
 * declaration, and an End Site has neither. An explicit skip was written first
 * and then removed — disabling it changed no test, which is the only reason to
 * believe it was doing nothing. Both shapes matter and both are covered: this
 * repo's other fixtures carry End Site blocks and the real generator's clips omit
 * them entirely, so a scanner tuned to either alone would look correct against
 * half the corpus.
 */
function readChannelLayout(headerLines: readonly string[]): JointChannels[] {
  const joints: JointChannels[] = [];
  let column = 0;
  let pending: string | null = null;

  for (const raw of headerLines) {
    const line = raw.trim();
    const declared = /^(?:ROOT|JOINT)\s+(\S+)/.exec(line);
    if (declared) {
      pending = declared[1];
      continue;
    }

    const channels = /^CHANNELS\s+(\d+)\s*(.*)$/.exec(line);
    if (!channels) continue;
    // A CHANNELS line with no joint declared before it is malformed BVH; skip it
    // rather than attributing its columns to the previous joint, which would
    // silently shift every column after it.
    if (pending === null) continue;

    const count = Number(channels[1]);
    const names = channels[2].trim().split(/\s+/).filter(Boolean);
    const columnOf = (axis: string): number => {
      const at = names.indexOf(axis);
      return at === -1 ? -1 : column + at;
    };
    const px = columnOf('Xposition');
    const py = columnOf('Yposition');
    const pz = columnOf('Zposition');

    joints.push({
      name: pending,
      start: column,
      count,
      positionColumns: px >= 0 && py >= 0 && pz >= 0 ? [px, py, pz] : null,
    });
    column += count;
    pending = null;
  }

  return joints;
}

function readMotionHeader(
  lines: readonly string[],
  motionAt: number,
): { frames: number; frameTime: number } {
  const framesLine = lines[motionAt + 1]?.trim() ?? '';
  const frameTimeLine = lines[motionAt + 2]?.trim() ?? '';

  const framesMatch = /^Frames:\s*(\S+)/i.exec(framesLine);
  const frameTimeMatch = /^Frame\s*Time:\s*(\S+)/i.exec(frameTimeLine);
  if (!framesMatch || !frameTimeMatch) {
    throw new BvhProfileError(
      'BVH MOTION section must be followed by `Frames:` then `Frame Time:` — ' +
        `saw "${framesLine}" then "${frameTimeLine}".`,
    );
  }

  const frames = Number(framesMatch[1]);
  const frameTime = Number(frameTimeMatch[1]);
  // Both of these produce well-formed-looking nonsense downstream rather than an
  // error — `Frame Time: 0` yields an infinite rate, `Frames: NaN` yields a clip
  // over no rows — so they are refused here, where the text that caused them is
  // still in hand to name.
  if (!Number.isFinite(frames) || frames < 1) {
    throw new BvhProfileError(`BVH declares Frames: ${framesMatch[1]} — must be a positive count.`);
  }
  if (!Number.isFinite(frameTime) || frameTime <= 0) {
    throw new BvhProfileError(
      `BVH declares Frame Time: ${frameTimeMatch[1]} — must be a positive number of seconds.`,
    );
  }
  return { frames, frameTime };
}

function readMotionRows(
  lines: readonly string[],
  from: number,
  frames: number,
): readonly (readonly number[])[] {
  const rows: number[][] = [];
  for (let i = from; i < lines.length && rows.length < frames; i += 1) {
    const line = lines[i].trim();
    if (line === '') continue;
    rows.push(line.split(/\s+/).map(Number));
  }
  if (rows.length !== frames) {
    throw new BvhProfileError(
      `BVH declares ${frames} frames but carries ${rows.length} motion rows.`,
    );
  }
  return rows;
}

/**
 * The first joint whose position channels differ from their frame-0 values.
 *
 * Compared exactly, with no epsilon. The values are literals in the file, so any
 * difference is a difference the producer wrote down; smoothing that with a
 * tolerance would substitute our judgement about what counts as motion for the
 * generator's. A backend emitting float noise on a joint it considers stationary
 * is reporting something true about itself, and the conformance suite should see
 * it rather than have it rounded away.
 */
function findTranslatingJoint(
  joints: readonly JointChannels[],
  rows: readonly (readonly number[])[],
): string | null {
  if (rows.length === 0) return null;
  for (const joint of joints) {
    if (!joint.positionColumns) continue;
    const [x, y, z] = joint.positionColumns;
    const first = [rows[0][x], rows[0][y], rows[0][z]];
    for (const row of rows) {
      if (row[x] !== first[0] || row[y] !== first[1] || row[z] !== first[2]) {
        return joint.name;
      }
    }
  }
  return null;
}
