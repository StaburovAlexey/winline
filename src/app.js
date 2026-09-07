import * as THREE from "three";
import Stats from "stats.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { appConfig } from "./config.js";
import cardData from "./card.json";
import { createParallaxController } from "./parallax.js";
import { createAudioController } from "./audio.js";
import { createStartScreenMotion } from "./start-screen-motion.js";
import { publicAsset } from "./publicAsset.js";
import "modern-normalize";
import "./style.css";

const sceneElement = document.querySelector("#scene");
const sceneAssetImages = document.querySelectorAll(
  "#scene-environment img[data-src], #scene-decorations img[data-src], #scene-foreground-decorations img[data-src]",
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
  || !(shakeTestButton instanceof HTMLButtonElement)
  || !(motionPermissionStatusElement instanceof HTMLElement)
) {
  throw new Error("Scene root elements are missing");
}

const startScreenMotion = createStartScreenMotion({
  root: startScreenElement,
  targets: [...startScreenElement.querySelectorAll(".start-img")],
});

const audio = createAudioController({
  collisionSound: appConfig.physics.collisionSound,
  onProgress: reportAudioLoadingProgress,
});

for (const button of document.querySelectorAll("button")) {
  if (button === startButton) {
    continue;
  }
  button.addEventListener("click", () => {
    audio.playButton();
  });
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
let sphereOverlay = null;
let sphereReflection = null;
const sphereOverlayParentQuaternion = new THREE.Quaternion();

const parallax = createParallaxController({
  camera,
  target: controls.target,
  canvas: renderer.domElement,
  backgroundElement: document.body,
  permissionStatusElement: motionPermissionStatusElement,
  config: appConfig.parallax,
  onShake: ({ strength, direction, coherence }) => {
    modelPhysics?.applyShake({ strength, direction, coherence });
  },
  onShakeEnd: handleShakeEnd,
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
  predictionCardImage.src = publicAsset(`assets/card/${cardId}.webp`);
  renderPredictionText(text);
}

function preloadPredictionCardImages() {
  if (predictionCardsPreloadPromise) {
    return predictionCardsPreloadPromise;
  }

  let completedCards = 0;
  predictionCardsPreloadPromise = Promise.all(
    predictionCardIds.map((cardId) => {
      const url = publicAsset(`assets/card/${cardId}.webp`);
      return new Promise((resolve) => {
        const image = new Image();
        loadingManager.itemStart(url);
        image.onload = () => {
          loadingManager.itemEnd(url);
          completedCards += 1;
          setLoadingTaskProgress(
            "predictionAssets",
            completedCards / predictionCardIds.length,
          );
          resolve();
        };
        image.onerror = () => {
          loadingManager.itemError(url);
          loadingManager.itemEnd(url);
          completedCards += 1;
          setLoadingTaskProgress(
            "predictionAssets",
            completedCards / predictionCardIds.length,
          );
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

  let completedAssets = 0;
  sceneAssetsPreloadPromise = Promise.all(
    [...sceneAssetImages].map((image) => {
      const url = publicAsset(image.dataset.src);
      return new Promise((resolve) => {
        loadingManager.itemStart(url);
        const markComplete = () => {
          completedAssets += 1;
          setLoadingTaskProgress(
            "sceneAssets",
            completedAssets / sceneAssetImages.length,
          );
        };
        image.addEventListener("load", async () => {
          if (typeof image.decode === "function") {
            await image.decode().catch(() => {});
          }
          loadingManager.itemEnd(url);
          markComplete();
          resolve();
        }, { once: true });
        image.addEventListener("error", () => {
          loadingManager.itemError(url);
          loadingManager.itemEnd(url);
          markComplete();
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

let predictionRevealPending = false;

function handleShakeEnd({ duration = 0 } = {}) {
  const sceneIsReady =
    !sceneActionsElement.classList.contains("is-hidden");
  const requiredDuration = Math.max(
    appConfig.parallax.shake.predictionDurationSeconds ?? 2,
    0,
  );
  if (
    !sceneIsReady
    || duration < requiredDuration
    || predictionRevealPending
    || !predictionModal.hidden
  ) {
    return;
  }

  renderPrediction(takeNextPrediction());
  predictionModal.hidden = false;
  audio.playPrediction();
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
  if (predictionRevealPending) {
    predictionButton.blur();
    return;
  }

  const burstStarted = modelPhysics?.applyPredictionBurst() === true;
  renderPrediction(takeNextPrediction());

  if (!burstStarted) {
    // Физический burst — необязательный визуальный эффект. Если Rapier ещё
    // занят или недоступен на устройстве, карточка всё равно должна открыться.
    predictionModal.hidden = false;
    audio.playPrediction();
  } else {
    closePredictionModal();
    predictionRevealPending = true;
    predictionButton.disabled = true;
    window.setTimeout(() => {
      predictionButton.disabled = false;
    }, appConfig.physics.predictionBurst.cooldownMs);
    window.setTimeout(() => {
      predictionModal.hidden = false;
      predictionRevealPending = false;
      audio.playPrediction();
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
let loadingVisualProgress = 0;
let modelLoadPromise = null;
const loadingProgressTasks = new Map([
  ["modelDownload", { weight: 0.85, value: 0 }],
  ["modelPreparation", { weight: 0.08, value: 0 }],
  ["sceneAssets", { weight: 0.04, value: 0 }],
  ["predictionAssets", { weight: 0.01, value: 0 }],
  ["audio", { weight: 0.02, value: 0 }],
]);
const audioLoadingProgress = new Map();
const minimumLoadingScreenDuration = 500;
const timer = new THREE.Timer();
timer.connect(document);
const frameInterval = 1000 / Math.max(appConfig.renderer.maxFps, 1);
let lastFrameTime = 0;

function setLoadingProgress(value, { allowDecrease = false } = {}) {
  const visualProgress = Math.min(
    100,
    Math.max(allowDecrease ? 0 : loadingVisualProgress, value),
  );
  const roundedValue = Math.round(value);
  const nextValue = Math.min(
    100,
    Math.max(allowDecrease ? 0 : loadingProgress, roundedValue),
  );
  loadingProgress = nextValue;
  loadingVisualProgress = visualProgress;
  loadingBarElement.style.setProperty(
    "--loading-fill",
    `${visualProgress * 0.95}%`,
  );
  loadingBarElement.setAttribute("aria-valuenow", String(nextValue));
  loadingProgressElement.textContent = `${nextValue}%`;
}

function setLoadingTaskProgress(taskName, value) {
  const task = loadingProgressTasks.get(taskName);
  if (!task) {
    return;
  }

  task.value = Math.min(Math.max(value, 0), 1);
  let aggregateProgress = 0;
  for (const { weight, value: taskValue } of loadingProgressTasks.values()) {
    aggregateProgress += weight * taskValue;
  }
  setLoadingProgress(aggregateProgress * 100);
}

function reportAudioLoadingProgress(
  effectName,
  loaded,
  total,
  resourceCount = 1,
) {
  const resourceProgress = total > 0
    ? loaded / total
    : (loaded > 0 ? 1 : 0);
  audioLoadingProgress.set(effectName, Math.min(Math.max(resourceProgress, 0), 1));

  const expectedResources = Math.max(resourceCount, audioLoadingProgress.size, 1);
  const loadedResources = [...audioLoadingProgress.values()].reduce(
    (sum, progress) => sum + progress,
    0,
  );
  setLoadingTaskProgress("audio", loadedResources / expectedResources);
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
    loadingLogoElement.src = publicAsset(loadingLogoElement.dataset.src);
  }

  loadingScreenElement.style.setProperty(
    "--loading-background-image",
    `url("${publicAsset("assets/loading-backhround.png")}")`,
  );
  loadingBarElement.style.setProperty(
    "--loading-bar-image",
    `url("${publicAsset("assets/load-bar.png")}")`,
  );
}

function hideLoadingScreen() {
  loadingScreenElement.classList.add("is-hidden");
  loadingScreenElement.setAttribute("aria-hidden", "true");
}

const loadingManager = new THREE.LoadingManager();
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
  const bakedMap = keepTransparent
    ? source.emissiveMap ?? source.map
    : source.map ?? source.emissiveMap;
  const alphaMap = keepTransparent ? source.map : source.alphaMap;

  if (bakedMap) {
    configureTexture(bakedMap);
  }
  if (alphaMap && alphaMap !== bakedMap) {
    configureTexture(alphaMap);
  }

  const material = new THREE.MeshBasicMaterial({
    alphaMap,
    alphaTest: keepTransparent ? source.alphaTest : 0,
    blending: keepTransparent ? THREE.AdditiveBlending : source.blending,
    color: bakedMap ? 0xffffff : source.color,
    depthTest: true,
    depthWrite: !keepTransparent,
    fog: source.fog,
    map: bakedMap,
    opacity: keepTransparent ? source.opacity : 1,
    premultipliedAlpha: source.premultipliedAlpha,
    side: keepTransparent ? THREE.FrontSide : source.side,
    toneMapped: source.toneMapped,
    transparent: keepTransparent,
    vertexColors: source.vertexColors,
  });

  if (keepTransparent) {
    const transparentBrightness = appConfig.materials.transparentBrightness ?? 1;
    const transparentWhiteness = THREE.MathUtils.clamp(
      appConfig.materials.transparentWhiteness ?? 0,
      0,
      1,
    );
    const transparentBaseOpacity = THREE.MathUtils.clamp(
      appConfig.materials.transparentBaseOpacity ?? 0,
      0,
      1,
    );
    const transparentHighlightOpacity = THREE.MathUtils.clamp(
      appConfig.materials.transparentHighlightOpacity ?? 1,
      0,
      1,
    );
    material.color.setScalar(transparentBrightness);
    material.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <map_fragment>",
          `#include <map_fragment>
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0), ${transparentWhiteness});`,
        )
        .replace(
          "#include <alphamap_fragment>",
          `#ifdef USE_ALPHAMAP
          diffuseColor.a *= max(
            texture2D(alphaMap, vAlphaMapUv).a * ${transparentHighlightOpacity},
            ${transparentBaseOpacity}
          );
          #endif`,
        );
    };
    material.customProgramCacheKey = () =>
      `transparent-alpha-channel:${transparentWhiteness}:${transparentBaseOpacity}:${transparentHighlightOpacity}`;
  }

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

function createSphereBillboard(root, sphereCollider, texture, options) {
  root.updateMatrixWorld(true);
  if (!sphereCollider.geometry.boundingBox) {
    sphereCollider.geometry.computeBoundingBox();
  }

  const rootInverseMatrix = root.matrixWorld.clone().invert();
  const colliderMatrix = new THREE.Matrix4().multiplyMatrices(
    rootInverseMatrix,
    sphereCollider.matrixWorld,
  );
  const bounds = sphereCollider.geometry.boundingBox
    .clone()
    .applyMatrix4(colliderMatrix);
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const referenceSize = Math.max(size.x, size.y);
  center.x += referenceSize * (options.centerXOffsetRatio ?? 0);
  center.y += referenceSize * (options.centerYOffsetRatio ?? 0);
  center.z += referenceSize * (options.depthOffsetRatio ?? 0);
  const visibleWidthRatio = Math.max(options.visibleWidthRatio ?? 1, 0.01);
  const imageAspect = texture.image.width / texture.image.height;
  const planeWidth = Math.max(size.x, size.y) / visibleWidthRatio;
  const geometry = new THREE.PlaneGeometry(planeWidth, planeWidth / imageAspect);
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: options.transparent ?? true,
    depthTest: options.depthTest ?? false,
    depthWrite: false,
    side: THREE.FrontSide,
    toneMapped: options.toneMapped ?? false,
    opacity: options.opacity ?? 1,
  });
  if (options.screenBlend) {
    material.blending = THREE.CustomBlending;
    material.blendEquation = THREE.AddEquation;
    material.blendSrc = THREE.OneMinusDstColorFactor;
    material.blendDst = THREE.OneFactor;
  }
  const overlay = new THREE.Mesh(geometry, material);
  overlay.name = options.name;
  overlay.position.copy(center);
  overlay.renderOrder = options.renderOrder ?? 0;
  overlay.frustumCulled = false;
  root.add(overlay);

  return overlay;
}

function updateSphereOverlayFacing() {
  const parent = sphereOverlay?.parent ?? sphereReflection?.parent;
  if (!parent) {
    return;
  }

  parent.getWorldQuaternion(sphereOverlayParentQuaternion);
  sphereOverlayParentQuaternion.invert();
  for (const billboard of [sphereOverlay, sphereReflection]) {
    billboard?.quaternion
      .copy(sphereOverlayParentQuaternion)
      .multiply(camera.quaternion);
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

function getMobileFixedSizeDistance(
  sphere,
  viewportWidth,
  viewportHeight,
  verticalHalfFov,
) {
  const isCompactMobile =
    viewportWidth <= appConfig.camera.fit.mobileCompactBreakpoint;
  const desiredSizePx = isCompactMobile
    ? appConfig.camera.fit.mobileCompactSizePx
    : appConfig.camera.fit.mobileSizePx;
  if (!Number.isFinite(desiredSizePx) || desiredSizePx <= 0 || viewportHeight <= 0) {
    return null;
  }

  return (
    (sphere.radius * viewportHeight) /
    (desiredSizePx * Math.tan(verticalHalfFov))
  );
}

function alignMobileModelBottom(bounds, viewportHeight) {
  const bottomOffset = appConfig.camera.fit.mobileBottomOffsetPx;
  if (!Number.isFinite(bottomOffset) || viewportHeight <= 0) {
    return;
  }

  camera.updateMatrixWorld(true);
  const corner = new THREE.Vector3();
  let screenBottom = -Infinity;

  for (const x of [bounds.min.x, bounds.max.x]) {
    for (const y of [bounds.min.y, bounds.max.y]) {
      for (const z of [bounds.min.z, bounds.max.z]) {
        corner.set(x, y, z).project(camera);
        screenBottom = Math.max(
          screenBottom,
          (1 - corner.y) * 0.5 * viewportHeight,
        );
      }
    }
  }

  if (!Number.isFinite(screenBottom)) {
    return;
  }

  const desiredBottom = viewportHeight - Math.max(bottomOffset, 0);
  const pixelOffset = desiredBottom - screenBottom;
  const boundsCenter = bounds.getCenter(new THREE.Vector3());
  const cameraDistance = camera.position.distanceTo(boundsCenter);
  const verticalHalfFov = THREE.MathUtils.degToRad(camera.fov * 0.5);
  const worldUnitsPerPixel =
    (2 * cameraDistance * Math.tan(verticalHalfFov)) / viewportHeight;
  const cameraUp = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
  const worldOffset = pixelOffset * worldUnitsPerPixel;

  camera.position.addScaledVector(cameraUp, worldOffset);
  controls.target.addScaledVector(cameraUp, worldOffset);
  camera.lookAt(controls.target);
}

function applyFitCamera(viewportWidth, viewportHeight) {
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
  const mobileDistance = getMobileFixedSizeDistance(
    sphere,
    viewportWidth,
    viewportHeight,
    verticalHalfFov,
  );
  const distance = isMobile
    ? (mobileDistance ?? getHorizontalFitDistance(model, center, horizontalHalfFov))
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

  if (isMobile) {
    alignMobileModelBottom(fitBox, viewportHeight);
  }
}

function applyManualCamera(viewportWidth) {
  const profile = viewportWidth < appConfig.camera.breakpoint
    ? appConfig.camera.manual.mobile
    : appConfig.camera.manual.desktop;

  camera.position.set(profile.position.x, profile.position.y, profile.position.z);
  controls.target.set(profile.target.x, profile.target.y, profile.target.z);
  camera.lookAt(controls.target);
}

function updateCamera(viewportWidth, viewportHeight) {
  camera.fov = appConfig.camera.fov;
  camera.near = appConfig.camera.near;
  camera.far = appConfig.camera.far;
  camera.updateProjectionMatrix();

  if (appConfig.camera.mode === "manual") {
    applyManualCamera(viewportWidth);
  } else if (model) {
    applyFitCamera(viewportWidth, viewportHeight);
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
  updateCamera(width, height);
}

function animate(time) {
  const elapsed = time - lastFrameTime;
  if (elapsed < frameInterval) {
    return;
  }

  lastFrameTime = time - (elapsed % frameInterval);
  stats?.begin();
  timer.update(time);
  const deltaTime = timer.getDelta();
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
  updateSphereOverlayFacing();
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
    gltf = await loader.loadAsync(
      appConfig.model.url,
      (event) => {
        if (event.lengthComputable && event.total > 0) {
          setLoadingTaskProgress(
            "modelDownload",
            event.loaded / event.total,
          );
        }
      },
    );
  } finally {
    dracoLoader.dispose();
  }
  setLoadingTaskProgress("modelDownload", 1);
  setLoadingTaskProgress("modelPreparation", 0.2);

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

  gltf.scene.traverse((node) => {
    if (
      node.isMesh
      && matchesNode(
        node,
        appConfig.materials.transparentMeshNames,
        appConfig.materials.transparentGeometryNames,
      )
    ) {
      node.visible = false;
    }
  });

  configureModelMaterials(gltf.scene);
  const textureLoader = new THREE.TextureLoader(loadingManager);
  const [sphereOverlayTexture, sphereReflectionTexture] = await Promise.all([
    textureLoader.loadAsync(appConfig.model.sphereOverlayUrl),
    textureLoader.loadAsync(appConfig.model.sphereReflectionUrl),
  ]);
  setLoadingTaskProgress("modelPreparation", 0.55);
  configureTexture(sphereOverlayTexture);
  configureTexture(sphereReflectionTexture);
  sphereOverlay = createSphereBillboard(
    gltf.scene,
    sphereCollider,
    sphereOverlayTexture,
    {
      name: "Sphere_overlay",
      visibleWidthRatio: appConfig.model.sphereOverlayVisibleWidthRatio,
      centerXOffsetRatio: appConfig.model.sphereOverlayCenterXOffsetRatio,
      centerYOffsetRatio: appConfig.model.sphereOverlayCenterYOffsetRatio,
      renderOrder: 100,
    },
  );
  sphereReflection = createSphereBillboard(
    gltf.scene,
    sphereCollider,
    sphereReflectionTexture,
    {
      name: "Sphere_reflection",
      visibleWidthRatio: appConfig.model.sphereReflectionVisibleWidthRatio,
      centerXOffsetRatio: appConfig.model.sphereReflectionCenterXOffsetRatio,
      centerYOffsetRatio: appConfig.model.sphereReflectionCenterYOffsetRatio,
      depthOffsetRatio: appConfig.model.sphereReflectionDepthOffsetRatio,
      depthTest: true,
      opacity: appConfig.model.sphereReflectionOpacity,
      transparent: true,
      toneMapped: true,
      renderOrder: -100,
    },
  );
  applyModelConfig(gltf.scene);
  scene.add(gltf.scene);
  model = gltf.scene;
  resize();
  setLoadingTaskProgress("modelPreparation", 0.7);

  if (appConfig.physics.enabled) {
    try {
      modelPhysics = await createModelPhysics({
        root: model,
        camera,
        canvas: renderer.domElement,
        config: appConfig.physics,
        onBodyCollision: ({ type, impactSpeed }) => {
          audio.playCollision({ type, impactSpeed });
        },
      });
    } catch (error) {
      console.error("Не удалось подготовить физику модели", error);
    }
  }

  if (failedAssetUrl) {
    console.warn("Модель загружена, но часть ресурсов недоступна", failedAssetUrl);
  }

  setLoadingTaskProgress("modelPreparation", 1);
}

window.addEventListener("resize", resize, { passive: true });
window.addEventListener("pagehide", () => {
  renderer.setAnimationLoop(null);
  modelPhysics?.dispose();
  parallax.dispose();
  startScreenMotion.dispose();
  audio.dispose();
  sphereOverlay?.geometry.dispose();
  sphereOverlay?.material.map?.dispose();
  sphereOverlay?.material.dispose();
  sphereReflection?.geometry.dispose();
  sphereReflection?.material.map?.dispose();
  sphereReflection?.material.dispose();
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
  const audioReadyPromise = audio.enable().then(() => {
    setLoadingTaskProgress("audio", 1);
  });
  audio.playButton();
  void parallax.activateSensors().catch((error) => {
    console.error("Не удалось включить датчики движения", error);
  });
  const loadingScreenShownAt = performance.now();

  showLoadingScreen();
  startScreenElement.classList.add("is-hidden");
  startButton.blur();

  const [result] = await Promise.all([
    getModelLoadPromise(),
    preloadPredictionCardImages(),
    preloadSceneAssets(),
    audioReadyPromise,
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
