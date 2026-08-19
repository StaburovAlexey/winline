export const appConfig = {
  model: {
    url: `${import.meta.env.BASE_URL}assets/winlineDraco.glb`,
    dracoDecoderPath: `${import.meta.env.BASE_URL}draco/`,
    normalize: true,
    scale: 1,
    position: { x: 0, y: 0, z: 0 },
    rotationDegrees: { x: 0, y: 35, z: 0 },
  },

  camera: {
    mode: "fit",
    fov: 24,
    near: 0.001,
    far: 100,
    breakpoint: 728,
    manual: {
      desktop: {
        position: { x: 0, y: 0, z: 2 },
        target: { x: 0, y: 0, z: 0 },
      },
      mobile: {
        position: { x: 0, y: 0, z: 2.5 },
        target: { x: 0, y: 0, z: 0 },
      },
    },
    fit: {
      mobileWidthFill: 1,
      desktopPadding: 1,
      positionOffset: { x: 0, y: 2, z: 0 },
      targetOffset: { x: 0, y: 0, z: 0 },
      excludedMeshNames: ["Sphere"],
      excludedGeometryNames: ["Sphere.020"],
    },
  },

  controls: {
    enabled: false,
    enableDamping: true,
    dampingFactor: 0.06,
    enableRotate: true,
    enableZoom: true,
    enablePan: false,
    minDistance: 0.15,
    maxDistance: Infinity,
  },

  materials: {
    useBakedEmission: true,
    emissiveIntensity: 1,
    transparentMeshNames: ["Sphere"],
    transparentGeometryNames: ["Sphere.020"],
  },

  physics: {
    enabled: true,
    gravity: { x: 0, y: -0.95, z: 0 },
    fixedTimeStep: 1 / 60,
    maxSubSteps: 4,
    ccdSubsteps: 4,
    additionalSolverIterations: 4,

    clipColliderScale: 1,
    ballColliderScale: 1,
    clipMass: 0.3,
    ballMass: 1,

    friction: 0.65,
    restitution: 0.02,
    linearDamping: 0.05,
    angularDamping: 0.7,

    pointerSmoothing: 1,
    maxPointerVelocity: 6,
    maxLinearSpeed: 3.5,
    maxAngularSpeed: 2,

    fluid: {
      drag: 2.1,
      flowDecay: 0.62,
      minimumEnergy: 0.015,

      // Плавный старт общего потока и небольшой разброс старта между телами.
      rampDuration: 0.28,
      maxBodyDelay: 0.14,
      flowFactorMin: 0.7,
      flowFactorMax: 1.3,
      dragFactorMin: 0.75,
      dragFactorMax: 1.25,

      // Поток остаётся сильным, но тела больше не обязаны лететь одной скоростью.
      upwardSpeedMin: 2.4,
      upwardSpeedMax: 3.3,
      swirlSpeedMin: 0.025,
      swirlSpeedMax: 0.055,
      turbulenceSpeed: 0.22,
      dispersionSpeed: 0.12,

      wallStartRadius: 0.72,
      topSlowdownStart: 0.62,
    },
  },

  renderer: {
    maxPixelRatio: 2,
  },
};
