const FINE_POINTER_QUERY = "(hover: hover) and (pointer: fine)";
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const MIN_PROXIMITY_RADIUS = 96;
const MAX_PROXIMITY_RADIUS = 180;
const SPRING_STIFFNESS = 180;
const SPRING_DAMPING = 24;
const MAX_FRAME_DELTA = 0.032;
const SETTLE_POSITION_EPSILON = 0.01;
const SETTLE_VELOCITY_EPSILON = 0.01;

const TARGET_CONFIG = {
  "#start-headphone": {
    edge: "left",
    maxOffset: 8,
    maxRotation: 1.2,
    touchImpulse: 150,
  },
  "#start-keyboard": {
    edge: "left",
    maxOffset: 9,
    maxRotation: 1.4,
    touchImpulse: 170,
  },
  "#start-cup-group": {
    edge: "left",
    maxOffset: 8,
    maxRotation: 1.2,
    touchImpulse: 150,
  },
  "#start-trophy": {
    edge: "right",
    maxOffset: 11,
    maxRotation: 1.6,
    touchImpulse: 190,
  },
  "#start-camera": {
    edge: "right",
    maxOffset: 9,
    maxRotation: 1.3,
    touchImpulse: 165,
  },
  "#start-ball": {
    edge: "right",
    maxOffset: 8,
    maxRotation: 1.5,
    touchImpulse: 155,
  },
};

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function getDistanceToRect(x, y, rect) {
  const closestX = clamp(x, rect.left, rect.right);
  const closestY = clamp(y, rect.top, rect.bottom);

  return Math.hypot(x - closestX, y - closestY);
}

function getProximityRadius() {
  return clamp(window.innerWidth * 0.14, MIN_PROXIMITY_RADIUS, MAX_PROXIMITY_RADIUS);
}

function getTouchImpulseRadius() {
  return clamp(window.innerWidth * 0.3, MIN_PROXIMITY_RADIUS, MAX_PROXIMITY_RADIUS);
}

function getPushDirection(state, x, y) {
  const rect = state.element.getBoundingClientRect();
  const centerX = (rect.left + rect.right) * 0.5;
  const centerY = (rect.top + rect.bottom) * 0.5;
  const directionX = centerX - x;
  const directionY = centerY - y;
  const length = Math.hypot(directionX, directionY);

  if (length > Number.EPSILON) {
    state.lastDirectionX = directionX / length;
    state.lastDirectionY = directionY / length;
  }

  return {
    x: state.lastDirectionX,
    y: state.lastDirectionY,
  };
}

function isVisibleRect(rect) {
  return rect.width > 0 && rect.height > 0;
}

function constrainHorizontalMotion(state, value) {
  if (state.config.edge === "left") {
    return Math.min(value, 0);
  }

  if (state.config.edge === "right") {
    return Math.max(value, 0);
  }

  return value;
}

function createTargetState(element) {
  const config = TARGET_CONFIG[`#${element.id}`] ?? {
    maxOffset: 9,
    maxRotation: 1.3,
    touchImpulse: 165,
  };

  return {
    element,
    config,
    x: 0,
    y: 0,
    rotation: 0,
    velocityX: 0,
    velocityY: 0,
    velocityRotation: 0,
    targetX: 0,
    targetY: 0,
    targetRotation: 0,
    lastDirectionX: 0,
    lastDirectionY: -1,
  };
}

function setMotionVariables(state) {
  state.element.style.setProperty("--start-bounce-x", `${state.x.toFixed(3)}px`);
  state.element.style.setProperty("--start-bounce-y", `${state.y.toFixed(3)}px`);
  state.element.style.setProperty(
    "--start-bounce-rotation",
    `${state.rotation.toFixed(3)}deg`,
  );
}

export function createStartScreenMotion({ root, targets }) {
  if (!(root instanceof HTMLElement)) {
    return { dispose() {} };
  }

  const targetStates = [...targets]
    .filter((element) => element instanceof HTMLElement)
    .map(createTargetState);

  if (targetStates.length === 0) {
    return { dispose() {} };
  }

  const finePointer = window.matchMedia(FINE_POINTER_QUERY);
  const reducedMotion = window.matchMedia(REDUCED_MOTION_QUERY);
  let animationFrameId = null;
  let lastFrameTime = performance.now();
  let disposed = false;

  function clearTargets() {
    for (const state of targetStates) {
      state.targetX = 0;
      state.targetY = 0;
      state.targetRotation = 0;
    }
  }

  function writeZeroMotion() {
    for (const state of targetStates) {
      state.x = 0;
      state.y = 0;
      state.rotation = 0;
      state.velocityX = 0;
      state.velocityY = 0;
      state.velocityRotation = 0;
      setMotionVariables(state);
    }
  }

  function requestAnimation() {
    if (animationFrameId !== null || disposed || reducedMotion.matches) {
      return;
    }

    animationFrameId = window.requestAnimationFrame(animateMotion);
  }

  function animateMotion(time) {
    animationFrameId = null;

    if (disposed) {
      return;
    }

    if (reducedMotion.matches) {
      clearTargets();
      writeZeroMotion();
      return;
    }

    const deltaTime = Math.min(
      Math.max((time - lastFrameTime) / 1000, 0),
      MAX_FRAME_DELTA,
    );
    lastFrameTime = time;
    let isMoving = false;

    for (const state of targetStates) {
      const accelerationX =
        (state.targetX - state.x) * SPRING_STIFFNESS
        - state.velocityX * SPRING_DAMPING;
      const accelerationY =
        (state.targetY - state.y) * SPRING_STIFFNESS
        - state.velocityY * SPRING_DAMPING;
      const accelerationRotation =
        (state.targetRotation - state.rotation) * SPRING_STIFFNESS
        - state.velocityRotation * SPRING_DAMPING;

      state.velocityX += accelerationX * deltaTime;
      state.velocityY += accelerationY * deltaTime;
      state.velocityRotation += accelerationRotation * deltaTime;
      state.x += state.velocityX * deltaTime;
      state.y += state.velocityY * deltaTime;
      state.rotation += state.velocityRotation * deltaTime;

      const constrainedX = constrainHorizontalMotion(state, state.x);
      if (constrainedX !== state.x) {
        state.x = constrainedX;
        state.velocityX = 0;
      }

      if (
        Math.abs(state.x) < SETTLE_POSITION_EPSILON
        && Math.abs(state.y) < SETTLE_POSITION_EPSILON
        && Math.abs(state.rotation) < SETTLE_POSITION_EPSILON
        && Math.abs(state.velocityX) < SETTLE_VELOCITY_EPSILON
        && Math.abs(state.velocityY) < SETTLE_VELOCITY_EPSILON
        && Math.abs(state.velocityRotation) < SETTLE_VELOCITY_EPSILON
        && state.targetX === 0
        && state.targetY === 0
        && state.targetRotation === 0
      ) {
        state.x = 0;
        state.y = 0;
        state.rotation = 0;
        state.velocityX = 0;
        state.velocityY = 0;
        state.velocityRotation = 0;
      } else {
        isMoving = true;
      }

      setMotionVariables(state);
    }

    if (isMoving) {
      requestAnimation();
    }
  }

  function updatePointerTargets(x, y) {
    const radius = getProximityRadius();

    for (const state of targetStates) {
      const rect = state.element.getBoundingClientRect();

      if (!isVisibleRect(rect)) {
        state.targetX = 0;
        state.targetY = 0;
        state.targetRotation = 0;
        continue;
      }

      const distance = getDistanceToRect(x, y, rect);
      if (distance >= radius) {
        state.targetX = 0;
        state.targetY = 0;
        state.targetRotation = 0;
        continue;
      }

      const proximity = 1 - distance / radius;
      const strength = proximity * proximity;
      const direction = getPushDirection(state, x, y);

      state.targetX = constrainHorizontalMotion(
        state,
        direction.x * state.config.maxOffset * strength,
      );
      state.targetY = direction.y * state.config.maxOffset * strength;
      state.targetRotation =
        -direction.x * state.config.maxRotation * strength;
    }

    requestAnimation();
  }

  function applyTouchImpulse(x, y) {
    const radius = getTouchImpulseRadius();
    let hasAffectedTarget = false;

    for (const state of targetStates) {
      const rect = state.element.getBoundingClientRect();

      if (!isVisibleRect(rect)) {
        continue;
      }

      const distance = getDistanceToRect(x, y, rect);
      if (distance >= radius) {
        continue;
      }

      const proximity = 1 - distance / radius;
      const strength = proximity * proximity;
      const direction = getPushDirection(state, x, y);

      state.velocityX += constrainHorizontalMotion(
        state,
        direction.x * state.config.touchImpulse * strength,
      );
      state.velocityY += direction.y * state.config.touchImpulse * strength;
      state.velocityRotation +=
        -direction.x * state.config.maxRotation * 24 * strength;
      hasAffectedTarget = true;
    }

    if (hasAffectedTarget) {
      requestAnimation();
    }
  }

  function handlePointerMove(event) {
    if (
      reducedMotion.matches
      || event.pointerType === "touch"
      || !finePointer.matches
    ) {
      return;
    }

    updatePointerTargets(event.clientX, event.clientY);
  }

  function handlePointerLeave() {
    if (reducedMotion.matches) {
      return;
    }

    clearTargets();
    requestAnimation();
  }

  function handlePointerDown(event) {
    if (
      reducedMotion.matches
      || event.pointerType !== "touch"
      || !event.isPrimary
    ) {
      return;
    }

    applyTouchImpulse(event.clientX, event.clientY);
  }

  function handleMotionPreferenceChange() {
    if (reducedMotion.matches) {
      if (animationFrameId !== null) {
        window.cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
      }
      clearTargets();
      writeZeroMotion();
      return;
    }

    lastFrameTime = performance.now();
  }

  root.addEventListener("pointermove", handlePointerMove, { passive: true });
  root.addEventListener("pointerleave", handlePointerLeave, { passive: true });
  root.addEventListener("pointerdown", handlePointerDown, { passive: true });
  reducedMotion.addEventListener("change", handleMotionPreferenceChange);

  if (reducedMotion.matches) {
    writeZeroMotion();
  }

  return {
    dispose() {
      if (disposed) {
        return;
      }

      disposed = true;
      root.removeEventListener("pointermove", handlePointerMove);
      root.removeEventListener("pointerleave", handlePointerLeave);
      root.removeEventListener("pointerdown", handlePointerDown);
      reducedMotion.removeEventListener("change", handleMotionPreferenceChange);

      if (animationFrameId !== null) {
        window.cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
      }

      clearTargets();
      writeZeroMotion();
    },
  };
}
