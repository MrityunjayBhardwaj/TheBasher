// GENERATED ONCE (P6a) from the pre-P6 `paramToSection` if-chain, then FROZEN.
// Do not regenerate from the subject — see paramHome.gate.test.ts for why.
//
// The ONLY edit this file accepts is a DELETION, when a node type stops existing: #596
// removed the seven fused relics' rows (410 cells → 361) and #599 the last three — BakedMesh
// (5 cells), Curve (6), PerspectiveCamera (11) — taking it to 339. Each dropped GOLDEN_TOTALS
// by the counts those rows recorded. Removing a row cannot launder a routing change, because the
// row being removed is itself the frozen record of what that type routed. Adding or editing
// a row would launder one, which is why the rule is deletion-only.
export const GOLDEN_PARAM_HOMES: Readonly<Record<string, string>> = {
  Action: '[layout] name=layout channels=(unrouted)',
  AmbientLight: '[driver] intensity=(unrouted) color=(unrouted)',
  AnimationClip:
    '[animate] name=(unrouted) duration=(unrouted) loop=(unrouted) keyframes=(unrouted)',
  ArrayModifier: '[modifier] count=modifier offset=modifier muted=modifier',
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
    '[material] name=(unrouted) color=material roughness=material metalness=material opacity=material emissive=material emissiveIntensity=material overridden=(unrouted) muted=(unrouted)',
  Math: '[] op=(unrouted)',
  MediaClip:
    '[layout] name=layout src=(unrouted) mediaKind=(unrouted) srcFps=(unrouted) srcFrames=(unrouted) width=(unrouted) height=(unrouted)',
  MirrorModifier: '[modifier] axis=(unrouted) offset=modifier muted=modifier',
  Mix: '[] factor=(unrouted)',
  Navmesh: '[] halfSize=(unrouted) obstacles=(unrouted)',
  Noise:
    '[] scale=(unrouted) phase=(unrouted) octaves=(unrouted) amplitude=(unrouted) offset=(unrouted)',
  NormalPass: '[render] width=(unrouted) height=(unrouted)',
  Null: '[transform,constraint,driver] position=transform rotation=transform scale=transform',
  Object:
    '[transform,constraint,driver,modifier] position=transform rotation=transform scale=transform',
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
  SetMaterialOp: '[] muted=(unrouted)',
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

export const GOLDEN_TOTALS = { types: 80, routed: 124, unrouted: 215 } as const;
