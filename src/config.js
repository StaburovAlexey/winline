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
    // "fit" подгоняет камеру автоматически, "manual" берёт координаты ниже.
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
        target: { x: 0, y:0, z: 0 },
      },
    },

    fit: {
      // 1 = заполнить 100% ширины, 0.9 = оставить по 5% с каждой стороны.
      mobileWidthFill: 1,
      desktopPadding: 1,
      // Смещение задаёт ракурс и масштабируется вместе с дистанцией камеры.
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
    // Эффективная гравитация уже учитывает выталкивание жидкостью.
    gravity: { x: 0, y: -1.4, z: 0 },
    fixedTimeStep: 1 / 60,
    maxSubSteps: 4,
    ccdSubsteps: 4,
    additionalSolverIterations: 4,
    clipColliderScale: 1,
    ballColliderScale: 1,
    clipMass: 0.3,
    ballMass: 1,
    friction: 0.8,
    restitution: 0.02,
    linearDamping: 0.05,
    angularDamping: 0.7,
    // Меньше значение — больше задержка и плавнее реакция за указателем.
    pointerSmoothing: 1,
    maxPointerVelocity: 6,
    maxLinearSpeed: 2,
    maxAngularSpeed: 2,

    // Упрощённая модель глицерина: поток + вязкое сопротивление.
    fluid: {
      drag: 2.2,
      flowDecay: 0.95,
      minimumEnergy: 0.015,
      upwardSpeedMin: 1.05,
      upwardSpeedMax: 1.45,
      swirlSpeedMin: 0.035,
      swirlSpeedMax: 0.075,
      turbulenceSpeed: 0.075,
      returnFlowSpeed: 0.42,
      inwardSpeed: 0.16,
      wallStartRadius: 0.68,
      topSlowdownStart: 0.58,
    },
  },

  renderer: {
    maxPixelRatio: 2,
  },
};
