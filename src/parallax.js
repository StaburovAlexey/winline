import * as THREE from "three";

const FINE_POINTER_QUERY = "(hover: hover) and (pointer: fine)";
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const MIN_CAMERA_DISTANCE = 0.0001;
const DEFAULT_SHAKE_CONFIG = {
  enabled: true,
  accelerationThreshold: 3.5,
  requiredPeaks: 2,
  peakWindowSeconds: 0.45,
  peakCooldownSeconds: 0.35,
  visualDuration: 0.28,
  visualAmplitude: 0.018,
  visualFrequency: 42,
};

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
  onShake,
}) {
  const enabled = config?.enabled !== false;
  const shakeConfig = {
    ...DEFAULT_SHAKE_CONFIG,
    ...(config?.shake ?? {}),
  };
  const shakeCallback = typeof onShake === "function" ? onShake : () => {};
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
  const cameraShakeOffset = new THREE.Vector2();
  const shakeDirection = new THREE.Vector2(1, 0);
  const motionDirection = new THREE.Vector2();
  const motionAcceleration = new THREE.Vector3();
  const motionGravity = new THREE.Vector3();
  let baseDistance = 1;
  let hasBasePose = false;
  let orientationBaseline = null;
  let orientationListening = false;
  let motionListening = false;
  let orientationPermissionState = "idle";
  let motionPermissionState = "idle";
  let motionOptIn = false;
  let hasGravitySample = false;
  let previousShakeMagnitude = 0;
  let lastShakePeakTime = -Infinity;
  let lastShakeTime = -Infinity;
  let shakePeakTimes = [];
  let shakeRemaining = 0;
  let shakeElapsed = 0;
  let shakeStrength = 0;
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

  function resetShakeDetection() {
    hasGravitySample = false;
    motionAcceleration.set(0, 0, 0);
    motionGravity.set(0, 0, 0);
    previousShakeMagnitude = 0;
    lastShakePeakTime = -Infinity;
    lastShakeTime = -Infinity;
    shakePeakTimes = [];
  }

  function clearCameraShake() {
    shakeRemaining = 0;
    shakeElapsed = 0;
    shakeStrength = 0;
    cameraShakeOffset.set(0, 0);
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

  function resetInput(immediate = false, resetShake = false) {
    input.set(0, 0);
    orientationBaseline = null;
    if (resetShake) {
      resetShakeDetection();
    }

    if (immediate) {
      smoothedInput.set(0, 0);
      clearCameraShake();
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
    cameraOffset.addScaledVector(
      cameraRight,
      cameraShakeOffset.x * baseDistance,
    );
    cameraOffset.addScaledVector(
      cameraUp,
      cameraShakeOffset.y * baseDistance,
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

  function updateCameraShake(deltaTime) {
    if (shakeRemaining <= 0) {
      cameraShakeOffset.set(0, 0);
      return;
    }

    const duration = Math.max(shakeConfig.visualDuration, 0.001);
    const safeDeltaTime = Math.max(deltaTime, 0);
    shakeElapsed += safeDeltaTime;
    shakeRemaining -= safeDeltaTime;

    if (shakeRemaining <= 0) {
      clearCameraShake();
      return;
    }

    const envelope = THREE.MathUtils.clamp(shakeRemaining / duration, 0, 1);
    const dampedEnvelope = envelope * envelope;
    const phase = shakeElapsed * shakeConfig.visualFrequency;
    const primaryWave = Math.sin(phase);
    const secondaryWave = Math.sin(phase * 1.67 + 0.8) * 0.42;
    const amplitude = shakeConfig.visualAmplitude * shakeStrength;

    cameraShakeOffset.set(
      (shakeDirection.x * primaryWave - shakeDirection.y * secondaryWave) *
        amplitude *
        dampedEnvelope,
      (shakeDirection.y * primaryWave + shakeDirection.x * secondaryWave) *
        amplitude *
        dampedEnvelope,
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

  function triggerShake(strength, direction) {
    if (!shakeConfig.enabled || !isActive() || isDesktopMode()) {
      return;
    }

    const safeStrength = THREE.MathUtils.clamp(strength, 0.35, 1);
    const directionLength = Math.hypot(direction.x, direction.y);
    if (directionLength > Number.EPSILON) {
      shakeDirection.set(
        direction.x / directionLength,
        direction.y / directionLength,
      );
    } else {
      shakeDirection.set(1, 0);
    }

    shakeStrength = Math.max(shakeStrength, safeStrength);
    shakeRemaining = Math.max(
      shakeRemaining,
      Math.max(shakeConfig.visualDuration, 0.001),
    );
    shakeElapsed = 0;

    try {
      shakeCallback({
        strength: safeStrength,
        direction: {
          x: shakeDirection.x,
          y: shakeDirection.y,
        },
      });
    } catch (error) {
      console.error("Не удалось применить встряску физики", error);
    }
  }

  function handleDeviceMotion(event) {
    if (
      !shakeConfig.enabled
      || !isActive()
      || isDesktopMode()
    ) {
      return;
    }

    const directAcceleration = event.acceleration;
    const gravityAcceleration = event.accelerationIncludingGravity;
    const hasDirectAcceleration =
      Number.isFinite(directAcceleration?.x)
      && Number.isFinite(directAcceleration?.y)
      && Number.isFinite(directAcceleration?.z);
    const hasGravityAcceleration =
      Number.isFinite(gravityAcceleration?.x)
      && Number.isFinite(gravityAcceleration?.y)
      && Number.isFinite(gravityAcceleration?.z);

    if (!hasDirectAcceleration && !hasGravityAcceleration) {
      return;
    }

    const source = hasDirectAcceleration
      ? directAcceleration
      : gravityAcceleration;
    motionAcceleration.set(source.x, source.y, source.z);

    if (hasDirectAcceleration) {
      hasGravitySample = false;
    } else {
      if (!hasGravitySample) {
        motionGravity.copy(motionAcceleration);
        hasGravitySample = true;
      } else {
        motionGravity.lerp(motionAcceleration, 0.08);
      }
      motionAcceleration.sub(motionGravity);
    }

    const magnitude = motionAcceleration.length();
    const now = performance.now();
    const threshold = Math.max(shakeConfig.accelerationThreshold, 0.1);
    const peakWindow = Math.max(shakeConfig.peakWindowSeconds, 0.05);
    const minimumPeakGap = Math.min(0.08, peakWindow * 0.25);

    while (
      shakePeakTimes.length > 0
      && now - shakePeakTimes[0] > peakWindow * 1000
    ) {
      shakePeakTimes.shift();
    }

    const crossedThreshold =
      magnitude >= threshold && previousShakeMagnitude < threshold;
    if (
      crossedThreshold
      && now - lastShakePeakTime >= minimumPeakGap * 1000
    ) {
      shakePeakTimes.push(now);
      lastShakePeakTime = now;
    }
    previousShakeMagnitude = magnitude;

    if (
      shakePeakTimes.length < Math.max(shakeConfig.requiredPeaks, 1)
      || now - lastShakeTime < Math.max(shakeConfig.peakCooldownSeconds, 0) * 1000
    ) {
      return;
    }

    motionDirection.set(
      motionAcceleration.x,
      -motionAcceleration.y,
    );
    const angle = THREE.MathUtils.degToRad(getScreenOrientationAngle());
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    motionDirection.set(
      motionDirection.x * cosine - motionDirection.y * sine,
      motionDirection.x * sine + motionDirection.y * cosine,
    );
    const normalizedStrength = THREE.MathUtils.clamp(
      (magnitude - threshold) / Math.max(threshold * 2, 0.001),
      0,
      1,
    );

    lastShakeTime = now;
    shakePeakTimes = [];
    triggerShake(0.45 + normalizedStrength * 0.55, motionDirection);
  }

  function enableSensors() {
    if (disposed) {
      return;
    }

    const DeviceOrientation = window.DeviceOrientationEvent;
    const DeviceMotion = window.DeviceMotionEvent;

    if (
      !orientationListening
      && typeof DeviceOrientation !== "undefined"
      && orientationPermissionState !== "denied"
    ) {
      orientationListening = true;
      orientationPermissionState = "granted";
      window.addEventListener(
        "deviceorientation",
        handleDeviceOrientation,
        passiveEventOptions,
      );
    }

    if (
      !motionListening
      && typeof DeviceMotion !== "undefined"
      && shakeConfig.enabled
      && motionPermissionState !== "denied"
    ) {
      motionListening = true;
      motionPermissionState = "granted";
      window.addEventListener(
        "devicemotion",
        handleDeviceMotion,
        passiveEventOptions,
      );
    }

    if (orientationListening || motionListening) {
      if (motionOptIn) {
        backgroundElement.classList.add("is-motion-parallax-enabled");
      }
      hidePermissionUi();
    }
  }

  function configureSensors() {
    if (!enabled || isDesktopMode()) {
      hidePermissionUi();
      return;
    }

    if (orientationListening || motionListening) {
      if (reducedMotion.matches && !motionOptIn) {
        showPermissionButton();
      } else {
        hidePermissionUi();
      }
      return;
    }

    const DeviceOrientation = window.DeviceOrientationEvent;
    const DeviceMotion = window.DeviceMotionEvent;
    const hasOrientation = typeof DeviceOrientation !== "undefined";
    const hasMotion = typeof DeviceMotion !== "undefined";

    if (!hasOrientation && !hasMotion) {
      orientationPermissionState = "unsupported";
      motionPermissionState = "unsupported";
      showPermissionError("Датчики движения недоступны в этом браузере.");
      return;
    }

    const requiresPermission =
      (hasOrientation
        && typeof DeviceOrientation.requestPermission === "function"
        && orientationPermissionState !== "granted")
      || (shakeConfig.enabled
        && hasMotion
        && typeof DeviceMotion.requestPermission === "function"
        && motionPermissionState !== "granted");

    if (requiresPermission) {
      if (
        orientationPermissionState === "requesting"
        || motionPermissionState === "requesting"
      ) {
        showPermissionButton(true);
      } else if (
        orientationPermissionState === "denied"
        && motionPermissionState === "denied"
      ) {
        showPermissionError(
          "Доступ к датчикам движения отклонён. Разрешите его в настройках Safari и перезагрузите страницу.",
        );
      } else {
        showPermissionButton();
      }
      return;
    }

    if (reducedMotion.matches && !motionOptIn) {
      showPermissionButton();
    } else {
      enableSensors();
    }
  }

  function requestSensorPermissions() {
    if (
      !enabled
      || isDesktopMode()
      || orientationPermissionState === "requesting"
      || motionPermissionState === "requesting"
      || orientationListening
      || motionListening
    ) {
      return;
    }

    const DeviceOrientation = window.DeviceOrientationEvent;
    const DeviceMotion = window.DeviceMotionEvent;
    const hasOrientation = typeof DeviceOrientation !== "undefined";
    const hasMotion = typeof DeviceMotion !== "undefined";
    const requestOrientation =
      hasOrientation
      && typeof DeviceOrientation.requestPermission === "function";
    const requestMotion =
      shakeConfig.enabled
      && hasMotion
      && typeof DeviceMotion.requestPermission === "function";

    if (!hasOrientation && !hasMotion) {
      showPermissionError("Датчики движения недоступны в этом браузере.");
      return;
    }

    if (!requestOrientation && !requestMotion) {
      enableSensors();
      return;
    }

    if (!window.isSecureContext) {
      showPermissionError(
        "Для датчиков движения нужно открыть страницу через защищённое HTTPS-соединение.",
      );
      return;
    }

    if (requestOrientation) {
      orientationPermissionState = "requesting";
    } else if (hasOrientation) {
      orientationPermissionState = "granted";
    }
    if (requestMotion) {
      motionPermissionState = "requesting";
    } else if (hasMotion) {
      motionPermissionState = "granted";
    }
    showPermissionButton(true);

    const callPermissionRequest = (DeviceEvent) => {
      try {
        return Promise.resolve(DeviceEvent.requestPermission());
      } catch (error) {
        return Promise.reject(error);
      }
    };
    const orientationRequest = requestOrientation
      ? callPermissionRequest(DeviceOrientation)
      : Promise.resolve("granted");
    const motionRequest = requestMotion
      ? callPermissionRequest(DeviceMotion)
      : Promise.resolve("granted");

    Promise.allSettled([orientationRequest, motionRequest]).then(
      ([orientationResult, motionResult]) => {
        if (requestOrientation) {
          orientationPermissionState =
            orientationResult.status === "fulfilled"
            && orientationResult.value === "granted"
              ? "granted"
              : "denied";
        }
        if (requestMotion) {
          motionPermissionState =
            motionResult.status === "fulfilled"
            && motionResult.value === "granted"
              ? "granted"
              : "denied";
        }

        enableSensors();
        configureSensors();
      },
    );
  }

  function handlePermissionButtonClick() {
    motionOptIn = true;

    if (orientationListening || motionListening) {
      backgroundElement.classList.add("is-motion-parallax-enabled");
      hidePermissionUi();
      return;
    }

    requestSensorPermissions();
  }

  function handleInputModeChange() {
    resetInput(true, true);
    configureSensors();
  }

  function handleMotionPreferenceChange() {
    resetInput(true, true);
    configureSensors();
  }

  function handleScreenOrientationChange() {
    resetInput(true, true);
  }

  function handleVisibilityChange() {
    if (document.hidden) {
      resetInput(true, true);
    } else if (!isDesktopMode()) {
      orientationBaseline = null;
      resetShakeDetection();
    }
  }

  canvas.addEventListener("pointermove", handlePointerMove, passiveEventOptions);
  canvas.addEventListener("pointerleave", () => resetInput(), eventOptions);
  permissionButton.addEventListener(
    "click",
    handlePermissionButtonClick,
    eventOptions,
  );
  window.addEventListener(
    "blur",
    () => resetInput(true, true),
    eventOptions,
  );
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

  configureSensors();

  return {
    captureBasePose() {
      if (disposed) {
        return;
      }

      baseCameraPosition.copy(camera.position);
      if (hasBasePose) {
        baseCameraPosition
          .addScaledVector(
            cameraRight,
            -cameraShakeOffset.x * baseDistance,
          )
          .addScaledVector(
            cameraUp,
            -cameraShakeOffset.y * baseDistance,
          );
      }
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
        resetInput(true, true);
        return;
      }

      updateCameraShake(deltaTime);

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
      resetShakeDetection();
      clearCameraShake();
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
