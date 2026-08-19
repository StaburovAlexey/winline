import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { appConfig } from "./config.js";
import { createModelPhysics } from "./modelPhysics.js";
import "./style.css";

const sceneElement = document.querySelector("#scene");
const statusElement = document.querySelector("#status");

if (!(sceneElement instanceof HTMLElement) || !(statusElement instanceof HTMLElement)) {
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
  antialias: true,
  powerPreference: "high-performance",
});

renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setClearColor(0x000000, 0);
renderer.setPixelRatio(
  Math.min(window.devicePixelRatio, appConfig.renderer.maxPixelRatio),
);
sceneElement.append(renderer.domElement);

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
let failedAssetUrl = null;
const clock = new THREE.Clock();

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

function getMaterials(node) {
  return Array.isArray(node.material) ? node.material : [node.material];
}

function configureTexture(texture) {
  if (!texture || (!texture.image && !texture.source?.data)) {
    return;
  }

  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  texture.needsUpdate = true;
}

function configureModelMaterials(root) {
  const allMaterials = new Set();
  const transparentMaterials = new Set();

  root.traverse((node) => {
    if (!node.isMesh) {
      return;
    }

    const keepTransparent = matchesNode(
      node,
      appConfig.materials.transparentMeshNames,
      appConfig.materials.transparentGeometryNames,
    );

    for (const material of getMaterials(node)) {
      if (!material) {
        continue;
      }

      allMaterials.add(material);
      if (keepTransparent) {
        transparentMaterials.add(material);
      }
    }
  });

  for (const material of allMaterials) {
    const keepTransparent = transparentMaterials.has(material);

    material.transparent = keepTransparent;
    material.depthTest = true;
    material.depthWrite = !keepTransparent;

    if (!keepTransparent) {
      material.opacity = 1;
      material.alphaTest = 0;
    }

    if (appConfig.materials.useBakedEmission && "emissive" in material) {
      if (material.map) {
        configureTexture(material.map);
        material.emissiveMap = material.map;
        material.emissive.set(0xffffff);
      } else {
        material.emissiveMap = null;
        material.emissive.copy(material.color);
      }

      material.emissiveIntensity = appConfig.materials.emissiveIntensity;
    }

    material.needsUpdate = true;
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
}

function resize() {
  const width = sceneElement.clientWidth || window.innerWidth;
  const height = sceneElement.clientHeight || window.innerHeight;

  camera.aspect = width / Math.max(height, 1);
  renderer.setSize(width, height, false);
  updateCamera(width);
}

function animate() {
  requestAnimationFrame(animate);
  modelPhysics?.update(clock.getDelta());
  controls.update();
  renderer.render(scene, camera);
}

async function loadScene() {
  const loader = new GLTFLoader(loadingManager);
  const gltf = await loader.loadAsync(appConfig.model.url);

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
window.addEventListener("pagehide", () => modelPhysics?.dispose(), { once: true });
resize();
animate();

loadScene().catch((error) => {
  console.error("Не удалось загрузить Winline GLB", error);
  setStatus("Не удалось загрузить 3D-модель", "error");
});
