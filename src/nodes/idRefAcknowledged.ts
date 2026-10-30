// idRefAcknowledged — every string a node's params can store that is NOT another node's id (#1551).
//
// A node id is a plain string, so nothing in a schema separates "holds a node id" from "holds a
// colour". `idRefCensus.gate.test.ts` therefore lists every place a param schema can store a
// string and requires each one to be declared in its type's `idRefs` or named here with what it
// holds instead. A new string param reddens that gate until its author answers the question once.
//
// Before adding a row, ask: can a director or the agent make this value another node's id? If
// yes, it belongs in `idRefs` (src/core/dag/types.ts), not here: an id listed here is invisible
// to delete, to duplicate and to the agent's "what refers to this node".
//
// Keys are `Type.path` in the spelling of `paramStringPaths`: `a[]` an array element, `a{}` a
// record value, `a{key}` a record key, `*` an object that keeps undeclared keys.
//
// REF: src/core/dag/paramStringPaths.ts; src/core/dag/types.ts (`NodeDefinition.idRefs`).

const LABEL = 'a display name';
const COLOUR = 'a colour';
const HASH = 'a content hash';
const LAYER = 'an attribute layer name on the mesh';
const GROUP = 'a component group name on the mesh';
const PACKED = 'packed numeric data';
const STORAGE = 'a file or asset key in project storage';
const PARAM_PATH = 'a parameter path on the target, not a node';
const BODY_INPUT = 'the name of an input the owning node declares (`bodyInputs`)';
const KEYED_VALUE = 'the keyed value itself: text, a colour or an image reference';
const SPARE_KEY = 'the name of a spare parameter on the source node';
const BONE = 'a bone name inside a skeleton';
const IMPORT_KEY = 'a key naming a child inside an imported asset, never a graph node';
const SUB_ELEMENT = 'an id unique within this node only (a curve point)';
const SLOT_INDEX = 'a material slot index, written as a decimal string';
const FOREIGN = "another system's own keys (a ComfyUI graph, an importer's leftovers)";
const TEXT = 'free text';
const BY_NAME = "a choice among wired inputs, made by the input's display name";
const RETIRED = 'retired: nothing reads or writes it since the clone rig went (#1053)';
// #1557 — a template's definition holds a copy of its body: nodes keyed by a name local to the
// definition, so a node, input or socket name there names something of the template's own.
const TEMPLATE_LOCAL = "a name inside the template's own body, not a node of the graph";
const TEMPLATE_TYPE = "a node type name (the template's own, or a body node's)";
// 🔴 NOT settled: a body node's params can name a graph node by id (a Solver's `sourceTransform`),
// and nothing follows it yet. Listed so the gate is answered; the gap is #1661.
const TEMPLATE_BODY_PARAMS =
  "a body node's own params, copied into each instance; an id among them is followed by nothing yet (#1661)";

/**
 * The strings inside one OpenPBR material value (`openpbrMaterialSchema`), relative to wherever
 * a node stores one. Listed once and mounted below, so a string added to the material schema is
 * one new row here rather than one per mount.
 */
export const OPENPBR_VALUE_STRINGS: Readonly<Record<string, string>> = {
  name: LABEL,
  'base.color': COLOUR,
  'specular.color': COLOUR,
  'transmission.color': COLOUR,
  'fuzz.color': COLOUR,
  'emission.color': COLOUR,
  'geometry.colorLayer': LAYER,
  'maps.albedo.hash': HASH,
  'maps.normal.hash': HASH,
  'maps.roughness.hash': HASH,
  'maps.metalness.hash': HASH,
  'maps.emissive.hash': HASH,
  'maps.ao.hash': HASH,
  'maps.coat.hash': HASH,
  'maps.coatRoughness.hash': HASH,
  'maps.coatNormal.hash': HASH,
  'maps.transmission.hash': HASH,
  'maps.thickness.hash': HASH,
  'maps.fuzzColor.hash': HASH,
  'maps.fuzzRoughness.hash': HASH,
  'maps.specularWeight.hash': HASH,
  'maps.specularColor.hash': HASH,
  'mapUvLayers.albedo': LAYER,
  'mapUvLayers.normal': LAYER,
  'mapUvLayers.roughness': LAYER,
  'mapUvLayers.metalness': LAYER,
  'mapUvLayers.emissive': LAYER,
  'mapUvLayers.ao': LAYER,
  'mapUvLayers.coat': LAYER,
  'mapUvLayers.coatRoughness': LAYER,
  'mapUvLayers.coatNormal': LAYER,
  'mapUvLayers.transmission': LAYER,
  'mapUvLayers.thickness': LAYER,
  'mapUvLayers.fuzzColor': LAYER,
  'mapUvLayers.fuzzRoughness': LAYER,
  'mapUvLayers.specularWeight': LAYER,
  'mapUvLayers.specularColor': LAYER,
  'unsupported{key}': FOREIGN,
};

/** Every node param that stores a whole OpenPBR material value, as `Type.path`. */
export const OPENPBR_VALUE_MOUNTS: readonly string[] = [
  'BoxData.material',
  'SphereData.material',
  'PolyMeshData.material',
  'PolyMeshData.materialSlots[]',
  'GltfData.material',
  'GltfData.materialSlots[]',
  'Material.material',
  'Object.slotOverrides{}',
];

const mounted = Object.fromEntries(
  OPENPBR_VALUE_MOUNTS.flatMap((mount) =>
    Object.entries(OPENPBR_VALUE_STRINGS).map(([rel, why]) => [`${mount}.${rel}`, why]),
  ),
);

export const NOT_A_NODE_ID: Readonly<Record<string, string>> = {
  ...mounted,
  'TemplateDefinition.definition.type': TEMPLATE_TYPE,
  'TemplateDefinition.definition.label': LABEL,
  'TemplateDefinition.definition.inputs{key}': TEMPLATE_LOCAL,
  'TemplateDefinition.definition.inputs{}.type': 'a socket type name',
  'TemplateDefinition.definition.output.type': 'a socket type name',
  'TemplateDefinition.definition.body.nodes{key}': TEMPLATE_LOCAL,
  'TemplateDefinition.definition.body.nodes{}.id': TEMPLATE_LOCAL,
  'TemplateDefinition.definition.body.nodes{}.type': TEMPLATE_TYPE,
  'TemplateDefinition.definition.body.nodes{}.params': TEMPLATE_BODY_PARAMS,
  'TemplateDefinition.definition.body.nodes{}.spare{key}': SPARE_KEY,
  'TemplateDefinition.definition.body.nodes{}.spare{}.value': TEMPLATE_BODY_PARAMS,
  'TemplateDefinition.definition.body.nodes{}.spare{}.home.section': 'an inspector section name',
  'TemplateDefinition.definition.body.nodes{}.spare{}.home.label': LABEL,
  'TemplateDefinition.definition.body.nodes{}.inputs{key}': 'a socket name',
  'TemplateDefinition.definition.body.nodes{}.inputs{}.node': TEMPLATE_LOCAL,
  'TemplateDefinition.definition.body.nodes{}.inputs{}.socket': 'a socket name',
  'TemplateDefinition.definition.body.nodes{}.inputs{}[].node': TEMPLATE_LOCAL,
  'TemplateDefinition.definition.body.nodes{}.inputs{}[].socket': 'a socket name',
  'TemplateDefinition.definition.body.nodes{}.meta.name': LABEL,
  'TemplateDefinition.definition.body.nodes{}.meta.nameFrom': TEMPLATE_LOCAL,
  'TemplateDefinition.definition.body.out.node': TEMPLATE_LOCAL,
  'TemplateDefinition.definition.body.out.socket': 'a socket name',
  'Action.name': LABEL,
  'Action.channels[].name': LABEL,
  'Action.channels[].paramPath': PARAM_PATH,
  'Action.channels[].childName': IMPORT_KEY,
  'Action.channels[].assetRef': STORAGE,
  'Action.channels[].sourceClipId': RETIRED,
  'Action.channels[].sourceHash': HASH,
  'Action.channels[].keyframes[].value': KEYED_VALUE,
  'AmbientLight.color': COLOUR,
  'AnimationClip.name': LABEL,
  'AnimationClip.poses[].bones{key}': BONE,
  'AnimationClip.sourceHash': HASH,
  'ArrayModifier.scope': GROUP,
  'BakedData.geometry.key': STORAGE,
  'BakedData.geometry.descriptor.hash': HASH,
  'BakedData.material.color': COLOUR,
  'BakedData.material.emissive': COLOUR,
  'BakedData.material.map.hash': HASH,
  'BakedData.material.normalMap.hash': HASH,
  'BakedData.material.roughnessMap.hash': HASH,
  'BakedData.material.metalnessMap.hash': HASH,
  'BakedData.material.emissiveMap.hash': HASH,
  'BakedData.material.aoMap.hash': HASH,
  'BakedData.material.clearcoatMap.hash': HASH,
  'BakedData.material.clearcoatRoughnessMap.hash': HASH,
  'BakedData.material.clearcoatNormalMap.hash': HASH,
  'BakedData.material.transmissionMap.hash': HASH,
  'BakedData.material.thicknessMap.hash': HASH,
  'BakedData.material.sheenColorMap.hash': HASH,
  'BakedData.material.sheenRoughnessMap.hash': HASH,
  'BakedData.material.specularIntensityMap.hash': HASH,
  'BakedData.material.specularColorMap.hash': HASH,
  'BakedData.material.physical.sheenColor': COLOUR,
  'BakedData.material.physical.specularColor': COLOUR,
  'BakedData.material.physical.attenuationColor': COLOUR,
  'BevelModifier.scope': GROUP,
  'BodyInput.input': BODY_INPUT,
  'BodyInputPose.input': BODY_INPUT,
  'BodyInputVec.input': BODY_INPUT,
  'BoneNameMap.name': LABEL,
  'BoneNameMap.map{key}': BONE,
  'BoneNameMap.map{}': BONE,
  'Character.name': LABEL,
  'ClipSelect.selectedClipName': BY_NAME,
  'ComfyUIWorkflow.graph.apiJson{key}': FOREIGN,
  'ComfyUIWorkflow.graph.apiJson{}': FOREIGN,
  'ComfyUIWorkflow.graph.meta.name': LABEL,
  'ComfyUIWorkflow.graph.meta.importedAt': TEXT,
  'ComfyUIWorkflow.imageBindings{key}': FOREIGN,
  'ComfyUIWorkflow.imageBindings{}': STORAGE,
  'ComfyUIWorkflow.outputPath': STORAGE,
  'ComponentGroupOp.name': LABEL,
  'ComponentGroupOp.scope': GROUP,
  'Composition.name': LABEL,
  'Composition.background': COLOUR,
  'CurveData.points[].id': SUB_ELEMENT,
  'FollowPath.name': LABEL,
  'GltfAsset.assetRef': STORAGE,
  'GltfAsset.nodeNameMap{key}': IMPORT_KEY,
  'GltfAsset.nodeNameMap{}': IMPORT_KEY,
  'GltfAsset.childHierarchy{key}': IMPORT_KEY,
  'GltfAsset.childHierarchy{}[]': IMPORT_KEY,
  'GltfAsset.skins[].jointKeys[]': IMPORT_KEY,
  'GltfAsset.skins[].skeletonRootKey': IMPORT_KEY,
  'GltfAsset.skins[].name': LABEL,
  'GltfAsset.suppressedChildren[]': IMPORT_KEY,
  'GltfAsset.keyByGltfNodeIndex{key}': IMPORT_KEY,
  'GltfAsset.keyByGltfNodeIndex{}': IMPORT_KEY,
  'GltfData.assetRef': STORAGE,
  'GltfData.childName': IMPORT_KEY,
  'Group.parentBone': BONE,
  'KeyframeChannelColor.name': LABEL,
  'KeyframeChannelColor.paramPath': PARAM_PATH,
  'KeyframeChannelColor.keyframes[].value': KEYED_VALUE,
  'KeyframeChannelImage.name': LABEL,
  'KeyframeChannelImage.paramPath': PARAM_PATH,
  'KeyframeChannelImage.keyframes[].value': STORAGE,
  'KeyframeChannelNumber.name': LABEL,
  'KeyframeChannelNumber.paramPath': PARAM_PATH,
  'KeyframeChannelQuat.name': LABEL,
  'KeyframeChannelQuat.paramPath': PARAM_PATH,
  'KeyframeChannelText.name': LABEL,
  'KeyframeChannelText.paramPath': PARAM_PATH,
  'KeyframeChannelVec2.name': LABEL,
  'KeyframeChannelVec2.paramPath': PARAM_PATH,
  'KeyframeChannelVec3.name': LABEL,
  'KeyframeChannelVec3.paramPath': PARAM_PATH,
  'KeyframeChannelVec3.childName': IMPORT_KEY,
  'KeyframeChannelVec3.assetRef': STORAGE,
  'KeyframeChannelVec3.sourceClipId': RETIRED,
  'KeyframeChannelVec3.sourceHash': HASH,
  'Layer.name': LABEL,
  'LightData.color': COLOUR,
  'LightData.tex': STORAGE,
  'LightProfileSelect.selectedProfile': BY_NAME,
  'LightRig.name': LABEL,
  'MaskModifier.scope': GROUP,
  'MaterialOverride.name': LABEL,
  'MaterialOverride.color': COLOUR,
  'MaterialOverride.emissive': COLOUR,
  'MaterialOverrideOp.name': LABEL,
  'MaterialOverrideOp.color': COLOUR,
  'MaterialOverrideOp.emissive': COLOUR,
  'MaterialOverrideOp.scope': GROUP,
  'MediaClip.name': LABEL,
  'MediaClip.src': STORAGE,
  'MirrorModifier.scope': GROUP,
  'MotionGenerate.prompt': TEXT,
  'MotionGenerate.model': TEXT,
  'Object.slotOverrides{key}': SLOT_INDEX,
  'Object.parentBone': BONE,
  'ParamDriver.paramPath': PARAM_PATH,
  'ParamDriver.sourceSpare.key': SPARE_KEY,
  'PolyMeshData.mesh.points': PACKED,
  'PolyMeshData.mesh.faceSizes': PACKED,
  'PolyMeshData.mesh.cornerPoints': PACKED,
  'PolyMeshData.mesh.cornerLayers[].name': LAYER,
  'PolyMeshData.mesh.cornerLayers[].data': PACKED,
  'PolyMeshData.mesh.cornerNormals': PACKED,
  'PolyMeshData.mesh.faceLayers[].name': LAYER,
  'PolyMeshData.mesh.faceLayers[].data': PACKED,
  'PolyMeshData.mesh.pointLayers[].name': LAYER,
  'PolyMeshData.mesh.pointLayers[].data': PACKED,
  'PolyMeshData.mesh.vertexGroups[]': GROUP,
  'PoseLayer.name': LABEL,
  'PoseLayer.members[].bone': BONE,
  'PoseLayer.channels[].name': LABEL,
  'PoseLayer.channels[].bone': BONE,
  'PoseLayer.ik.root': BONE,
  'PoseLayer.ik.mid': BONE,
  'PoseLayer.ik.tip': BONE,
  'PoseLayer.ik.goal': BONE,
  'PoseLayer.ik.pole': BONE,
  'Prompt.text': TEXT,
  'Prompt.negative': TEXT,
  'Prompt.tags[]': TEXT,
  'RenderJob.jobId': TEXT,
  'RenderJob.outputPath': STORAGE,
  'RetargetClip.name': LABEL,
  'Scene.envSource.name': LABEL,
  'Scene.envSource.assetRef': STORAGE,
  'SetMaterialOp.scope': GROUP,
  'Skeleton.bones[].name': BONE,
  'Strip.name': LABEL,
  'Track.name': LABEL,
  'TrackTo.name': LABEL,
  'TrackTo.aimBone': BONE,
  'TransformClip.name': LABEL,
  'TransformClip.keyframes[].targetNodeId': IMPORT_KEY,
  'VideoStitch.outputPath': STORAGE,
};

/**
 * #1560 — the input sockets that OWN NOTHING: what is wired here is left alone when the node
 * holding the socket is deleted, and stays shared when it is duplicated. Everything else says
 * what it owns on the socket (`InputDescriptor.owns`, `body`, or an operator's `chain.input`).
 *
 * A socket has to be in one place or the other (`idRefCensus.gate.test.ts`), so a new one is a
 * choice someone made. The two that were never chosen, a pose layer's `pose` and a Solver's
 * `body`, are how deleting a character left its whole pose stack in the file.
 */
export const SHARED_WIRES: readonly string[] = [
  'AnimationClip.skeleton',
  'AnimationClip.source',
  'ArmatureModifier.armature',
  'BeautyPass.camera',
  'BeautyPass.scene',
  'BeautyPass.time',
  'BoxData.material',
  'CameraSelect.cameras',
  'CaptureModifier.armature',
  'Character.locomotion',
  'ClipSelect.clips',
  'Collection.collections',
  'Collection.members',
  'ComfyUIWorkflow.pass-input',
  'ComfyUIWorkflow.prompt',
  'ComfyUIWorkflow.time',
  'Composition.layers',
  'DepthPass.camera',
  'DepthPass.scene',
  'DepthPass.time',
  'GltfAsset.transformClip',
  'GltfSkeleton.asset',
  'IDPass.camera',
  'IDPass.scene',
  'IDPass.time',
  'Layer.source',
  'LightProfileSelect.rigs',
  'LightRig.lights',
  'LocomotionState.path',
  'LocomotionState.pose',
  'LocomotionState.time',
  'MotionGenerate.path',
  'NormalPass.camera',
  'NormalPass.scene',
  'NormalPass.time',
  'PosedSkeleton.skeleton',
  'RenderJob.pass-input',
  'RenderJob.time',
  'RenderOutput.scene',
  'RetargetClip.skeleton',
  'RetargetClip.source',
  'Scatter.assets',
  'Scene.camera',
  'Scene.children',
  'Scene.collections',
  'Scene.lightRig',
  'Scene.lights',
  'SetMaterialOp.material',
  'SphereData.material',
  'VideoStitch.pass-input',
  'VideoStitch.time',
  'WalkPath.navmesh',
];
