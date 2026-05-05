// Evaluated-output shapes for the v0.5 P0 default DAG.
//
// These POJOs are what each node's evaluate() returns. The viewport
// (SceneFromDAG.tsx) walks them and emits R3F primitives. Keeping the values
// plain JS objects (not THREE instances) preserves determinism — the same
// params always serialize to the same content hash.
//
// Discipline: this file declares NO behavior. It is contract-only.

export type Vec3 = readonly [number, number, number];

export interface CameraValue {
  readonly kind: 'PerspectiveCamera';
  readonly fov: number;
  readonly near: number;
  readonly far: number;
  readonly position: Vec3;
  readonly lookAt: Vec3;
}

export interface DirectionalLightValue {
  readonly kind: 'DirectionalLight';
  readonly intensity: number;
  readonly position: Vec3;
  readonly color: string;
}

export interface BoxMeshValue {
  readonly kind: 'BoxMesh';
  readonly size: Vec3;
  readonly position: Vec3;
  readonly rotation: Vec3;
  readonly material: { name: string; color: string };
}

export type SceneChild = BoxMeshValue;

export interface SceneValue {
  readonly kind: 'Scene';
  readonly camera: CameraValue;
  readonly lights: readonly DirectionalLightValue[];
  readonly children: readonly SceneChild[];
}

export interface PostFxConfig {
  readonly tonemap: 'ACES' | 'Linear';
  readonly smaa: boolean;
}

export interface RenderOutputValue {
  readonly kind: 'RenderOutput';
  readonly scene: SceneValue;
  readonly postFx: PostFxConfig;
}
