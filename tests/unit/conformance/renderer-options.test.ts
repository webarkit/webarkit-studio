/**
 * Renderer options (#129, for the engine-specific three.renderer and babylon.renderer of #137): naming only, as the
 * issue asks. Each engine's names for tone mapping, exposure, pixel ratio and the context's information, read from
 * the classes at these versions, so #137 names its params after what exists. No equivalence is claimed.
 */
import { describe, expect, test } from 'vitest';
import * as THREE from 'three';
import { ImageProcessingConfiguration } from '@babylonjs/core/Materials/imageProcessingConfiguration';
import { ThinEngine } from '@babylonjs/core/Engines/thinEngine';
import { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine';
import { SceneInstrumentation } from '@babylonjs/core/Instrumentation/sceneInstrumentation';
import { EngineInstrumentation } from '@babylonjs/core/Instrumentation/engineInstrumentation';

describe('renderer options: Three.js 0.186', () => {
  test('tone mapping modes', () => {
    expect({
      NoToneMapping: THREE.NoToneMapping,
      LinearToneMapping: THREE.LinearToneMapping,
      ReinhardToneMapping: THREE.ReinhardToneMapping,
      CineonToneMapping: THREE.CineonToneMapping,
      ACESFilmicToneMapping: THREE.ACESFilmicToneMapping,
      AgXToneMapping: THREE.AgXToneMapping,
      NeutralToneMapping: THREE.NeutralToneMapping,
    }).toEqual({ NoToneMapping: 0, LinearToneMapping: 1, ReinhardToneMapping: 2, CineonToneMapping: 3, ACESFilmicToneMapping: 4, AgXToneMapping: 6, NeutralToneMapping: 7 });
  });

  test('WebGLRenderer: toneMapping, toneMappingExposure, outputColorSpace, setPixelRatio, info (instance members)', () => {
    // render, info and the rest are assigned in the constructor: read the source, not the prototype.
    const source = THREE.WebGLRenderer.toString();
    for (const name of ['this.toneMapping', 'this.toneMappingExposure', 'this.setPixelRatio', 'this.info', 'this.getContext']) expect(source).toContain(name);
    expect(Object.getOwnPropertyDescriptor(THREE.WebGLRenderer.prototype, 'outputColorSpace')).toBeDefined();
  });
});

describe('renderer options: Babylon.js 9.30.0', () => {
  test('tone mapping modes on the scene image processing', () => {
    expect({
      STANDARD: ImageProcessingConfiguration.TONEMAPPING_STANDARD,
      ACES: ImageProcessingConfiguration.TONEMAPPING_ACES,
      KHR_PBR_NEUTRAL: ImageProcessingConfiguration.TONEMAPPING_KHR_PBR_NEUTRAL,
    }).toEqual({ STANDARD: 0, ACES: 1, KHR_PBR_NEUTRAL: 2 });
    for (const name of ['toneMappingEnabled', 'toneMappingType', 'exposure', 'contrast']) {
      expect(Object.getOwnPropertyDescriptor(ImageProcessingConfiguration.prototype, name), name).toBeDefined();
    }
  });

  test('pixel ratio is the inverse of the hardware scaling level; the context information is getGlInfo()', () => {
    expect(typeof AbstractEngine.prototype.setHardwareScalingLevel).toBe('function');
    expect(typeof ThinEngine.prototype.getGlInfo).toBe('function');
    expect(typeof SceneInstrumentation).toBe('function');
    expect(typeof EngineInstrumentation).toBe('function');
  });
});
