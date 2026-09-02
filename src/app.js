import * as THREE from "three";
import Stats from "stats.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { appConfig } from "./config.js";
import cardData from "./card.json";
import { createParallaxController } from "./parallax.js";
import "modern-normalize";
import "./style.css";

const sceneElement = document.querySelector("#scene");
const sceneAssetImages = document.querySelectorAll(
  "#scene-environment img[data-src], #scene-decorations img[data-src]",
);
const startScreenElement = document.querySelector("#start-screen");
const startButton = document.querySelector("#start-button");
const loadingScreenElement = document.querySelector("#loading-screen");
const loadingLogoElement = document.querySelector(".loading-logo");
const loadingBarElement = document.querySelector("#loading-bar");
const loadingLabelElement = document.querySelector("#loading-label");
const loadingProgressElement = document.querySelector("#loading-progress");
const sceneActionsElement = document.querySelector("#scene-actions");
const sceneShakeHintElement = document.querySelector("#scene-shake-hint");
const predictionButton = document.querySelector("#prediction-button");
const predictionModal = document.querySelector("#prediction-modal");
const predictionMoreButton = document.querySelector("#prediction-more-button");
const predictionCardImage = document.querySelector("#prediction-card-image");
const predictionCardText = document.querySelector("#prediction-card-text");
const loadingScreenPreviewMode = document.body.classList.contains(
  "is-loading-preview",
);
const motionPermissionButton = document.querySelector("#motion-permission");
const shakeTestButton = document.querySelector("#shake-test");
const motionPermissionStatusElement = document.querySelector(
  "#motion-permission-status",
);

if (
  !(sceneElement instanceof HTMLElement)
  || !(startScreenElement instanceof HTMLElement)
  || !(startButton instanceof HTMLButtonElement)
  || !(loadingScreenElement instanceof HTMLElement)
  || !(loadingLogoElement instanceof HTMLImageElement)
  || !(loadingBarElement instanceof HTMLElement)
  || !(loadingLabelElement instanceof HTMLElement)
  || !(loadingProgressElement instanceof HTMLElement)
  || !(sceneActionsElement instanceof HTMLElement)
  || !(sceneShakeHintElement instanceof HTMLElement)
  || !(predictionButton instanceof HTMLButtonElement)
  || !(predictionModal instanceof HTMLElement)
  || !(predictionMoreButton instanceof HTMLButtonElement)
  || !(predictionCardImage instanceof HTMLImageElement)
  || !(predictionCardText instanceof HTMLElement)
  || !(motionPermissionButton instanceof HTMLButtonElement)
  || !(shakeTestButton instanceof HTMLButtonElement)
  || !(motionPermissionStatusElement instanceof HTMLElement)
) {
  throw new Error("Scene root elements are missing");
}

if (loadingScreenPreviewMode) {
  prepareLoadingAssets();
  loadingScreenElement.classList.remove("is-hidden");
  loadingScreenElement.setAttribute("aria-hidden", "false");
  startScreenElement.classList.add("is-hidden");
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
  !loadingScreenPreviewMode
  && (import.meta.env.DEV || statsRequested || appConfig.renderer.showStats);
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

const hasShakeInput =
  typeof window.DeviceMotionEvent !== "undefined"
  && window.matchMedia("(pointer: coarse)").matches;
sceneShakeHintElement.hidden = !hasShakeInput;

const predictionStorageKey = "winline:prediction-deck:v1";
const predictionCards = new Map(
  Object.entries(cardData).filter(
    ([cardId, card]) => /^\d+$/.test(cardId) && typeof card?.text === "string",
  ),
);
const predictionCardIds = [...predictionCards.keys()];
const predictionCardSignature = predictionCardIds.join(",");
let predictionCardsPreloadPromise = null;

function shuffleCardIds(cardIds) {
  const shuffled = [...cardIds];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const targetIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[targetIndex]] = [
      shuffled[targetIndex],
      shuffled[index],
    ];
  }
  return shuffled;
}

function createPredictionDeck(lastCardId = null) {
  const remaining = shuffleCardIds(predictionCardIds);
  if (
    remaining.length > 1
    && lastCardId !== null
    && remaining[0] === lastCardId
  ) {
    const replacementIndex = remaining.findIndex(
      (cardId) => cardId !== lastCardId,
    );
    [remaining[0], remaining[replacementIndex]] = [
      remaining[replacementIndex],
      remaining[0],
    ];
  }
  return { remaining, lastCardId };
}

function loadPredictionDeck() {
  try {
    const savedState = JSON.parse(
      window.localStorage.getItem(predictionStorageKey) ?? "null",
    );
    const remaining = savedState?.remaining;
    const hasValidRemainingCards =
      Array.isArray(remaining)
      && new Set(remaining).size === remaining.length
      && remaining.every((cardId) => predictionCards.has(cardId));
    const hasValidLastCard =
      savedState?.lastCardId === null
      || predictionCards.has(savedState?.lastCardId);

    if (
      savedState?.signature === predictionCardSignature
      && hasValidRemainingCards
      && hasValidLastCard
    ) {
      return {
        remaining: [...remaining],
        lastCardId: savedState.lastCardId,
      };
    }
  } catch (error) {
    console.warn("Не удалось восстановить историю предсказаний", error);
  }
  return createPredictionDeck();
}

function savePredictionDeck(deck) {
  try {
    window.localStorage.setItem(
      predictionStorageKey,
      JSON.stringify({
        signature: predictionCardSignature,
        remaining: deck.remaining,
        lastCardId: deck.lastCardId,
      }),
    );
  } catch (error) {
    console.warn("Не удалось сохранить историю предсказаний", error);
  }
}

let predictionDeck = loadPredictionDeck();

function takeNextPrediction() {
  if (predictionDeck.remaining.length === 0) {
    predictionDeck = createPredictionDeck(predictionDeck.lastCardId);
  }

  const cardId = predictionDeck.remaining.shift();
  predictionDeck.lastCardId = cardId;
  savePredictionDeck(predictionDeck);
  return { cardId, ...predictionCards.get(cardId) };
}

function renderPredictionText(text) {
  const content = document.createDocumentFragment();
  for (const part of text.split(/(<br\s*\/?>)/gi)) {
    if (/^<br\s*\/?>$/i.test(part)) {
      content.append(document.createElement("br"));
    } else if (part) {
      content.append(document.createTextNode(part));
    }
  }
  predictionCardText.replaceChildren(content);
}

function renderPrediction({ cardId, text }) {
  predictionCardImage.src = `${import.meta.env.BASE_URL}assets/card/${cardId}.webp`;
  renderPredictionText(text);
}

function preloadPredictionCardImages() {
  if (predictionCardsPreloadPromise) {
    return predictionCardsPreloadPromise;
  }

  predictionCardsPreloadPromise = Promise.all(
    predictionCardIds.map((cardId) => {
      const url = `${import.meta.env.BASE_URL}assets/card/${cardId}.webp`;
      return new Promise((resolve) => {
        const image = new Image();
        loadingManager.itemStart(url);
        image.onload = () => {
          loadingManager.itemEnd(url);
          resolve();
        };
        image.onerror = () => {
          loadingManager.itemError(url);
          loadingManager.itemEnd(url);
          resolve();
        };
        image.src = url;
      });
    }),
  );

  return predictionCardsPreloadPromise;
}

let sceneAssetsPreloadPromise = null;

function preloadSceneAssets() {
  if (sceneAssetsPreloadPromise) {
    return sceneAssetsPreloadPromise;
  }

  sceneAssetsPreloadPromise = Promise.all(
    [...sceneAssetImages].map((image) => {
      const url = `${import.meta.env.BASE_URL}${image.dataset.src}`;
      return new Promise((resolve) => {
        loadingManager.itemStart(url);
        image.addEventListener("load", async () => {
          if (typeof image.decode === "function") {
            await image.decode().catch(() => {});
          }
          loadingManager.itemEnd(url);
          resolve();
        }, { once: true });
        image.addEventListener("error", () => {
          loadingManager.itemError(url);
          loadingManager.itemEnd(url);
          resolve();
        }, { once: true });
        image.src = url;
      });
    }),
  );

  return sceneAssetsPreloadPromise;
}

function closePredictionModal() {
  predictionModal.hidden = true;
}

predictionModal.addEventListener("click", (event) => {
  if (event.target === predictionModal) {
    closePredictionModal();
  }
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !predictionModal.hidden) {
    closePredictionModal();
  }
});

function runPrediction() {
  const burstStarted = modelPhysics?.applyPredictionBurst() === true;
  if (burstStarted) {
    renderPrediction(takeNextPrediction());
    closePredictionModal();
    predictionButton.disabled = true;
    window.setTimeout(() => {
      predictionButton.disabled = false;
    }, appConfig.physics.predictionBurst.cooldownMs);
    window.setTimeout(() => {
      predictionModal.hidden = false;
    }, 1000);
  }
  predictionButton.blur();
}

predictionButton.addEventListener("click", runPrediction);
predictionMoreButton.addEventListener("click", runPrediction);

if (import.meta.env.DEV && !loadingScreenPreviewMode) {
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
let loadingProgress = 0;
let modelLoadPromise = null;
const minimumLoadingScreenDuration = 500;
const clock = new THREE.Clock();
const frameInterval = 1000 / Math.max(appConfig.renderer.maxFps, 1);
let lastFrameTime = 0;

function setLoadingProgress(value, { allowDecrease = false } = {}) {
  const roundedValue = Math.round(value);
  const nextValue = Math.min(
    100,
    Math.max(allowDecrease ? 0 : loadingProgress, roundedValue),
  );
  const loadedSegments = Math.floor(nextValue / 10);
  loadingProgress = nextValue;
  loadingBarElement.style.setProperty(
    "--loading-fill",
    `${loadedSegments * 9.5}%`,
  );
  loadingBarElement.setAttribute("aria-valuenow", String(nextValue));
  loadingProgressElement.textContent = `${nextValue}%`;
}

function setLoadingError() {
  loadingProgressElement.textContent = "ОШИБКА ЗАГРУЗКИ";
  loadingLabelElement.textContent = "Ошибка загрузки";
  loadingLabelElement.classList.add("is-error");
  loadingBarElement.classList.add("is-error");
  loadingBarElement.removeAttribute("role");
  loadingBarElement.removeAttribute("aria-valuenow");
}

function wait(duration) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, duration);
  });
}

function showLoadingScreen() {
  prepareLoadingAssets();
  loadingScreenElement.classList.remove("is-hidden");
  loadingScreenElement.setAttribute("aria-hidden", "false");
}

function prepareLoadingAssets() {
  if (!loadingLogoElement.hasAttribute("src")) {
    loadingLogoElement.src = loadingLogoElement.dataset.src;
  }

  loadingScreenElement.style.setProperty(
    "--loading-background-image",
    'url("/assets/loading-backhround.webp")',
  );
  loadingBarElement.style.setProperty(
    "--loading-bar-image",
    'url("/assets/load-bar.png")',
  );
}

function hideLoadingScreen() {
  loadingScreenElement.classList.add("is-hidden");
  loadingScreenElement.setAttribute("aria-hidden", "true");
}

const loadingManager = new THREE.LoadingManager();
loadingManager.onStart = () => setLoadingProgress(1);
loadingManager.onProgress = (_url, loaded, total) => {
  if (total > 0) {
    setLoadingProgress((loaded / total) * 90);
  }
};
loadingManager.onLoad = () => setLoadingProgress(90);
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
  const [{ DRACOLoader }, { GLTFLoader }, { createModelPhysics }] =
    await Promise.all([
      import("three/addons/loaders/DRACOLoader.js"),
      import("three/addons/loaders/GLTFLoader.js"),
      import("./modelPhysics.js"),
    ]);
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
  setLoadingProgress(95);

  if (appConfig.physics.enabled) {
    try {
      modelPhysics = await createModelPhysics({
        root: model,
        camera,
        canvas: renderer.domElement,
        config: appConfig.physics,
      });
    } catch (error) {
      console.error("Не удалось подготовить физику модели", error);
    }
  }

  if (failedAssetUrl) {
    console.warn("Модель загружена, но часть ресурсов недоступна", failedAssetUrl);
  }

  setLoadingProgress(100);
}

window.addEventListener("resize", resize, { passive: true });
window.addEventListener("pagehide", () => {
  renderer.setAnimationLoop(null);
  modelPhysics?.dispose();
  parallax.dispose();
}, { once: true });
resize();
renderer.setAnimationLoop(animate);

function getModelLoadPromise() {
  if (!modelLoadPromise) {
    modelLoadPromise = loadScene().then(
      () => ({ ok: true }),
      (error) => {
        console.error("Не удалось загрузить Winline GLB", error);
        setLoadingError();
        return { ok: false };
      },
    );
  }

  return modelLoadPromise;
}

let loadingTransitionStarted = false;

startButton.addEventListener("click", async () => {
  if (loadingTransitionStarted) {
    return;
  }

  loadingTransitionStarted = true;
  startButton.disabled = true;
  const loadingScreenShownAt = performance.now();

  showLoadingScreen();
  startScreenElement.classList.add("is-hidden");
  startButton.blur();

  const [result] = await Promise.all([
    getModelLoadPromise(),
    preloadPredictionCardImages(),
    preloadSceneAssets(),
  ]);
  if (!result.ok) {
    return;
  }

  const elapsed = performance.now() - loadingScreenShownAt;
  const remainingDuration = Math.max(
    0,
    minimumLoadingScreenDuration - elapsed,
  );
  if (remainingDuration > 0) {
    await wait(remainingDuration);
  }

  hideLoadingScreen();
  sceneActionsElement.classList.remove("is-hidden");
});
