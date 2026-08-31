import * as THREE from "three";

const FINE_POINTER_QUERY = "(hover: hover) and (pointer: fine)";
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const MIN_CAMERA_DISTANCE = 0.0001;
const DEFAULT_SHAKE_CONFIG = {
  enabled: true,
  accelerationThreshold: 3.2,
  hardAccelerationThreshold: 6.5,
  jerkThreshold: 20,
  aggregationWindowSeconds: 0.06,
  minimumDirectionSampleSeconds: 0.02,
  directionLockSeconds: 0.14,
  minimumDirectionCoherence: 0.35,
  cardinalDirections: false,
  invertPlanarDirection: true,
  fixedStrength: 1,
  planarDetectionGain: 1.35,
  zVerticalGain: 1,
  lateralLiftRatio: 0,
  gravityTimeConstantSeconds: 0.22,
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

function isAppleMobileDevice() {
  const userAgent = navigator.userAgent ?? "";
  const platform = navigator.userAgentData?.platform
    ?? navigator.platform
    ?? "";

  return /iPad|iPhone|iPod/.test(userAgent)
    || (platform === "MacIntel" && navigator.maxTouchPoints > 1);
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
  const configuredLayers = config?.layers ?? {};
  const backgroundTopLayerDepth = configuredLayers.backgroundTop ?? 0.2;
  const backgroundBottomLayerDepth = configuredLayers.backgroundBottom ?? 0.55;
  const topLayerDepth = configuredLayers.top ?? 0.45;
  const centerLayerDepth = configuredLayers.center ?? 0.85;
  const bottomLayerDepth = configuredLayers.bottom ?? 1.2;
  const configuredShake = config?.shake ?? {};
  const platformProfiles = configuredShake.platformProfiles ?? {};
  const platformShakeConfig = isAppleMobileDevice()
    ? platformProfiles.ios
    : platformProfiles.android;
  const shakeConfig = {
    ...DEFAULT_SHAKE_CONFIG,
    ...configuredShake,
    ...(platformShakeConfig ?? {}),
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
  const initialShakeDirection = new THREE.Vector2();
  const accumulatedShakeDirection = new THREE.Vector2();
  const motionAcceleration = new THREE.Vector3();
  const motionGravity = new THREE.Vector3();
  const previousMotionAcceleration = new THREE.Vector3();
  let baseDistance = 1;
  let hasBasePose = false;
  let orientationBaseline = null;
  let orientationListening = false;
  let motionListening = false;
  let orientationPermissionState = "idle";
  let motionPermissionState = "idle";
  let motionOptIn = false;
  let hasGravitySample = false;
  let hasPreviousMotionSample = false;
  let motionAccelerationSource = null;
  let lastMotionSampleTime = null;
  let shakeWindowStartTime = null;
  let shakeDirectionWeight = 0;
  let shakeDirectionLockUntil = 0;
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

  function resetMotionSamples() {
    hasPreviousMotionSample = false;
    lastMotionSampleTime = null;
    previousMotionAcceleration.set(0, 0, 0);
    shakeWindowStartTime = null;
    shakeDirectionWeight = 0;
    shakeDirectionLockUntil = 0;
    initialShakeDirection.set(0, 0);
    accumulatedShakeDirection.set(0, 0);
  }

  function resetShakeDetection() {
    hasGravitySample = false;
    motionAccelerationSource = null;
    motionAcceleration.set(0, 0, 0);
    motionGravity.set(0, 0, 0);
    resetMotionSamples();
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

  function showPermissionButton(requesting = false, label = "Гироскоп") {
    permissionButton.hidden = false;
    permissionButton.disabled = requesting;
    permissionButton.textContent = requesting
      ? "Запрашиваем разрешение…"
      : label;
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

  function setLayerParallax(layerName, depth, parallaxX, parallaxY) {
    backgroundElement.style.setProperty(
      `--scene-${layerName}-parallax-x`,
      `${parallaxX * depth}px`,
    );
    backgroundElement.style.setProperty(
      `--scene-${layerName}-parallax-y`,
      `${parallaxY * depth}px`,
    );
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

    const parallaxX = -smoothedInput.x * profile.backgroundX;
    const parallaxY = smoothedInput.y * profile.backgroundY;

    setLayerParallax(
      "background-top",
      backgroundTopLayerDepth,
      parallaxX,
      parallaxY,
    );
    setLayerParallax(
      "background-bottom",
      backgroundBottomLayerDepth,
      parallaxX,
      parallaxY,
    );
    setLayerParallax("top", topLayerDepth, parallaxX, parallaxY);
    setLayerParallax("center", centerLayerDepth, parallaxX, parallaxY);
    setLayerParallax("bottom", bottomLayerDepth, parallaxX, parallaxY);
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

  function triggerShake(
    strength,
    direction,
    force = false,
    coherence = 1,
  ) {
    if (
      !shakeConfig.enabled
      || disposed
      || (!force && (!isActive() || isDesktopMode()))
    ) {
      return;
    }

    const safeStrength = THREE.MathUtils.clamp(strength, 0.35, 1);
    const safeCoherence = THREE.MathUtils.clamp(coherence, 0, 1);
    const directionLength = Math.hypot(direction.x, direction.y);
    let physicsDirectionX = 0;
    let physicsDirectionY = 0;
    if (directionLength > Number.EPSILON) {
      physicsDirectionX = direction.x / directionLength;
      physicsDirectionY = direction.y / directionLength;
      shakeDirection.set(physicsDirectionX, physicsDirectionY);
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
          x: physicsDirectionX,
          y: physicsDirectionY,
        },
        coherence: safeCoherence,
      });
    } catch (error) {
      console.error("Не удалось применить встряску физики", error);
    }
  }

  function resolveMotionDirection(acceleration) {
    const planarDirectionSign = shakeConfig.invertPlanarDirection === true
      ? -1
      : 1;
    const deviceX = acceleration.x * planarDirectionSign;
    const deviceY = acceleration.y * planarDirectionSign;
    const angle = THREE.MathUtils.degToRad(getScreenOrientationAngle());
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    const screenX = deviceX * cosine - deviceY * sine;
    const screenY = deviceX * sine + deviceY * cosine;
    const zVerticalGain = Math.max(shakeConfig.zVerticalGain, 0);
    const depthY = -acceleration.z * zVerticalGain;

    if (shakeConfig.cardinalDirections !== false) {
      const planarDirectionGain = Math.max(
        shakeConfig.planarDetectionGain,
        0.1,
      );
      const horizontalMagnitude = Math.abs(screenX) * planarDirectionGain;
      const planarVerticalMagnitude = Math.abs(screenY) * planarDirectionGain;
      const depthVerticalMagnitude = Math.abs(depthY);

      if (
        horizontalMagnitude >= planarVerticalMagnitude
        && horizontalMagnitude >= depthVerticalMagnitude
      ) {
        motionDirection.set(Math.sign(screenX), 0);
      } else if (planarVerticalMagnitude >= depthVerticalMagnitude) {
        motionDirection.set(0, Math.sign(screenY));
      } else {
        motionDirection.set(0, Math.sign(depthY));
      }
    } else {
      motionDirection.set(screenX, screenY + depthY);
    }

    return motionDirection.lengthSq() > Number.EPSILON;
  }

  function addLateralLift(direction) {
    const lateralLiftRatio = Math.max(shakeConfig.lateralLiftRatio, 0);
    direction.y += Math.abs(direction.x) * lateralLiftRatio;
    return direction;
  }

  function accumulateShakeSample(
    now,
    sampleInterval,
  ) {
    if (!resolveMotionDirection(motionAcceleration)) {
      return;
    }

    motionDirection.normalize();
    if (shakeWindowStartTime === null) {
      shakeWindowStartTime = now;
      initialShakeDirection.copy(motionDirection);
    } else if (motionDirection.dot(initialShakeDirection) <= 0) {
      // A shake produces an acceleration impulse followed by an opposite
      // braking impulse. Keep the onset direction instead of averaging both.
      return;
    }

    accumulatedShakeDirection.addScaledVector(
      motionDirection,
      sampleInterval,
    );
    shakeDirectionWeight += sampleInterval;
  }

  function flushShakeWindow(now) {
    if (shakeWindowStartTime === null || shakeDirectionWeight <= 0) {
      return;
    }

    const directionSampleDuration = shakeDirectionWeight;
    const accumulatedDirectionLength = accumulatedShakeDirection.length();
    const coherence = THREE.MathUtils.clamp(
      accumulatedDirectionLength / directionSampleDuration,
      0,
      1,
    );

    if (accumulatedDirectionLength > Number.EPSILON) {
      motionDirection
        .copy(accumulatedShakeDirection)
        .multiplyScalar(1 / accumulatedDirectionLength);
      if (shakeConfig.cardinalDirections === false) {
        addLateralLift(motionDirection).normalize();
      }
    } else {
      motionDirection.set(0, 0);
    }

    shakeWindowStartTime = null;
    shakeDirectionWeight = 0;
    initialShakeDirection.set(0, 0);
    accumulatedShakeDirection.set(0, 0);

    const minimumSampleDuration = Math.max(
      shakeConfig.minimumDirectionSampleSeconds ?? 0,
      0,
    );
    const minimumCoherence = THREE.MathUtils.clamp(
      shakeConfig.minimumDirectionCoherence ?? 0,
      0,
      1,
    );
    if (
      directionSampleDuration < minimumSampleDuration
      || coherence < minimumCoherence
      || motionDirection.lengthSq() === 0
    ) {
      return;
    }

    const fixedStrength = THREE.MathUtils.clamp(
      shakeConfig.fixedStrength ?? 1,
      0.35,
      1,
    );
    shakeDirectionLockUntil = now + Math.max(
      shakeConfig.directionLockSeconds ?? 0.1,
      0,
    ) * 1000;
    triggerShake(fixedStrength, motionDirection, false, 1);
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

    const now = performance.now();
    if (
      motionAccelerationSource === null
      || (
        motionAccelerationSource === "gravity"
        && hasDirectAcceleration
        && shakeWindowStartTime === null
        && now >= shakeDirectionLockUntil
      )
    ) {
      motionAccelerationSource = hasDirectAcceleration ? "direct" : "gravity";
      hasGravitySample = false;
      resetMotionSamples();
    }

    if (
      (motionAccelerationSource === "direct" && !hasDirectAcceleration)
      || (motionAccelerationSource === "gravity" && !hasGravityAcceleration)
    ) {
      return;
    }

    const reportedInterval =
      Number.isFinite(event.interval) && event.interval > 0
        ? event.interval / 1000
        : null;
    const measuredInterval =
      lastMotionSampleTime === null
        ? null
        : (now - lastMotionSampleTime) / 1000;
    const sampleInterval = THREE.MathUtils.clamp(
      reportedInterval ?? measuredInterval ?? 1 / 60,
      1 / 240,
      0.1,
    );
    lastMotionSampleTime = now;

    const source = motionAccelerationSource === "direct"
      ? directAcceleration
      : gravityAcceleration;
    motionAcceleration.set(source.x, source.y, source.z);

    if (motionAccelerationSource === "direct") {
      hasGravitySample = false;
    } else {
      if (!hasGravitySample) {
        motionGravity.copy(motionAcceleration);
        hasGravitySample = true;
      } else {
        const gravityTimeConstant = Math.max(
          shakeConfig.gravityTimeConstantSeconds ?? 0.22,
          0.01,
        );
        const gravityBlend = 1 - Math.exp(
          -sampleInterval / gravityTimeConstant,
        );
        motionGravity.lerp(motionAcceleration, gravityBlend);
      }
      motionAcceleration.sub(motionGravity);
    }

    const planarMagnitude = Math.hypot(
      motionAcceleration.x,
      motionAcceleration.y,
    );
    const planarDetectionGain = Math.max(
      shakeConfig.planarDetectionGain,
      0.1,
    );
    const detectionMagnitude = Math.hypot(
      planarMagnitude * planarDetectionGain,
      motionAcceleration.z,
    );
    const jerk = hasPreviousMotionSample
      ? motionAcceleration.distanceTo(previousMotionAcceleration) /
        sampleInterval
      : 0;
    previousMotionAcceleration.copy(motionAcceleration);
    hasPreviousMotionSample = true;

    const accelerationThreshold = Math.max(
      shakeConfig.accelerationThreshold,
      0.1,
    );
    const hardAccelerationThreshold = Math.max(
      shakeConfig.hardAccelerationThreshold,
      accelerationThreshold,
    );
    const jerkThreshold = Math.max(shakeConfig.jerkThreshold, 0.1);
    const isStrongImpulse =
      detectionMagnitude >= hardAccelerationThreshold
      || (detectionMagnitude >= accelerationThreshold && jerk >= jerkThreshold);

    if (isStrongImpulse && now >= shakeDirectionLockUntil) {
      accumulateShakeSample(now, sampleInterval);
    }

    const aggregationWindowMilliseconds = Math.max(
      shakeConfig.aggregationWindowSeconds,
      0.02,
    ) * 1000;
    if (
      shakeWindowStartTime !== null
      && now - shakeWindowStartTime >= aggregationWindowMilliseconds
    ) {
      flushShakeWindow(now);
    }
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

    if (shakeConfig.enabled && !hasMotion) {
      showPermissionError("Акселерометр недоступен в этом браузере.");
      return;
    }

    const needsOrientation = hasOrientation && !orientationListening;
    const needsMotion = shakeConfig.enabled && !motionListening;
    if (!needsOrientation && !needsMotion) {
      if (reducedMotion.matches && !motionOptIn) {
        showPermissionButton(false, "Включить движение");
      } else {
        hidePermissionUi();
      }
      return;
    }

    const orientationRequestable =
      needsOrientation
      && typeof DeviceOrientation.requestPermission === "function";
    const motionRequestable =
      needsMotion
      && typeof DeviceMotion.requestPermission === "function";
    const orientationDenied =
      needsOrientation && orientationPermissionState === "denied";
    const motionDenied =
      needsMotion && motionPermissionState === "denied";

    if (orientationDenied || motionDenied) {
      showPermissionError(
        motionDenied
          ? "Доступ к встряске отклонён. Разрешите Motion в настройках браузера и перезагрузите страницу."
          : "Доступ к гироскопу отклонён. Разрешите движение в настройках браузера и перезагрузите страницу.",
      );
      return;
    }

    const permissionLabel = needsOrientation && needsMotion
      ? "Разрешить датчики"
      : needsMotion
        ? "Разрешить встряску"
        : "Разрешить гироскоп";
    if (
      orientationPermissionState === "requesting"
      || motionPermissionState === "requesting"
    ) {
      showPermissionButton(true, permissionLabel);
      return;
    }

    if (reducedMotion.matches && !motionOptIn) {
      showPermissionButton(false, permissionLabel);
    } else if (orientationRequestable || motionRequestable) {
      showPermissionButton(false, permissionLabel);
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
    ) {
      return;
    }

    const DeviceOrientation = window.DeviceOrientationEvent;
    const DeviceMotion = window.DeviceMotionEvent;
    const hasOrientation = typeof DeviceOrientation !== "undefined";
    const hasMotion = typeof DeviceMotion !== "undefined";
    const needsOrientation = hasOrientation && !orientationListening;
    const needsMotion = shakeConfig.enabled && hasMotion && !motionListening;
    const requestOrientation =
      needsOrientation
      && orientationPermissionState !== "denied"
      && typeof DeviceOrientation.requestPermission === "function";
    const requestMotion =
      needsMotion
      && motionPermissionState !== "denied"
      && typeof DeviceMotion.requestPermission === "function";

    if (!hasOrientation && !hasMotion) {
      showPermissionError("Датчики движения недоступны в этом браузере.");
      return;
    }

    if (shakeConfig.enabled && !hasMotion) {
      showPermissionError("Акселерометр недоступен в этом браузере.");
      return;
    }

    if (!requestOrientation && !requestMotion) {
      enableSensors();
      configureSensors();
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
    } else if (needsMotion) {
      motionPermissionState = "granted";
    }
    const permissionLabel = needsOrientation && needsMotion
      ? "Разрешить датчики"
      : needsMotion
        ? "Разрешить встряску"
        : "Разрешить гироскоп";
    showPermissionButton(true, permissionLabel);

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
    triggerTestMotion({
      strength = 1,
      acceleration = { x: 4, y: 0, z: 0 },
    } = {}) {
      if (
        disposed
        || !Number.isFinite(acceleration?.x)
        || !Number.isFinite(acceleration?.y)
        || !Number.isFinite(acceleration?.z)
        || !resolveMotionDirection(acceleration)
      ) {
        return;
      }

      motionOptIn = true;
      backgroundElement.classList.add("is-motion-parallax-enabled");
      if (shakeConfig.cardinalDirections === false) {
        addLateralLift(motionDirection).normalize();
      }
      triggerShake(strength, motionDirection, true);
    },

    triggerTestShake({ strength = 1, direction = { x: 1, y: 0 } } = {}) {
      if (disposed) {
        return;
      }

      motionOptIn = true;
      backgroundElement.classList.add("is-motion-parallax-enabled");
      triggerShake(strength, direction, true);
    },

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
