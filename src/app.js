import * as THREE from "three";
import Stats from "stats.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { appConfig } from "./config.js";
import { createModelPhysics } from "./modelPhysics.js";
import { createParallaxController } from "./parallax.js";
import "./style.css";

document.body.style.setProperty(
  "--background-image",
  `url("${import.meta.env.BASE_URL}assets/background.png")`,
);

const sceneElement = document.querySelector("#scene");
const statusElement = document.querySelector("#status");
const motionPermissionButton = document.querySelector("#motion-permission");
const shakeTestButton = document.querySelector("#shake-test");
const motionPermissionStatusElement = document.querySelector(
  "#motion-permission-status",
);

if (
  !(sceneElement instanceof HTMLElement)
  || !(statusElement instanceof HTMLElement)
  || !(motionPermissionButton instanceof HTMLButtonElement)
  || !(shakeTestButton instanceof HTMLButtonElement)
  || !(motionPermissionStatusElement instanceof HTMLElement)
) {
  throw new Error("Scene root elements are missing");
}

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(
  appConfig.camera.fov,
  1,
  appConfig.camera.near,
  appConfig.camera.far,
);
const renderer = new THREE.WebGLRenderer({
  alpha: true,
  antialias: appConfig.renderer.antialias,
  powerPreference: "high-performance",
});

renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setClearColor(0x000000, 0);
renderer.setPixelRatio(
  Math.min(window.devicePixelRatio, appConfig.renderer.maxPixelRatio),
);
sceneElement.append(renderer.domElement);

const statsRequested =
  new URLSearchParams(window.location.search).get("stats") === "1";
const statsEnabled =
  import.meta.env.DEV || statsRequested || appConfig.renderer.showStats;
const stats = statsEnabled ? new Stats() : null;
const physicsStatsPanel = stats?.addPanel(
  new Stats.Panel("PHY", "#ff8", "#221"),
);
const physicsStepStatsPanel = stats?.addPanel(
  new Stats.Panel("STP", "#f8f", "#212"),
);
const physicsSubstepStatsPanel = stats?.addPanel(
  new Stats.Panel("SUB", "#8f8", "#121"),
);
const renderStatsPanel = stats?.addPanel(
  new Stats.Panel("REN", "#8ff", "#122"),
);
if (stats) {
  stats.showPanel(0);
  stats.dom.style.position = "fixed";
  stats.dom.style.zIndex = "10";
  document.body.append(stats.dom);
}

const controls = new OrbitControls(camera, renderer.domElement);
controls.enabled = appConfig.controls.enabled;
controls.enableDamping = appConfig.controls.enableDamping;
controls.dampingFactor = appConfig.controls.dampingFactor;
controls.enableRotate = appConfig.controls.enableRotate;
controls.enableZoom = appConfig.controls.enableZoom;
controls.enablePan = appConfig.controls.enablePan;
controls.minDistance = appConfig.controls.minDistance;
controls.maxDistance = appConfig.controls.maxDistance;

let model = null;
let modelPhysics = null;

const parallax = createParallaxController({
  camera,
  target: controls.target,
  canvas: renderer.domElement,
  backgroundElement: document.body,
  permissionButton: motionPermissionButton,
  permissionStatusElement: motionPermissionStatusElement,
  config: appConfig.parallax,
  onShake: ({ strength, direction, coherence }) => {
    modelPhysics?.applyShake({ strength, direction, coherence });
  },
});

if (import.meta.env.DEV) {
  const shakeTestCases = [
    {
      label: "телефон вправо",
      acceleration: { x: 4, y: 0, z: 0 },
    },
    {
      label: "телефон влево",
      acceleration: { x: -4, y: 0, z: 0 },
    },
    {
      label: "телефон от себя",
      acceleration: { x: 0, y: 0, z: -4 },
    },
    {
      label: "телефон на себя",
      acceleration: { x: 0, y: 0, z: 4 },
    },
  ];
  let shakeTestIndex = 0;
  const updateShakeTestLabel = () => {
    shakeTestButton.textContent = `Тест: ${shakeTestCases[shakeTestIndex].label}`;
  };

  shakeTestButton.hidden = false;
  updateShakeTestLabel();
  shakeTestButton.addEventListener("click", () => {
    parallax.triggerTestMotion({
      strength: 1,
      acceleration: shakeTestCases[shakeTestIndex].acceleration,
    });
    shakeTestIndex = (shakeTestIndex + 1) % shakeTestCases.length;
    updateShakeTestLabel();
  });
}

let failedAssetUrl = null;
let renderInfoLogged = false;
const clock = new THREE.Clock();
const frameInterval = 1000 / Math.max(appConfig.renderer.maxFps, 1);
let lastFrameTime = 0;

function setStatus(message, state = "loading") {
  statusElement.textContent = message;
  statusElement.classList.toggle("is-hidden", state === "ready");
  statusElement.classList.toggle("is-error", state === "error");
}

const loadingManager = new THREE.LoadingManager();
loadingManager.onStart = () => setStatus("Загрузка GLB-модели…");
loadingManager.onProgress = (_url, loaded, total) => {
  if (total > 0) {
    setStatus(`Загрузка ресурсов: ${Math.round((loaded / total) * 100)}%`);
  }
};
loadingManager.onLoad = () => setStatus("Подготовка модели…");
loadingManager.onError = (url) => {
  failedAssetUrl = url;
  console.error(`Не удалось загрузить ассет: ${url}`);
};

function matchesNode(node, meshNames, geometryNames) {
  return meshNames.includes(node.name) || geometryNames.includes(node.geometry?.name);
}

function configureTexture(texture) {
  if (!texture || (!texture.image && !texture.source?.data)) {
    return;
  }

  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  texture.needsUpdate = true;
}

function createBasicMaterial(source, keepTransparent) {
  if (source.map) {
    configureTexture(source.map);
  }

  const material = new THREE.MeshBasicMaterial({
    alphaMap: source.alphaMap,
    alphaTest: keepTransparent ? source.alphaTest : 0,
    blending: source.blending,
    color: source.map ? 0xffffff : source.color,
    depthTest: true,
    depthWrite: !keepTransparent,
    fog: source.fog,
    map: source.map,
    opacity: keepTransparent ? source.opacity : 1,
    premultipliedAlpha: source.premultipliedAlpha,
    side: source.side,
    toneMapped: source.toneMapped,
    transparent: keepTransparent,
    vertexColors: source.vertexColors,
  });

  material.name = source.name;
  material.visible = source.visible;
  return material;
}

function configureModelMaterials(root) {
  const materialCache = new Map();
  const originalMaterials = new Set();

  root.traverse((node) => {
    if (!node.isMesh) {
      return;
    }

    const keepTransparent = matchesNode(
      node,
      appConfig.materials.transparentMeshNames,
      appConfig.materials.transparentGeometryNames,
    );

    const sourceMaterials = Array.isArray(node.material)
      ? node.material
      : [node.material];
    const basicMaterials = sourceMaterials.map((source) => {
      if (!source) {
        return source;
      }

      originalMaterials.add(source);
      let variants = materialCache.get(source);
      if (!variants) {
        variants = new Map();
        materialCache.set(source, variants);
      }

      const variantKey = keepTransparent ? "transparent" : "opaque";
      if (!variants.has(variantKey)) {
        variants.set(variantKey, createBasicMaterial(source, keepTransparent));
      }

      return variants.get(variantKey);
    });

    node.material = Array.isArray(node.material)
      ? basicMaterials
      : basicMaterials[0];
  });

  for (const material of originalMaterials) {
    material.dispose();
  }
}

function normalizeModel(root) {
  const initialBox = new THREE.Box3().setFromObject(root);
  const size = initialBox.getSize(new THREE.Vector3());
  const largestDimension = Math.max(size.x, size.y, size.z);

  if (largestDimension > 0) {
    root.scale.multiplyScalar(1 / largestDimension);
  }

  root.updateMatrixWorld(true);
  const normalizedBox = new THREE.Box3().setFromObject(root);
  const center = normalizedBox.getCenter(new THREE.Vector3());
  root.position.sub(center);
  root.updateMatrixWorld(true);
}

function applyModelConfig(root) {
  if (appConfig.model.normalize) {
    normalizeModel(root);
  }

  const { position, rotationDegrees, scale } = appConfig.model;
  root.position.add(new THREE.Vector3(position.x, position.y, position.z));
  root.rotation.set(
    THREE.MathUtils.degToRad(rotationDegrees.x),
    THREE.MathUtils.degToRad(rotationDegrees.y),
    THREE.MathUtils.degToRad(rotationDegrees.z),
  );
  root.scale.multiplyScalar(scale);
  root.updateMatrixWorld(true);
}

function isExcludedFromFit(node) {
  return matchesNode(
    node,
    appConfig.camera.fit.excludedMeshNames,
    appConfig.camera.fit.excludedGeometryNames,
  );
}

function getModelContentBox(root) {
  const contentBox = new THREE.Box3().makeEmpty();
  const meshBox = new THREE.Box3();

  root.updateMatrixWorld(true);
  root.traverse((node) => {
    if (!node.isMesh || isExcludedFromFit(node) || !node.geometry) {
      return;
    }

    if (!node.geometry.boundingBox) {
      node.geometry.computeBoundingBox();
    }

    meshBox.copy(node.geometry.boundingBox).applyMatrix4(node.matrixWorld);
    contentBox.union(meshBox);
  });

  return contentBox;
}

function getHorizontalFitDistance(root, center, horizontalHalfFov) {
  const corner = new THREE.Vector3();
  const tanHorizontalHalfFov = Math.tan(horizontalHalfFov);
  const widthFill = appConfig.camera.fit.mobileWidthFill;
  let requiredDistance = 0;

  root.updateMatrixWorld(true);
  root.traverse((node) => {
    if (!node.isMesh || isExcludedFromFit(node) || !node.geometry) {
      return;
    }

    if (!node.geometry.boundingBox) {
      node.geometry.computeBoundingBox();
    }

    const { min, max } = node.geometry.boundingBox;
    for (const x of [min.x, max.x]) {
      for (const y of [min.y, max.y]) {
        for (const z of [min.z, max.z]) {
          corner.set(x, y, z).applyMatrix4(node.matrixWorld);
          const horizontalOffset = Math.abs(corner.x - center.x);
          const depthOffset = corner.z - center.z;
          const distance =
            depthOffset + horizontalOffset / (tanHorizontalHalfFov * widthFill);

          requiredDistance = Math.max(requiredDistance, distance);
        }
      }
    }
  });

  return requiredDistance;
}

function applyFitCamera(viewportWidth) {
  const fullBox = new THREE.Box3().setFromObject(model);
  const isMobile = viewportWidth < appConfig.camera.breakpoint;
  const contentBox = getModelContentBox(model);
  const fitBox = contentBox.isEmpty() ? fullBox : contentBox;
  const center = fitBox.getCenter(new THREE.Vector3());
  const sphere = fitBox.getBoundingSphere(new THREE.Sphere());
  const verticalHalfFov = THREE.MathUtils.degToRad(camera.fov / 2);
  const horizontalHalfFov = Math.atan(Math.tan(verticalHalfFov) * camera.aspect);
  const halfFov = Math.min(verticalHalfFov, horizontalHalfFov);
  const referenceDistance =
    (sphere.radius / Math.sin(verticalHalfFov)) * appConfig.camera.fit.desktopPadding;
  const distance = isMobile
    ? getHorizontalFitDistance(model, center, horizontalHalfFov)
    : (sphere.radius / Math.sin(halfFov)) * appConfig.camera.fit.desktopPadding;

  const positionOffset = appConfig.camera.fit.positionOffset;
  const offsetScale = referenceDistance > 0 ? distance / referenceDistance : 1;
  const targetOffset = appConfig.camera.fit.targetOffset;
  const target = new THREE.Vector3(
    center.x + targetOffset.x,
    center.y + targetOffset.y,
    center.z + targetOffset.z,
  );

  camera.position.set(
    target.x + positionOffset.x * offsetScale,
    target.y + positionOffset.y * offsetScale,
    target.z + distance + positionOffset.z * offsetScale,
  );
  controls.target.copy(target);
  camera.lookAt(target);
}

function applyManualCamera(viewportWidth) {
  const profile = viewportWidth < appConfig.camera.breakpoint
    ? appConfig.camera.manual.mobile
    : appConfig.camera.manual.desktop;

  camera.position.set(profile.position.x, profile.position.y, profile.position.z);
  controls.target.set(profile.target.x, profile.target.y, profile.target.z);
  camera.lookAt(controls.target);
}

function updateCamera(viewportWidth) {
  camera.fov = appConfig.camera.fov;
  camera.near = appConfig.camera.near;
  camera.far = appConfig.camera.far;

  if (appConfig.camera.mode === "manual") {
    applyManualCamera(viewportWidth);
  } else if (model) {
    applyFitCamera(viewportWidth);
  }

  camera.updateProjectionMatrix();
  controls.update();
  parallax.captureBasePose();
}

function resize() {
  const width = sceneElement.clientWidth || window.innerWidth;
  const height = sceneElement.clientHeight || window.innerHeight;

  camera.aspect = width / Math.max(height, 1);
  renderer.setSize(width, height, false);
  updateCamera(width);
}

function animate(time) {
  const elapsed = time - lastFrameTime;
  if (elapsed < frameInterval) {
    return;
  }

  lastFrameTime = time - (elapsed % frameInterval);
  stats?.begin();
  const deltaTime = clock.getDelta();
  const physicsStartTime = performance.now();
  modelPhysics?.update(deltaTime);
  physicsStatsPanel?.update(performance.now() - physicsStartTime, 20);
  const physicsSnapshot = modelPhysics?.getPerformanceSnapshot();
  physicsStepStatsPanel?.update(physicsSnapshot?.worldStepMs ?? 0, 20);
  physicsSubstepStatsPanel?.update(
    physicsSnapshot?.substeps ?? 0,
    appConfig.physics.maxSubSteps,
  );
  controls.update();
  parallax.update(deltaTime);
  const renderStartTime = performance.now();
  renderer.render(scene, camera);
  renderStatsPanel?.update(performance.now() - renderStartTime, 20);

  if (model && !renderInfoLogged) {
    console.info("Three.js render info", {
      calls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      geometries: renderer.info.memory.geometries,
      textures: renderer.info.memory.textures,
    });
    renderInfoLogged = true;
  }

  stats?.end();
}

async function loadScene() {
  const dracoLoader = new DRACOLoader(loadingManager);
  dracoLoader.setDecoderPath(appConfig.model.dracoDecoderPath);
  dracoLoader.preload();

  const loader = new GLTFLoader(loadingManager);
  loader.setDRACOLoader(dracoLoader);

  let gltf;
  try {
    gltf = await loader.loadAsync(appConfig.model.url);
  } finally {
    dracoLoader.dispose();
  }

  const sphereCollider = gltf.scene.getObjectByName(
    appConfig.physics.sphereColliderName,
  );
  if (sphereCollider) {
    sphereCollider.visible = false;
  }

  const staticBaseCollider = gltf.scene.getObjectByName(
    appConfig.physics.staticBaseColliderName,
  );
  if (staticBaseCollider) {
    staticBaseCollider.visible = false;
  }

  configureModelMaterials(gltf.scene);
  applyModelConfig(gltf.scene);
  scene.add(gltf.scene);
  model = gltf.scene;
  resize();

  if (appConfig.physics.enabled) {
    setStatus("Подготовка физики…");

    try {
      modelPhysics = await createModelPhysics({
        root: model,
        camera,
        canvas: renderer.domElement,
        config: appConfig.physics,
      });
    } catch (error) {
      console.error("Не удалось подготовить физику модели", error);
      setStatus("Модель загружена без физики", "error");
      return;
    }
  }

  if (failedAssetUrl) {
    setStatus("Модель загружена, но часть ресурсов недоступна", "error");
    return;
  }

  setStatus("Модель готова", "ready");
}

window.addEventListener("resize", resize, { passive: true });
window.addEventListener("pagehide", () => {
  renderer.setAnimationLoop(null);
  modelPhysics?.dispose();
  parallax.dispose();
}, { once: true });
resize();
renderer.setAnimationLoop(animate);

loadScene().catch((error) => {
  console.error("Не удалось загрузить Winline GLB", error);
  setStatus("Не удалось загрузить 3D-модель", "error");
});
