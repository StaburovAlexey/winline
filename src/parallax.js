import * as THREE from "three";

const FINE_POINTER_QUERY = "(hover: hover) and (pointer: fine)";
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const MIN_CAMERA_DISTANCE = 0.0001;

function clampInput(value) {
  return THREE.MathUtils.clamp(value, -1, 1);
}

function applyDeadZone(value, deadZone) {
  const absoluteValue = Math.abs(value);
  const safeDeadZone = THREE.MathUtils.clamp(deadZone, 0, 0.99);

  if (absoluteValue <= safeDeadZone) {
    return 0;
  }

  return Math.sign(value) * (absoluteValue - safeDeadZone) / (1 - safeDeadZone);
}

function getShortestAngleDelta(value, baseline) {
  return ((value - baseline + 540) % 360) - 180;
}

function getScreenOrientationAngle() {
  if (Number.isFinite(window.screen.orientation?.angle)) {
    return window.screen.orientation.angle;
  }

  return Number.isFinite(window.orientation) ? window.orientation : 0;
}

export function createParallaxController({
  camera,
  target,
  canvas,
  backgroundElement,
  permissionButton,
  permissionStatusElement,
  config,
}) {
  const enabled = config?.enabled !== false;
  const finePointer = window.matchMedia(FINE_POINTER_QUERY);
  const reducedMotion = window.matchMedia(REDUCED_MOTION_QUERY);
  const eventController = new AbortController();
  const eventOptions = { signal: eventController.signal };
  const passiveEventOptions = { passive: true, signal: eventController.signal };
  const input = new THREE.Vector2();
  const smoothedInput = new THREE.Vector2();
  const baseCameraPosition = new THREE.Vector3();
  const baseTarget = new THREE.Vector3();
  const cameraRight = new THREE.Vector3(1, 0, 0);
  const cameraUp = new THREE.Vector3(0, 1, 0);
  const cameraOffset = new THREE.Vector3();
  let baseDistance = 1;
  let hasBasePose = false;
  let orientationBaseline = null;
  let orientationListening = false;
  let permissionState = "idle";
  let motionOptIn = false;
  let disposed = false;

  function isDesktopMode() {
    return finePointer.matches;
  }

  function isActive() {
    return enabled && (!reducedMotion.matches || motionOptIn);
  }

  function getProfile() {
    return isDesktopMode() ? config.desktop : config.mobile;
  }

  function setInput(x, y) {
    const deadZone = config.deadZone ?? 0;
    input.set(
      applyDeadZone(clampInput(x), deadZone),
      applyDeadZone(clampInput(y), deadZone),
    );
  }

  function hidePermissionUi() {
    permissionButton.hidden = true;
    permissionButton.disabled = false;
    permissionButton.textContent = "Включить эффект движения";
    permissionStatusElement.hidden = true;
    permissionStatusElement.textContent = "";
  }

  function showPermissionButton(requesting = false) {
    permissionButton.hidden = false;
    permissionButton.disabled = requesting;
    permissionButton.textContent = requesting
      ? "Запрашиваем разрешение…"
      : "Гироскоп";
    permissionStatusElement.hidden = true;
    permissionStatusElement.textContent = "";
  }

  function showPermissionError(message) {
    permissionButton.hidden = true;
    permissionButton.disabled = false;
    permissionStatusElement.textContent = message;
    permissionStatusElement.hidden = false;
  }

  function resetInput(immediate = false) {
    input.set(0, 0);
    orientationBaseline = null;

    if (immediate) {
      smoothedInput.set(0, 0);
      applyPose();
    }
  }

  function applyPose() {
    if (!hasBasePose || disposed) {
      return;
    }

    const profile = getProfile();
    cameraOffset
      .copy(cameraRight)
      .multiplyScalar(smoothedInput.x * baseDistance * profile.cameraX)
      .addScaledVector(
        cameraUp,
        smoothedInput.y * baseDistance * profile.cameraY,
      );

    camera.position.copy(baseCameraPosition).add(cameraOffset);
    camera.lookAt(baseTarget);
    camera.updateMatrixWorld();

    backgroundElement.style.setProperty(
      "--background-parallax-x",
      `${-smoothedInput.x * profile.backgroundX}px`,
    );
    backgroundElement.style.setProperty(
      "--background-parallax-y",
      `${smoothedInput.y * profile.backgroundY}px`,
    );
  }

  function handlePointerMove(event) {
    if (!isActive() || !isDesktopMode()) {
      return;
    }

    const bounds = canvas.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) {
      return;
    }

    const x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
    const y = -(((event.clientY - bounds.top) / bounds.height) * 2 - 1);
    setInput(x, y);
  }

  function handleDeviceOrientation(event) {
    if (
      !isActive()
      || isDesktopMode()
      || !Number.isFinite(event.beta)
      || !Number.isFinite(event.gamma)
    ) {
      return;
    }

    if (!orientationBaseline) {
      orientationBaseline = { beta: event.beta, gamma: event.gamma };
      setInput(0, 0);
      return;
    }

    const tiltRange = Math.max(config.mobile.tiltRangeDegrees, 1);
    const deviceX = getShortestAngleDelta(
      event.gamma,
      orientationBaseline.gamma,
    ) / tiltRange;
    const deviceY = -getShortestAngleDelta(
      event.beta,
      orientationBaseline.beta,
    ) / tiltRange;
    const angle = THREE.MathUtils.degToRad(getScreenOrientationAngle());
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    const screenX = deviceX * cosine - deviceY * sine;
    const screenY = deviceX * sine + deviceY * cosine;

    setInput(screenX, screenY);
  }

  function enableOrientation() {
    if (orientationListening || disposed) {
      return;
    }

    if (motionOptIn) {
      backgroundElement.classList.add("is-motion-parallax-enabled");
    }

    orientationListening = true;
    permissionState = "granted";
    hidePermissionUi();
    window.addEventListener(
      "deviceorientation",
      handleDeviceOrientation,
      passiveEventOptions,
    );
  }

  function configureOrientation() {
    if (!enabled || isDesktopMode()) {
      hidePermissionUi();
      return;
    }

    if (orientationListening) {
      if (reducedMotion.matches && !motionOptIn) {
        showPermissionButton();
      } else {
        hidePermissionUi();
      }
      return;
    }

    const DeviceOrientation = window.DeviceOrientationEvent;
    if (typeof DeviceOrientation === "undefined") {
      permissionState = "unsupported";
      showPermissionError("Гироскоп недоступен в этом браузере.");
      return;
    }

    if (typeof DeviceOrientation.requestPermission === "function") {
      if (permissionState === "requesting") {
        showPermissionButton(true);
      } else if (permissionState === "denied") {
        showPermissionError(
          "Доступ к движению отклонён. Разрешите его в настройках Safari и перезагрузите страницу.",
        );
      } else {
        showPermissionButton();
      }
      return;
    }

    if (reducedMotion.matches && !motionOptIn) {
      showPermissionButton();
    } else {
      enableOrientation();
    }
  }

  function requestOrientationPermission() {
    if (
      !enabled
      || isDesktopMode()
      || permissionState === "requesting"
      || permissionState === "granted"
    ) {
      return;
    }

    const DeviceOrientation = window.DeviceOrientationEvent;
    if (typeof DeviceOrientation === "undefined") {
      permissionState = "unsupported";
      showPermissionError("Гироскоп недоступен в этом браузере.");
      return;
    }

    if (typeof DeviceOrientation.requestPermission !== "function") {
      enableOrientation();
      return;
    }

    if (!window.isSecureContext) {
      permissionState = "denied";
      showPermissionError(
        "Для гироскопа нужно открыть страницу через защищённое HTTPS-соединение.",
      );
      return;
    }

    permissionState = "requesting";
    showPermissionButton(true);
    DeviceOrientation.requestPermission()
      .then((permission) => {
        if (permission === "granted") {
          enableOrientation();
        } else {
          permissionState = "denied";
          configureOrientation();
        }
      })
      .catch(() => {
        permissionState = "denied";
        configureOrientation();
      });
  }

  function handlePermissionButtonClick() {
    motionOptIn = true;

    if (orientationListening) {
      backgroundElement.classList.add("is-motion-parallax-enabled");
      hidePermissionUi();
      return;
    }

    requestOrientationPermission();
  }

  function handleInputModeChange() {
    resetInput(true);
    configureOrientation();
  }

  function handleMotionPreferenceChange() {
    resetInput(true);
    configureOrientation();
  }

  function handleScreenOrientationChange() {
    resetInput(true);
  }

  function handleVisibilityChange() {
    if (document.hidden) {
      resetInput(true);
    } else if (!isDesktopMode()) {
      orientationBaseline = null;
    }
  }

  canvas.addEventListener("pointermove", handlePointerMove, passiveEventOptions);
  canvas.addEventListener("pointerleave", () => resetInput(), eventOptions);
  permissionButton.addEventListener(
    "click",
    handlePermissionButtonClick,
    eventOptions,
  );
  window.addEventListener("blur", () => resetInput(), eventOptions);
  document.addEventListener(
    "visibilitychange",
    handleVisibilityChange,
    eventOptions,
  );
  finePointer.addEventListener("change", handleInputModeChange, eventOptions);
  reducedMotion.addEventListener(
    "change",
    handleMotionPreferenceChange,
    eventOptions,
  );

  if (window.screen.orientation) {
    window.screen.orientation.addEventListener(
      "change",
      handleScreenOrientationChange,
      eventOptions,
    );
  } else {
    window.addEventListener(
      "orientationchange",
      handleScreenOrientationChange,
      eventOptions,
    );
  }

  configureOrientation();

  return {
    captureBasePose() {
      if (disposed) {
        return;
      }

      baseCameraPosition.copy(camera.position);
      baseTarget.copy(target);
      baseDistance = Math.max(
        baseCameraPosition.distanceTo(baseTarget),
        MIN_CAMERA_DISTANCE,
      );

      camera.lookAt(baseTarget);
      camera.updateMatrixWorld();
      cameraRight.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
      cameraUp.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
      hasBasePose = true;
      applyPose();
    },

    update(deltaTime) {
      if (!hasBasePose || disposed) {
        return;
      }

      if (!isActive()) {
        resetInput(true);
        return;
      }

      const smoothing = Math.max(config.smoothing, 0);
      if (smoothing === 0) {
        smoothedInput.copy(input);
      } else {
        smoothedInput.x = THREE.MathUtils.damp(
          smoothedInput.x,
          input.x,
          smoothing,
          deltaTime,
        );
        smoothedInput.y = THREE.MathUtils.damp(
          smoothedInput.y,
          input.y,
          smoothing,
          deltaTime,
        );
      }
      applyPose();
    },

    dispose() {
      if (disposed) {
        return;
      }

      input.set(0, 0);
      smoothedInput.set(0, 0);
      applyPose();
      disposed = true;
      eventController.abort();
      hidePermissionUi();
      backgroundElement.classList.remove("is-motion-parallax-enabled");
      backgroundElement.style.removeProperty("--background-parallax-x");
      backgroundElement.style.removeProperty("--background-parallax-y");
    },
  };
}
