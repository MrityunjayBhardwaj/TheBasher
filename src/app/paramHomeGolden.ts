// GENERATED ONCE (P6a) from the pre-P6 `paramToSection` if-chain, then FROZEN.
// Do not regenerate from the subject — see paramHome.gate.test.ts for why.
//
// The ONLY edit this file accepts is a DELETION, when a node type stops existing: #596
// removed the seven fused relics' rows (410 cells → 361) and #599 the last three — BakedMesh
// (5 cells), Curve (6), PerspectiveCamera (11) — taking it to 339. Each dropped GOLDEN_TOTALS
// by the counts those rows recorded. Removing a row cannot launder a routing change, because the
// row being removed is itself the frozen record of what that type routed. Adding or editing
// a row would launder one, which is why the rule is deletion-only.
//
// ── ONE NARROW AMENDMENT, STATED RATHER THAN TAKEN QUIETLY (#638, ns-1b step 6) ───────
//
// The deletion-only rule has no arm for a NEW PARAM ON A SHIPPED NODE, and this phase adds
// two (`SetMaterialOp.faceFrom` / `faceTo`). Something has to give, so it gives in the
// smallest place with the reason written down: a row may be APPENDED TO, never rewritten.
//
// Why that is still safe against the failure the rule exists to prevent. The laundering
// this file guards against is a RE-HOME — an existing param quietly changing which section
// owns it. Every row is compared as ONE STRING, cell for cell, so an existing cell that
// changed value shows up as a changed cell in the diff whether or not anything was
// appended. What an append adds is a cell that had no previous value to launder. The rule
// is therefore: existing cells are frozen; new cells may join, in the same commit as the
// param they record, and never with an edit to a cell already there.
//
// USED THREE TIMES (#607, ns-2 steps 12, 13a and 13b), and every use is recorded here
// because an amendment nobody tracks is a rule that quietly became the norm.
// `SetMaterialOp.scope`, `ArrayModifier.scope` and `MirrorModifier.scope` each appended ONE
// cell to the end of a row whose existing cells are byte-identical to what they were — for
// Mirror that is `axis=(unrouted) offset=modifier muted=modifier`, untouched. The append is
// the record of a param that HAS a home; a cell that already carried a value is never
// rewritten, so a re-home cannot be laundered as an addition. `GOLDEN_TOTALS.routed`
// moved by exactly the number of appended cells that route to a section, which is the
// derived half of the same claim — a re-home leaves it unchanged and reds the row instead.
//
// ── THE THIRD ARM, STATED THE SAME WAY (#607, ns-2 step 14) ──────────────────────────
//
// The rule had an arm for dropping a whole ROW and an arm for APPENDING a cell, and none for
// REMOVING a cell from a row that survives. Step 14 retires `SetMaterialOp.faceFrom`/`faceTo`
// — the accommodation the component scope supersedes — so the arm is written rather than
// taken quietly: a cell may be REMOVED in the same commit that removes the param it records,
// and `GOLDEN_TOTALS` moves by exactly what that cell contributed (two `(unrouted)` cells
// here, so `unrouted` 218 → 216 and `routed` is untouched).
//
// 🔴 WHY REMOVAL CANNOT LAUNDER ANYTHING, WHICH IS A DIFFERENT ARGUMENT FROM THE APPEND ONE.
// This golden is compared against the LIVE derivation, cell for cell, as one string. Deleting
// a cell whose param still exists does not hide it — the live row still has that cell and the
// comparison reds. So the deletion direction is checked by the subject itself, and the freeze
// is doing its work in the direction where laundering actually lives: an existing cell
// silently changing VALUE. Removing `faceFrom=(unrouted)` while re-homing `muted` would show
// as both a shorter row and a changed cell, in one diff, in one string.
//
// ── THE FOURTH ARM: AN UNROUTED CELL MAY BE ROUTED (#645 P6) ─────────────────────────
//
// The rule had arms for dropping a ROW, APPENDING a cell, and REMOVING a cell. It had none
// for a cell that reads `(unrouted)` becoming a routed one, and #645 needs exactly that:
// `Object.slotOverrides` was appended as `(unrouted)` when the param landed, because nothing
// rendered it yet and a `home` names the section that RENDERS a param. This phase adds that
// section, so the cell has to move.
//
// 🔴 WHY THIS IS NOT THE LAUNDERING THE FREEZE EXISTS TO CATCH, which is a DIFFERENT
// argument from the other three arms and has to be, because this one really does rewrite a
// cell that already carried a value.
//
// What the freeze guards against is a RE-HOME: a param quietly changing which section owns
// it, section A to section B, where both readings look equally plausible to a reviewer and
// only the frozen cell records which one shipped. `(unrouted)` is not a section. There is no
// prior owner to move away from and no earlier decision being overwritten — the cell records
// that the param had NO home, and the edit records that it now has one. A reviewer reading
// the diff sees a param acquiring a card, not a param changing cards.
//
// And it is checked twice over rather than argued once. `GOLDEN_TOTALS` moves by exactly one
// in each direction — `routed` 126 → 127 and `unrouted` 218 → 217 — so a routing change
// dressed as this one would have to leave both totals intact, which a genuine re-home does
// (it moves a cell between two sections and touches neither total). The totals are what tell
// the two apart, and they are derived from the live subject rather than written here.
//
// THE ARM, STATED: a cell reading `(unrouted)` may be ROUTED, in the same commit that adds
// the param's `home` entry and the section that draws it, and `GOLDEN_TOTALS` must move by
// exactly one in each direction. A cell that already names a section is still frozen.
//
// ── THE FIFTH ARM: A NEW NODE TYPE ADDS A ROW (#668) ─────────────────────────────────
//
// The four arms above all act on a row for a type that already exists. None covers a type
// that did not exist at all, and #668 adds one (`MaskModifier`). The gate forces the issue
// rather than leaving it optional: it asserts `listNodeTypes()` set-equals this table's
// keys, so a new registered type with no row here is a red, and there is no way to ship one
// without taking this decision.
//
// 🔴 WHY A NEW ROW CANNOT LAUNDER ANYTHING, which is the append arm's argument and not the
// re-home one. Laundering is an EXISTING cell silently changing which section owns it. A new
// row has no existing cells — every cell in it is a first value, recording where a param
// that never had a home now lives. There is no prior decision to overwrite, so a reviewer
// reading the diff sees a type arriving with its routing declared, not a type's routing
// changing. `GOLDEN_TOTALS.types` moves by exactly one, and `routed`/`unrouted` move by that
// row's own cells — three routed here, none unrouted — so a re-home smuggled into the same
// commit still shows as a changed cell in a row that already existed.
//
// THE ARM, STATED: a whole ROW may be ADDED, in the same commit that registers the node type
// it records, and `GOLDEN_TOTALS.types` moves by exactly one while `routed`/`unrouted` move
// by exactly the cells the new row contributes. Rows for types that already exist are
// untouched by this arm.
export const GOLDEN_PARAM_HOMES: Readonly<Record<string, string>> = {
  Action: '[layout] name=layout channels=(unrouted)',
  AmbientLight: '[driver] intensity=(unrouted) color=(unrouted)',
  AnimationClip:
    '[animate] name=(unrouted) duration=(unrouted) loop=(unrouted) keyframes=(unrouted)',
  ArrayModifier: '[modifier] count=modifier offset=modifier muted=modifier scope=modifier',
  BakedData: '[material] geometry=(unrouted) material=material',
  BeautyPass: '[render] width=(unrouted) height=(unrouted)',
  BevelModifier:
    '[modifier] amount=modifier muted=modifier scope=modifier limitMethod=modifier angleLimit=modifier',
  BoneNameMap: '[] name=(unrouted) map=(unrouted)',
  BoxData: '[mesh,material] size=mesh material=material',
  CameraData:
    '[camera] projection=camera fov=camera zoom=camera near=camera far=camera sensorSize=camera dofEnabled=camera focusDistance=camera fStop=camera focusOnTarget=camera lookAt=camera roll=camera',
  CameraSelect: '[layout] active=(unrouted)',
  Character: '[] name=(unrouted)',
  Clamp: '[] min=(unrouted) max=(unrouted)',
  ClipSelect: '[animate] selectedClipName=(unrouted)',
  ColorCorrect:
    '[effect] brightness=(unrouted) contrast=(unrouted) saturation=(unrouted) muted=(unrouted)',
  ComfyUIWorkflow:
    '[render] presetId=render graph=(unrouted) imageBindings=(unrouted) frameStart=render frameEnd=render lastGoodFrame=(unrouted) outputPath=render width=(unrouted) height=(unrouted)',
  Composition:
    '[layout] name=layout width=(unrouted) height=(unrouted) fps=(unrouted) durationFrames=(unrouted) background=(unrouted)',
  CurveData: '[curve] points=curve closed=curve resolution=curve',
  CurveRemap: '[] points=(unrouted)',
  Cut: '[layout] transitionFrame=(unrouted)',
  DepthPass: '[render] width=(unrouted) height=(unrouted)',
  Fit: '[] inMin=(unrouted) inMax=(unrouted) outMin=(unrouted) outMax=(unrouted) clamp=(unrouted)',
  FollowPath:
    '[constraint,driver] name=(unrouted) target=(unrouted) curve=(unrouted) evalTime=(unrouted) offset=(unrouted) mute=(unrouted) order=(unrouted)',
  GltfAsset:
    '[mesh,driver,material] assetRef=mesh nodeNameMap=(unrouted) childHierarchy=(unrouted) skins=(unrouted) suppressedChildren=(unrouted) keyByGltfNodeIndex=(unrouted)',
  GltfChild:
    '[transform,constraint,driver,material] position=transform rotation=transform scale=transform overridden=(unrouted) assetRef=(unrouted) childName=(unrouted) materials=(unrouted)',
  GltfSkeleton: '[] skinIndex=(unrouted)',
  Group:
    '[transform,constraint,driver,layout] position=transform rotation=transform scale=transform pivot=transform',
  IDPass: '[render] width=(unrouted) height=(unrouted)',
  KeyframeChannelColor:
    '[channel,animate] name=(unrouted) target=(unrouted) paramPath=channel mute=(unrouted) solo=(unrouted) weight=animate blendMode=(unrouted) order=(unrouted) keyframes=channel',
  KeyframeChannelImage:
    '[channel,animate] name=(unrouted) target=(unrouted) paramPath=channel mute=(unrouted) solo=(unrouted) weight=animate blendMode=(unrouted) order=(unrouted) keyframes=channel',
  KeyframeChannelNumber:
    '[channel,animate] name=(unrouted) target=(unrouted) paramPath=channel mute=(unrouted) solo=(unrouted) weight=animate blendMode=(unrouted) order=(unrouted) extendBefore=animate extendAfter=animate modifiers=animate keyframes=channel',
  KeyframeChannelQuat:
    '[channel,animate] name=(unrouted) target=(unrouted) paramPath=channel mute=(unrouted) solo=(unrouted) weight=animate blendMode=(unrouted) order=(unrouted) keyframes=channel',
  KeyframeChannelText:
    '[channel,animate] name=(unrouted) target=(unrouted) paramPath=channel mute=(unrouted) solo=(unrouted) weight=animate blendMode=(unrouted) order=(unrouted) keyframes=channel',
  KeyframeChannelVec2:
    '[channel,animate] name=(unrouted) target=(unrouted) paramPath=channel mute=(unrouted) solo=(unrouted) weight=animate blendMode=(unrouted) order=(unrouted) extendBefore=animate extendAfter=animate modifiers=animate axisModifiers=(unrouted) axisExtend=(unrouted) keyframes=channel',
  KeyframeChannelVec3:
    '[channel,animate] name=(unrouted) target=(unrouted) paramPath=channel mute=(unrouted) solo=(unrouted) weight=animate blendMode=(unrouted) order=(unrouted) extendBefore=animate extendAfter=animate modifiers=animate axisModifiers=(unrouted) axisExtend=(unrouted) childName=(unrouted) assetRef=(unrouted) keyframes=channel',
  Lag: '[] factor=(unrouted) seedFrame=(unrouted) sourceTransform=(unrouted)',
  Layer:
    '[layout,animate] name=layout enabled=(unrouted) solo=(unrouted) locked=(unrouted) startFrame=animate inPoint=(unrouted) outPoint=(unrouted) blendMode=(unrouted) opacity=(unrouted) transform=(unrouted)',
  LightData:
    '[light] lightKind=light intensity=light color=light distance=light decay=light angle=light penumbra=light width=light height=light target=light lookAt=light tex=light',
  LightProfileSelect: '[layout] selectedProfile=(unrouted)',
  LightRig: '[layout] name=layout center=(unrouted) radius=(unrouted)',
  LocomotionState: '[] speed=(unrouted) loop=(unrouted)',
  MakeVec3: '[]',
  MaskModifier: '[modifier] keep=modifier muted=modifier scope=modifier',
  Material: '[material] material=material',
  MaterialOverride:
    '[material] name=(unrouted) color=material roughness=material metalness=material opacity=material emissive=material emissiveIntensity=material overridden=(unrouted) ignoreSourceMaterial=(unrouted) slotIndex=(unrouted)',
  MaterialOverrideOp:
    '[material] name=(unrouted) color=material roughness=material metalness=material opacity=material emissive=material emissiveIntensity=material overridden=(unrouted) muted=(unrouted) scope=(unrouted)',
  Math: '[] op=(unrouted)',
  MediaClip:
    '[layout] name=layout src=(unrouted) mediaKind=(unrouted) srcFps=(unrouted) srcFrames=(unrouted) width=(unrouted) height=(unrouted)',
  MirrorModifier: '[modifier] axis=(unrouted) offset=modifier muted=modifier scope=modifier',
  Mix: '[] factor=(unrouted)',
  Navmesh: '[] halfSize=(unrouted) obstacles=(unrouted)',
  Noise:
    '[] scale=(unrouted) phase=(unrouted) octaves=(unrouted) amplitude=(unrouted) offset=(unrouted)',
  NormalPass: '[render] width=(unrouted) height=(unrouted)',
  Null: '[transform,constraint,driver] position=transform rotation=transform scale=transform',
  Object:
    '[transform,constraint,driver,modifier,slots] position=transform rotation=transform scale=transform slotOverrides=slots',
  ParamDriver:
    '[driver] target=(unrouted) paramPath=(unrouted) blendMode=(unrouted) order=(unrouted) mute=(unrouted) sourceSpare=(unrouted) sourceTransform=(unrouted) sourceTransformVec=(unrouted)',
  PosedSkeleton: '[] amplitude=(unrouted) frequency=(unrouted)',
  PrevFrame: '[]',
  PrevFrameVec: '[] slot=(unrouted)',
  Prompt: '[render] text=(unrouted) negative=(unrouted) tags=(unrouted)',
  RenderJob: '[render] jobId=render frameStart=render frameEnd=render fps=render outputPath=render',
  RenderOutput: '[render] postFx=(unrouted) width=(unrouted) height=(unrouted)',
  SampleGeometry:
    '[] sourceGeometry=(unrouted) at=(unrouted) method=(unrouted) direction=(unrouted) orientation=(unrouted) farthest=(unrouted)',
  Scatter:
    '[mesh,driver,material] density=(unrouted) seed=(unrouted) bounds=(unrouted) scaleJitter=(unrouted) randomYaw=(unrouted)',
  Scene:
    '[environment,layout] envSource=environment envIntensity=environment envRotationY=environment envBackground=environment',
  // APPENDED at #638 — the face range. Unrouted like `muted`, and for the node's own
  // recorded reason: `SetMaterialOp` declares no inspector section at all, because its
  // reference authors this node in the graph editor and a titled empty card is the shape
  // the reachability gate exists to catch. `muted`'s cell is unchanged.
  // APPENDED AGAIN at ns-2 step 12 — `scope`, the first component-scope param in the app.
  // Unrouted for the identical reason, and appended rather than the row being rewritten:
  // the whole row is compared as ONE string, so an append leaves every existing cell
  // byte-identical and a re-home anywhere in the row still shows as a diff. The three
  // cells before it are untouched.
  SetMaterialOp: '[] muted=(unrouted) scope=(unrouted)',
  Shot: '[layout] name=layout startTime=(unrouted) endTime=(unrouted)',
  Skeleton: '[] bones=(unrouted)',
  Solver: '[] seedFrame=(unrouted) sourceTransform=(unrouted) sourceTransformVec=(unrouted)',
  SolverInput: '[]',
  SolverInputVec: '[]',
  SphereData:
    '[mesh,material] radius=mesh widthSegments=mesh heightSegments=mesh material=material',
  Strip:
    '[layout] name=layout action=(unrouted) target=(unrouted) start=(unrouted) timeScale=(unrouted) repeat=(unrouted) reverse=(unrouted) extrapolate=(unrouted) blendMode=(unrouted) influence=(unrouted) blendIn=(unrouted) blendOut=(unrouted) muted=(unrouted)',
  TimeSource: '[]',
  Track: '[layout] name=layout strips=(unrouted) order=(unrouted) mute=(unrouted) solo=(unrouted)',
  TrackTo:
    '[constraint,driver] name=(unrouted) target=(unrouted) aimNode=(unrouted) aimPoint=(unrouted) up=(unrouted) mute=(unrouted) order=(unrouted)',
  Transform: '[transform,constraint,driver] position=transform rotation=transform scale=transform',
  TransformClip:
    '[animate] name=(unrouted) duration=(unrouted) loop=(unrouted) keyframes=(unrouted)',
  Vec3Math: '[] op=(unrouted) scalar=(unrouted)',
  VecBreak3: '[]',
  VideoStitch: '[render] codec=render fps=render outputPath=render',
  WalkPath: '[] from=(unrouted) to=(unrouted) sampleCount=(unrouted)',
};

// 215 → 217 at #638: the two appended `SetMaterialOp` cells, both unrouted. `routed` is
// unchanged, which is the number that would have moved had anything been re-homed.
// 217 → 218 at ns-2 step 12: the appended `SetMaterialOp.scope` cell, unrouted. `routed`
// is STILL 124, and that is the half of this pair which discriminates — an appended param
// only ever moves `unrouted`, so a `routed` that moved would mean a param changed homes
// under cover of an addition, which is precisely what a lone total cannot show.
// 216 → 217 at #682: the appended `MaterialOverrideOp.scope` cell, unrouted, when that
// operator started honouring the selection it had been declaring. `routed` is STILL 126 —
// the same discriminating half, and the reason this is one appended cell rather than a
// rewritten row.
// 80 → 81 types and 127 → 130 routed at #668: `MaskModifier`'s whole row arrives under the
// fifth arm above, and all three of its cells route (`keep`, `muted`, `scope` → modifier).
// `unrouted` is UNCHANGED, which is the derived half of the claim that nothing existing was
// re-homed to make room for it.
// 81 → 82 types and 130 → 132 routed at #818: `BevelModifier`'s whole row arrives under the
// fifth arm above, and BOTH of its cells route (`amount`, `muted` → modifier). `unrouted` is
// UNCHANGED — the derived half of the claim that nothing existing was re-homed to make room.
// It routes two cells and not three because this is the one modifier that declares no scope,
// which is a deferral rather than a fact; its header says why.
// 133 → 135 routed at #847: `BevelModifier` appends `limitMethod` and `angleLimit`, both to
// the modifier section, as the two halves of one authoring control — a method and the value it
// reads. `types` and `unrouted` are UNCHANGED, which is the derived half of the claim that the
// append re-homed nothing: an angle limit is a SECOND producer of the selection this operator
// already had, not a re-routing of the scope it produced before.
export const GOLDEN_TOTALS = { types: 82, routed: 135, unrouted: 217 } as const;
