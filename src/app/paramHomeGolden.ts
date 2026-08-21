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
export const GOLDEN_PARAM_HOMES: Readonly<Record<string, string>> = {
  Action: '[layout] name=layout channels=(unrouted)',
  AmbientLight: '[driver] intensity=(unrouted) color=(unrouted)',
  AnimationClip:
    '[animate] name=(unrouted) duration=(unrouted) loop=(unrouted) keyframes=(unrouted)',
  ArrayModifier: '[modifier] count=modifier offset=modifier muted=modifier scope=modifier',
  BakedData: '[material] geometry=(unrouted) material=material',
  BeautyPass: '[render] width=(unrouted) height=(unrouted)',
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
    '[transform,constraint,driver,modifier] position=transform rotation=transform scale=transform slotOverrides=(unrouted)',
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
export const GOLDEN_TOTALS = { types: 80, routed: 126, unrouted: 218 } as const;
