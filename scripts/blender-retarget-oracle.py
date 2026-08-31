"""Dump what Blender computes for a rig and a clip, so a gate can disagree with us.

Run headless — the point is reproducibility, not a live session:

    "/Applications/Blender 2.app/Contents/MacOS/Blender" --background \
        --python scripts/blender-retarget-oracle.py -- \
        --glb public/assets/tripo-rigged.glb \
        --bvh public/assets/kimodo-walk.bvh \
        --out /tmp/oracle.json

WHAT THIS IS AN ORACLE FOR, AND WHAT IT IS NOT (#857)
─────────────────────────────────────────────────────
INDEPENDENT: the SOURCE side. Blender parses the BVH and computes the skeleton's
world pose per frame with no input from us. If its joint positions disagree with
ours, then our parse, our unit scale, our Euler order or our forward kinematics is
wrong — and every correction built on top is built on sand. Nothing here is
shared with our implementation, so agreement is evidence.

NOT INDEPENDENT: the correction that carries the clip onto another rig. Blender's
automatic offset capture (Child Of + Set Inverse) samples the whole three-DOF
offset in the WORLD, which is the construction measured wrong in #853. Blender
beats it only because a human matches the two rest poses first. So this script
deliberately does NOT emit a retargeted result and call it truth; it emits both
rigs' raw facts and leaves the comparison to a differential.

EVERY SETTING THAT CHANGES THE ANSWER IS RECORDED IN THE OUTPUT, because an
oracle whose method drifts between runs is worse than no oracle.
"""

import json
import sys
import argparse

import bpy
from mathutils import Quaternion  # noqa: F401  (documents the maths we rely on)

# BVH import settings. These change the answer, so they are constants with a
# name rather than call-site literals, and they are echoed into the output.
BVH_IMPORT = {
    "global_scale": 1.0,
    "use_fps_scale": False,
    "update_scene_fps": False,
    "update_scene_duration": True,
    "rotate_mode": "NATIVE",
    "axis_forward": "-Z",
    "axis_up": "Y",
}


def parse_args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--glb", required=True)
    p.add_argument("--bvh", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--frames", type=int, default=61)
    return p.parse_args(argv)


def empty_scene() -> None:
    bpy.ops.wm.read_homefile(use_empty=True)
    # The glTF importer reads bpy.context.object while placing the armature; an
    # emptied scene has no active object and the import dies on it.
    anchor = bpy.data.objects.new("ctx_anchor", None)
    bpy.context.scene.collection.objects.link(anchor)
    bpy.context.view_layer.objects.active = anchor
    bpy.context.view_layer.update()


def new_armature(before: set) -> object:
    made = [o for o in bpy.data.objects if o.name not in before]
    arm = next((o for o in made if o.type == "ARMATURE"), None)
    if arm is None:
        raise SystemExit(f"no armature imported; got {[(o.name, o.type) for o in made]}")
    return arm


def rest_pose(arm) -> dict:
    """Each bone's REST transform in armature space, plus the hierarchy."""
    out = {}
    for b in arm.data.bones:
        m = arm.matrix_world @ b.matrix_local
        loc, rot, _ = m.decompose()
        out[b.name] = {
            "parent": b.parent.name if b.parent else None,
            "head": [round(v, 6) for v in (arm.matrix_world @ b.head_local)],
            "tail": [round(v, 6) for v in (arm.matrix_world @ b.tail_local)],
            "quat": [round(v, 6) for v in (rot.w, rot.x, rot.y, rot.z)],
            "length": round(b.length, 6),
        }
    return out


def posed(arm, frames: int) -> list:
    """Each bone's world head position and orientation, per frame.

    Positions are the load-bearing part: they survive the Z-up/Y-up difference
    as a SHAPE, so they can be compared against a Y-up implementation without
    either side having to agree about which way is up.
    """
    scene = bpy.context.scene
    rows = []
    first = scene.frame_start
    for i in range(frames):
        f = first + i
        if f > scene.frame_end:
            break
        scene.frame_set(f)
        bpy.context.view_layer.update()
        bones = {}
        for pb in arm.pose.bones:
            m = arm.matrix_world @ pb.matrix
            loc, rot, _ = m.decompose()
            bones[pb.name] = {
                "pos": [round(v, 6) for v in loc],
                "quat": [round(v, 6) for v in (rot.w, rot.x, rot.y, rot.z)],
            }
        rows.append({"frame": f, "bones": bones})
    return rows


def main() -> None:
    args = parse_args()
    empty_scene()

    before = set(bpy.data.objects.keys())
    bpy.ops.import_scene.gltf(filepath=args.glb)
    target = new_armature(before)

    before = set(bpy.data.objects.keys())
    bpy.ops.import_anim.bvh(filepath=args.bvh, **BVH_IMPORT)
    source = new_armature(before)

    scene = bpy.context.scene
    payload = {
        "method": {
            "blender": bpy.app.version_string,
            "bvh_import": BVH_IMPORT,
            "glb": args.glb,
            "bvh": args.bvh,
            "note": "source side is independent; no retarget is performed (see #857)",
        },
        "scene": {
            "fps": scene.render.fps,
            "frame_start": scene.frame_start,
            "frame_end": scene.frame_end,
        },
        "target": {
            "armature": target.name,
            "rest": rest_pose(target),
        },
        "source": {
            "armature": source.name,
            "rest": rest_pose(source),
            "frames": posed(source, args.frames),
        },
    }
    with open(args.out, "w") as fh:
        json.dump(payload, fh)
    print(f"ORACLE OK: {len(payload['source']['frames'])} frames, "
          f"{len(payload['source']['rest'])} source bones, "
          f"{len(payload['target']['rest'])} target bones -> {args.out}")


main()
