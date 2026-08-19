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
        position: { x: 0, y:0, z: 2.5 },
        target: { x: 0, y: 0, z: 0 },
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

    // Rapier отвечает только за gravity, collisions, stacking и sleep.
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

    // Меньше значение — больше задержка и плавнее реакция за указателем.
    pointerSmoothing: 1,
    maxPointerVelocity: 6,
    maxLinearSpeed: 3.5,
    maxAngularSpeed: 2,

    // Наша часть симуляции: только velocity field + viscous drag.
    // В modelPhysics сила на тело вычисляется как
    // (fluidVelocity - bodyVelocity) * drag * mass.
    fluid: {
      drag: 4.0,
      flowDecay: 0.62,
      minimumEnergy: 0.015,

      // Сильный вертикальный поток после свайпа.
      upwardSpeedMin: 2.2,
      upwardSpeedMax: 3.2,

      // Вихрь остаётся вторичным относительно вертикального потока.
      swirlSpeedMin: 0.035,
      swirlSpeedMax: 0.08,

      // Более заметная, но всё ещё плавная неоднородность потока.
      turbulenceSpeed: 0.09,

      returnFlowSpeed: 0,
      inwardSpeed: 0,

      // У стекла скорость жидкости плавно уменьшается.
      wallStartRadius: 0.72,
      topSlowdownStart: 0.62,
    },
  },

  renderer: {
    maxPixelRatio: 2,
  },
};
