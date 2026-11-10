/**
 * Releasing a three.js object the studio no longer shows (#36): detached from its parent, and the geometries,
 * materials and textures under it disposed, so a script's group frees its GPU memory when it is rebuilt or the
 * graph stops. Apart from the adapter so a test can run it in Node.
 */
import type * as THREE from 'three';

export function disposeObject3D(object: THREE.Object3D): void {
  object.removeFromParent();
  object.traverse((o) => {
    const mesh = o as THREE.Mesh;
    mesh.geometry?.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    for (const material of materials) {
      // Textures held as the material's properties (map, normalMap…), or in a ShaderMaterial's uniforms.
      // A uniform may hold an array of textures: those are walked too.
      const uniforms = Object.values((material as THREE.ShaderMaterial).uniforms ?? {}).flatMap((u) => {
        const value = (u as { value?: unknown })?.value;
        return Array.isArray(value) ? value : [value];
      });
      for (const value of [...Object.values(material), ...uniforms]) {
        if (value && typeof value === 'object' && (value as THREE.Texture).isTexture) (value as THREE.Texture).dispose();
      }
      material.dispose();
    }
  });
}
