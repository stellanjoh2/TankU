// Look defaults from Ultra-Water's Water / Waves / Shore folders (MIT, Humpalumps).
// Colour presets are linear RGB: absorption (1/m), in-scatter, thin-foam tint.

// Two cascades (was three: 600 / 85 / 12) — ~25–33% less FFT + shade samples.
// Mid length nudged down so wind chop still covers what the old 12 m band held.
export const CASCADE_LENGTHS = [600, 45];

export const WATER_PRESETS = {
  clear: { absorption: [0.42, 0.075, 0.048], scatter: [0.0, 0.05, 0.08], foam: [0.62, 0.78, 0.82] },
  tropical: { absorption: [0.36, 0.045, 0.06], scatter: [0.0, 0.085, 0.085], foam: [0.66, 0.86, 0.84] },
  'toxic green': { absorption: [0.45, 0.1, 1.1], scatter: [0.05, 0.1, 0.004], foam: [0.74, 0.84, 0.42] },
  purple: { absorption: [0.22, 0.85, 0.1], scatter: [0.05, 0.0, 0.09], foam: [0.8, 0.66, 0.88] },
  'rust orange': { absorption: [0.1, 0.34, 1.2], scatter: [0.11, 0.035, 0.004], foam: [0.9, 0.72, 0.55] },
  'murky brown': { absorption: [0.55, 0.62, 0.9], scatter: [0.045, 0.045, 0.022], foam: [0.78, 0.74, 0.6] },
};

export const OCEAN_DEFAULTS = {
  preset: 'tropical',
  clarity: 0.35,
  windSpeed: 5,
  windDirection: 180,
  fetchKm: 40,
  waveScale: 0.1,
  spreadBlend: 0.46,
  swellScale: 1.3,
  swellDirection: -15,
  choppiness: 0.85,
  timeScale: 1,
  shoreAmplitude: 0.7,
  shoreWavelength: 46,
  shoreSpeed: 0.6,
  shoreSteepness: 1.1,
  roughness: 0.07,
  refraction: 0.19,
  reflectionDistort: 0.02,
  sssPeak: 1.55,
  sssView: 0.06,
  foamBias: 0.05,
  foamScale: 1.3,
  foamRecovery: 0.73,
  shoreFoamBand: 0.35,
  glitter: 0.6,
  horizon: 370,
};

export function oceanParamsFrom(src = {}) {
  return { ...OCEAN_DEFAULTS, ...src };
}
