// Tinted directional shadows for MeshStandard/Physical materials (WebGL has no built-in shadow colour).
import * as THREE from 'three';

export const shadowTint = { value: new THREE.Color(0, 0, 0) };

const DIR_SHADOW_LINE =
  'directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;';

const DIR_SHADOW_TINTED = `{
  float sm = ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;
  directLight.color *= mix( shadowTint, vec3( 1.0 ), sm );
}`;

/** Patch standard materials under `root` so directional shadows mix toward `shadowTint`. */
export function patchShadowTint(root) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m || m.userData.shadowTintPatched) continue;
      if (!m.isMeshStandardMaterial && !m.isMeshPhysicalMaterial) continue;
      m.userData.shadowTintPatched = true;
      const prev = m.onBeforeCompile;
      m.onBeforeCompile = (shader, renderer) => {
        prev?.call(m, shader, renderer);
        shader.uniforms.shadowTint = shadowTint;
        shader.fragmentShader = `uniform vec3 shadowTint;\n${shader.fragmentShader}`
          .replace(DIR_SHADOW_LINE, DIR_SHADOW_TINTED);
      };
      m.needsUpdate = true;
    }
  });
}
