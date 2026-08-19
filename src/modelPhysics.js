import RAPIER from "@dimforge/rapier3d-compat";
import * as THREE from "three";

const CLIP_NAME_PATTERN = /^clip_low(?:[._]?\d+)?$/;
const BALL_NAME_PATTERN = /^ball\d+$/;
const STATIC_BASE_NAME_PATTERN = /^static_base(?:_\d+)?$/;

const MIN_POINTER_DELTA_TIME = 1 / 240;
const MAX_POINTER_DELTA_TIME = 0.12;

const GESTURE_THRESHOLD = 0.8;
const GESTURE_RELEASE_THRESHOLD = 0.25;
const MAX_GESTURE_VELOCITY = 5;
const HORIZONTAL_DIRECTION_THRESHOLD = 0.12;

const MIN_LAUNCH_DURATION = 1.05;
const MAX_LAUNCH_DURATION = 1.35;
const MIN_TARGET_HEIGHT = 0.74;
const MAX_TARGET_HEIGHT = 0.84;
const MAX_TARGET_DISK_RADIUS = 0.62;
const MIN_TARGET_SEPARATION_FACTOR = 0.82;
const TARGET_PLACEMENT_ATTEMPTS = 14;

const MIN_SWIRL_FACTOR = 0.018;
const MAX_SWIRL_FACTOR = 0.04;
const MIN_LAUNCH_SPIN = 0.12;
const MAX_LAUNCH_SPIN = 0.28;

const RELEASE_INFERRED_VELOCITY_FACTOR = 0.12;
const RELEASE_DRIFT_FACTOR = 0.035;
const MIN_RELEASE_SPIN = 0.22;
const MAX_RELEASE_SPIN = 0.42;

const ACTIVE_GRAVITY = { x: 0, y: -0.4, z: 0 };

let rapierInitialization = null;

function initializeRapier() {
  if (!rapierInitialization) {
    rapierInitialization = RAPIER.init();
  }

  return rapierInitialization;
}

function hashName(name) {
  let hash = 2166136261;

  for (let index = 0; index < name.length; index += 1) {
    hash ^= name.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0) / 4294967295;
}

function createDeterministicVector(seed, offset = 0) {
  const vector = new THREE.Vector3(
    Math.sin((seed + offset + 0.17) * 37.1),
    Math.sin((seed + offset + 0.53) * 61.7),
    Math.sin((seed + offset + 0.89) * 83.3),
  );

  if (vector.lengthSq() < Number.EPSILON) {
    vector.set(1, 0, 0);
  }

  return vector.normalize();
}

function smootherStep(progress) {
  const clamped = THREE.MathUtils.clamp(progress, 0, 1);

  return (
    clamped *
    clamped *
    clamped *
    (clamped * (clamped * 6 - 15) + 10)
  );
}

function getGeometryBox(geometry) {
  if (!geometry.boundingBox) {
    geometry.computeBoundingBox();
  }

  return geometry.boundingBox;
}

function getGeometrySphere(geometry) {
  if (!geometry.boundingSphere) {
    geometry.computeBoundingSphere();
  }

  return geometry.boundingSphere;
}

function createTrimeshData(mesh, rootInverseWorldMatrix) {
  const positionAttribute = mesh.geometry.attributes.position;

  if (!positionAttribute) {
    throw new Error(`У объекта ${mesh.name} отсутствуют вершины`);
  }

  const rootLocalMatrix = new THREE.Matrix4().multiplyMatrices(
    rootInverseWorldMatrix,
    mesh.matrixWorld,
  );

  const vertices = new Float32Array(positionAttribute.count * 3);
  const vertex = new THREE.Vector3();

  for (let index = 0; index < positionAttribute.count; index += 1) {
    vertex
      .fromBufferAttribute(positionAttribute, index)
      .applyMatrix4(rootLocalMatrix);

    vertices[index * 3] = vertex.x;
    vertices[index * 3 + 1] = vertex.y;
    vertices[index * 3 + 2] = vertex.z;
  }

  const geometryIndex = mesh.geometry.index;
  const indices = geometryIndex
    ? Uint32Array.from(geometryIndex.array)
    : Uint32Array.from({ length: positionAttribute.count }, (_, index) => index);

  return { vertices, indices };
}

function createStaticTrimesh(world, mesh, config, rootInverseWorldMatrix) {
  const { vertices, indices } = createTrimeshData(
    mesh,
    rootInverseWorldMatrix,
  );

  const collider = RAPIER.ColliderDesc.trimesh(
    vertices,
    indices,
    RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES,
  )
    .setFriction(config.friction)
    .setRestitution(config.restitution);

  world.createCollider(collider);
}

function getScaledBoxCenter(node, box) {
  return box.getCenter(new THREE.Vector3()).multiply(node.scale);
}

function createClipCollider(node, config) {
  const box = getGeometryBox(node.geometry);
  const size = box.getSize(new THREE.Vector3());
  const center = getScaledBoxCenter(node, box);

  const visualHalfHeight = size.y * 0.5 * Math.abs(node.scale.y);
  const visualRadius = Math.max(
    size.x * 0.5 * Math.abs(node.scale.x),
    size.z * 0.5 * Math.abs(node.scale.z),
  );

  const halfHeight = visualHalfHeight * config.clipColliderScale;
  const radius = visualRadius * config.clipColliderScale;
  const visualExtent = Math.hypot(visualRadius, visualHalfHeight);

  return {
    descriptor: RAPIER.ColliderDesc.cylinder(halfHeight, radius),
    center,
    boundaryRadius: center.length() + visualExtent,
    launchClearance: visualExtent,
    mass: config.clipMass,
  };
}

function createBallCollider(node, config) {
  const sphere = getGeometrySphere(node.geometry);
  const center = sphere.center.clone().multiply(node.scale);

  const visualRadius =
    sphere.radius *
    Math.max(
      Math.abs(node.scale.x),
      Math.abs(node.scale.y),
      Math.abs(node.scale.z),
    );

  const radius = visualRadius * config.ballColliderScale;

  return {
    descriptor: RAPIER.ColliderDesc.ball(radius),
    center,
    boundaryRadius: center.length() + visualRadius,
    launchClearance: visualRadius,
    mass: config.ballMass,
  };
}

function createBoundary(sphereNode) {
  const box = getGeometryBox(sphereNode.geometry);

  sphereNode.updateMatrix();

  return {
    center: box.getCenter(new THREE.Vector3()),
    radii: box.getSize(new THREE.Vector3()).multiplyScalar(0.5),
    matrix: sphereNode.matrix.clone(),
    inverseMatrix: sphereNode.matrix.clone().invert(),
    normalMatrix: new THREE.Matrix3().getNormalMatrix(sphereNode.matrix),
  };
}

class ModelPhysics {
  constructor({
    root,
    camera,
    canvas,
    config,
    sphereNode,
    movingNodes,
    staticNodes,
  }) {
    this.root = root;
    this.camera = camera;
    this.canvas = canvas;
    this.config = config;

    this.world = new RAPIER.World(ACTIVE_GRAVITY);
    this.world.timestep = config.fixedTimeStep;
    this.world.maxCcdSubsteps = config.ccdSubsteps;

    this.boundary = createBoundary(sphereNode);
    this.bodies = [];

    this.phase = "idle";
    this.accumulator = 0;
    this.launchElapsed = 0;
    this.launchDuration = MAX_LAUNCH_DURATION;
    this.launchStrength = 0;
    this.launchSerial = 0;
    this.swirlDirection = 1;

    this.gestureArmed = true;
    this.activeTouchPointerId = null;
    this.lastPointer = null;
    this.rawPointerVelocity = new THREE.Vector2();
    this.smoothedPointerVelocity = new THREE.Vector2();
    this.eventController = new AbortController();

    this.boundaryPosition = new THREE.Vector3();
    this.boundaryOffset = new THREE.Vector3();
    this.boundaryNormal = new THREE.Vector3();

    this.matrixScale = new THREE.Vector3();
    this.matrixPosition = new THREE.Vector3();
    this.matrixQuaternion = new THREE.Quaternion();

    this.launchPosition = new THREE.Vector3();
    this.launchRotation = new THREE.Quaternion();
    this.launchRotationDelta = new THREE.Quaternion();

    this.boundary.matrix.decompose(
      this.matrixPosition,
      this.matrixQuaternion,
      this.matrixScale,
    );

    this.launchCenter = this.boundary.center
      .clone()
      .applyMatrix4(this.boundary.matrix);

    this.launchRadii = this.boundary.radii.clone().multiply(
      new THREE.Vector3(
        Math.abs(this.matrixScale.x),
        Math.abs(this.matrixScale.y),
        Math.abs(this.matrixScale.z),
      ),
    );

    root.updateMatrixWorld(true);
    const rootInverseWorldMatrix = root.matrixWorld.clone().invert();

    createStaticTrimesh(
      this.world,
      sphereNode,
      config,
      rootInverseWorldMatrix,
    );

    staticNodes.forEach((node) => {
      createStaticTrimesh(
        this.world,
        node,
        config,
        rootInverseWorldMatrix,
      );
    });

    movingNodes.forEach((node, index) => {
      this.createDynamicBody(node, index);
    });

    this.bindPointerEvents();
  }

  createDynamicBody(node, index) {
    const isBall = BALL_NAME_PATTERN.test(node.name);
    const colliderData = isBall
      ? createBallCollider(node, this.config)
      : createClipCollider(node, this.config);

    const bodyDescriptor = RAPIER.RigidBodyDesc.fixed()
      .setTranslation(node.position.x, node.position.y, node.position.z)
      .setRotation({
        x: node.quaternion.x,
        y: node.quaternion.y,
        z: node.quaternion.z,
        w: node.quaternion.w,
      })
      .setLinearDamping(this.config.linearDamping)
      .setAngularDamping(this.config.angularDamping)
      .setCanSleep(false)
      .setCcdEnabled(true);

    const body = this.world.createRigidBody(bodyDescriptor);

    colliderData.descriptor
      .setTranslation(
        colliderData.center.x,
        colliderData.center.y,
        colliderData.center.z,
      )
      .setMass(colliderData.mass)
      .setFriction(this.config.friction)
      .setRestitution(this.config.restitution);

    this.world.createCollider(colliderData.descriptor, body);

    const seed = hashName(node.name);

    this.bodies.push({
      node,
      body,
      index,
      seed,
      boundaryRadius: colliderData.boundaryRadius,
      launchClearance: colliderData.launchClearance,
      spinAxis: createDeterministicVector(seed, 0.73),
      releaseDirection: createDeterministicVector(seed, 1.17),
      launch: null,
    });
  }

  bindPointerEvents() {
    const options = { signal: this.eventController.signal };

    this.canvas.addEventListener(
      "pointerenter",
      (event) => {
        if (event.pointerType === "mouse") {
          this.gestureArmed = true;
          this.resetPointerSmoothing();
          this.rememberPointer(event);
        }
      },
      options,
    );

    this.canvas.addEventListener(
      "pointerdown",
      (event) => {
        if (!event.isPrimary || event.pointerType === "mouse") {
          return;
        }

        this.activeTouchPointerId = event.pointerId;
        this.canvas.setPointerCapture(event.pointerId);
        this.gestureArmed = true;
        this.resetPointerSmoothing();
        this.rememberPointer(event);
      },
      options,
    );

    this.canvas.addEventListener(
      "pointermove",
      (event) => {
        if (!event.isPrimary) {
          return;
        }

        if (
          event.pointerType !== "mouse" &&
          event.pointerId !== this.activeTouchPointerId
        ) {
          return;
        }

        this.handlePointerMove(event);
      },
      options,
    );

    this.canvas.addEventListener(
      "pointerleave",
      (event) => {
        if (event.pointerType === "mouse") {
          this.lastPointer = null;
          this.gestureArmed = true;
          this.resetPointerSmoothing();
        }
      },
      options,
    );

    const releasePointer = (event) => {
      if (event.pointerId !== this.activeTouchPointerId) {
        return;
      }

      if (this.canvas.hasPointerCapture(event.pointerId)) {
        this.canvas.releasePointerCapture(event.pointerId);
      }

      this.activeTouchPointerId = null;
      this.lastPointer = null;
      this.gestureArmed = true;
      this.resetPointerSmoothing();
    };

    this.canvas.addEventListener("pointerup", releasePointer, options);
    this.canvas.addEventListener("pointercancel", releasePointer, options);
  }

  rememberPointer(event) {
    this.lastPointer = {
      x: event.clientX,
      y: event.clientY,
      time: event.timeStamp,
    };
  }

  resetPointerSmoothing() {
    this.rawPointerVelocity.set(0, 0);
    this.smoothedPointerVelocity.set(0, 0);
  }

  handlePointerMove(event) {
    if (!this.lastPointer) {
      this.resetPointerSmoothing();
      this.rememberPointer(event);
      return;
    }

    const deltaTime = (event.timeStamp - this.lastPointer.time) / 1000;

    if (deltaTime <= 0 || deltaTime > MAX_POINTER_DELTA_TIME) {
      this.resetPointerSmoothing();
      this.rememberPointer(event);
      return;
    }

    const rect = this.canvas.getBoundingClientRect();
    const safeDeltaTime = Math.max(deltaTime, MIN_POINTER_DELTA_TIME);

    const velocityX =
      (event.clientX - this.lastPointer.x) /
      Math.max(rect.width, 1) /
      safeDeltaTime;

    const velocityY =
      -(event.clientY - this.lastPointer.y) /
      Math.max(rect.height, 1) /
      safeDeltaTime;

    const pointerSmoothing = THREE.MathUtils.clamp(
      this.config.pointerSmoothing,
      0,
      1,
    );

    const smoothingAlpha =
      1 -
      Math.pow(
        1 - pointerSmoothing,
        safeDeltaTime / this.config.fixedTimeStep,
      );

    this.rawPointerVelocity.set(velocityX, velocityY);
    this.smoothedPointerVelocity.lerp(
      this.rawPointerVelocity,
      smoothingAlpha,
    );

    this.rememberPointer(event);

    this.applyPointerVelocity(
      this.smoothedPointerVelocity.x,
      this.smoothedPointerVelocity.y,
    );
  }

  applyPointerVelocity(velocityX, velocityY) {
    const upwardSpeed = Math.max(velocityY, 0);
    const gestureSpeed = Math.hypot(velocityX, upwardSpeed);

    if (gestureSpeed <= GESTURE_RELEASE_THRESHOLD) {
      this.gestureArmed = true;
      return;
    }

    if (
      this.phase === "launch" ||
      !this.gestureArmed ||
      gestureSpeed < GESTURE_THRESHOLD
    ) {
      return;
    }

    this.gestureArmed = false;

    const maximumVelocity = Math.min(
      MAX_GESTURE_VELOCITY,
      this.config.maxPointerVelocity,
    );

    const cappedVelocity = Math.min(gestureSpeed, maximumVelocity);
    const strength = THREE.MathUtils.clamp(
      (cappedVelocity - GESTURE_THRESHOLD) /
        Math.max(maximumVelocity - GESTURE_THRESHOLD, Number.EPSILON),
      0,
      1,
    );

    let direction = this.swirlDirection;

    if (Math.abs(velocityX) >= HORIZONTAL_DIRECTION_THRESHOLD) {
      direction = Math.sign(velocityX);
    } else {
      direction *= -1;
    }

    this.startLaunch(strength, direction);
  }

  startLaunch(strength, direction) {
    this.phase = "launch";
    this.accumulator = 0;
    this.launchElapsed = 0;
    this.launchStrength = strength;
    this.launchSerial += 1;
    this.swirlDirection = direction || 1;

    this.launchDuration = THREE.MathUtils.lerp(
      MAX_LAUNCH_DURATION,
      MIN_LAUNCH_DURATION,
      strength,
    );

    const reservedTargets = [];

    for (const item of this.bodies) {
      const { body } = item;
      const translation = body.translation();
      const rotation = body.rotation();

      const startPosition = new THREE.Vector3(
        translation.x,
        translation.y,
        translation.z,
      );

      const startQuaternion = new THREE.Quaternion(
        rotation.x,
        rotation.y,
        rotation.z,
        rotation.w,
      );

      body.setBodyType(
        RAPIER.RigidBodyType.KinematicPositionBased,
        true,
      );

      const targetPosition = this.chooseLaunchTarget(
        item,
        startPosition,
        reservedTargets,
      );

      reservedTargets.push({
        position: targetPosition.clone(),
        clearance: item.launchClearance,
      });

      const centerOffset = startPosition.clone().sub(this.launchCenter);

      let tangent = new THREE.Vector3(
        -centerOffset.z,
        0,
        centerOffset.x,
      );

      if (tangent.lengthSq() < 1e-8) {
        const fallbackAngle =
          hashName(`${item.node.name}:${this.launchSerial}:tangent`) *
          Math.PI *
          2;

        tangent.set(
          Math.cos(fallbackAngle),
          0,
          Math.sin(fallbackAngle),
        );
      } else {
        tangent.normalize();
      }

      const swirlScale = Math.min(
        this.launchRadii.x,
        this.launchRadii.z,
      );

      const swirlAmplitude =
        swirlScale *
        THREE.MathUtils.lerp(
          MIN_SWIRL_FACTOR,
          MAX_SWIRL_FACTOR,
          hashName(`${item.node.name}:${this.launchSerial}:swirl`),
        ) *
        (0.8 + strength * 0.2);

      const totalSpin =
        this.swirlDirection *
        THREE.MathUtils.lerp(
          MIN_LAUNCH_SPIN,
          MAX_LAUNCH_SPIN,
          hashName(`${item.node.name}:${this.launchSerial}:spin`),
        );

      item.launch = {
        startPosition,
        startQuaternion,
        targetPosition,
        tangent,
        swirlAmplitude,
        totalSpin,
      };
    }
  }

  chooseLaunchTarget(item, startPosition, reservedTargets) {
    let bestTarget = null;
    let bestDistance = -Infinity;

    for (
      let attempt = 0;
      attempt < TARGET_PLACEMENT_ATTEMPTS;
      attempt += 1
    ) {
      const baseKey = `${item.node.name}:${this.launchSerial}:${attempt}`;

      const heightSeed = hashName(`${baseKey}:height`);
      const angleSeed = hashName(`${baseKey}:angle`);
      const radiusSeed = hashName(`${baseKey}:radius`);

      const heightFactor = THREE.MathUtils.lerp(
        MIN_TARGET_HEIGHT,
        MAX_TARGET_HEIGHT,
        heightSeed,
      );

      const maximumTargetY =
        this.launchCenter.y +
        this.launchRadii.y -
        item.launchClearance;

      const minimumLift =
        this.launchRadii.y *
        THREE.MathUtils.lerp(0.28, 0.36, this.launchStrength);

      const desiredTargetY =
        this.launchCenter.y + this.launchRadii.y * heightFactor;

      const targetY = Math.min(
        Math.max(desiredTargetY, startPosition.y + minimumLift),
        maximumTargetY,
      );

      const normalizedY = THREE.MathUtils.clamp(
        (targetY - this.launchCenter.y) /
          Math.max(this.launchRadii.y, Number.EPSILON),
        -0.98,
        0.98,
      );

      const crossSectionScale = Math.sqrt(
        Math.max(0.04, 1 - normalizedY * normalizedY),
      );

      const safeRadiusX = Math.max(
        0,
        this.launchRadii.x * crossSectionScale - item.launchClearance,
      );

      const safeRadiusZ = Math.max(
        0,
        this.launchRadii.z * crossSectionScale - item.launchClearance,
      );

      const diskRadius = Math.sqrt(radiusSeed) * MAX_TARGET_DISK_RADIUS;

      const angle =
        angleSeed * Math.PI * 2 + item.index * 2.399963229728653;

      const candidate = new THREE.Vector3(
        this.launchCenter.x + Math.cos(angle) * safeRadiusX * diskRadius,
        targetY,
        this.launchCenter.z + Math.sin(angle) * safeRadiusZ * diskRadius,
      );

      let minimumDistance = Infinity;
      let valid = true;

      for (const reserved of reservedTargets) {
        const distance = candidate.distanceTo(reserved.position);

        const requiredDistance =
          (item.launchClearance + reserved.clearance) *
          MIN_TARGET_SEPARATION_FACTOR;

        minimumDistance = Math.min(
          minimumDistance,
          distance - requiredDistance,
        );

        if (distance < requiredDistance) {
          valid = false;
        }
      }

      if (reservedTargets.length === 0) {
        minimumDistance = Infinity;
      }

      if (valid) {
        return candidate;
      }

      if (minimumDistance > bestDistance) {
        bestDistance = minimumDistance;
        bestTarget = candidate;
      }
    }

    return bestTarget ?? startPosition.clone();
  }

  updateLaunchStep() {
    this.launchElapsed = Math.min(
      this.launchElapsed + this.config.fixedTimeStep,
      this.launchDuration,
    );

    const progress = THREE.MathUtils.clamp(
      this.launchElapsed /
        Math.max(this.launchDuration, Number.EPSILON),
      0,
      1,
    );

    const easedProgress = smootherStep(progress);
    const swirlEnvelope = Math.sin(Math.PI * progress) ** 2;

    for (const item of this.bodies) {
      const launch = item.launch;

      if (!launch) {
        continue;
      }

      this.launchPosition
        .copy(launch.startPosition)
        .lerp(launch.targetPosition, easedProgress)
        .addScaledVector(
          launch.tangent,
          launch.swirlAmplitude * swirlEnvelope * this.swirlDirection,
        );

      this.launchRotationDelta.setFromAxisAngle(
        item.spinAxis,
        launch.totalSpin * easedProgress,
      );

      this.launchRotation
        .copy(launch.startQuaternion)
        .multiply(this.launchRotationDelta);

      item.body.setNextKinematicTranslation({
        x: this.launchPosition.x,
        y: this.launchPosition.y,
        z: this.launchPosition.z,
      });

      item.body.setNextKinematicRotation({
        x: this.launchRotation.x,
        y: this.launchRotation.y,
        z: this.launchRotation.z,
        w: this.launchRotation.w,
      });
    }

    this.world.step();
    this.syncNodes();

    if (progress >= 1) {
      this.releaseToPhysics();
      return true;
    }

    return false;
  }

  releaseToPhysics() {
    for (const item of this.bodies) {
      const { body, launch } = item;

      if (!launch) {
        continue;
      }

      const inferredVelocity = body.linvel();

      const releaseDirection = item.releaseDirection.clone().setY(0);

      if (releaseDirection.lengthSq() < 1e-8) {
        releaseDirection.set(1, 0, 0);
      } else {
        releaseDirection.normalize();
      }

      const driftSpeed =
        this.config.maxLinearSpeed *
        RELEASE_DRIFT_FACTOR *
        THREE.MathUtils.lerp(
          0.7,
          1.15,
          hashName(`${item.node.name}:${this.launchSerial}:drift`),
        );

      const releaseVelocity = new THREE.Vector3(
        inferredVelocity.x * RELEASE_INFERRED_VELOCITY_FACTOR,
        0,
        inferredVelocity.z * RELEASE_INFERRED_VELOCITY_FACTOR,
      ).addScaledVector(releaseDirection, driftSpeed);

      const releaseSpin =
        THREE.MathUtils.lerp(
          MIN_RELEASE_SPIN,
          MAX_RELEASE_SPIN,
          hashName(`${item.node.name}:${this.launchSerial}:release-spin`),
        ) * this.swirlDirection;

      body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);

      body.setLinvel(
        {
          x: releaseVelocity.x,
          y: releaseVelocity.y,
          z: releaseVelocity.z,
        },
        true,
      );

      body.setAngvel(
        {
          x: item.spinAxis.x * releaseSpin,
          y: item.spinAxis.y * releaseSpin,
          z: item.spinAxis.z * releaseSpin,
        },
        true,
      );

      body.resetForces(false);
      body.resetTorques(false);

      item.launch = null;
    }

    this.phase = "physics";
    this.accumulator = 0;
  }

  clampBodySpeeds() {
    for (const { body } of this.bodies) {
      const linearVelocity = body.linvel();
      const linearSpeed = Math.hypot(
        linearVelocity.x,
        linearVelocity.y,
        linearVelocity.z,
      );

      if (linearSpeed > this.config.maxLinearSpeed) {
        const scale = this.config.maxLinearSpeed / linearSpeed;

        body.setLinvel(
          {
            x: linearVelocity.x * scale,
            y: linearVelocity.y * scale,
            z: linearVelocity.z * scale,
          },
          true,
        );
      }

      const angularVelocity = body.angvel();
      const angularSpeed = Math.hypot(
        angularVelocity.x,
        angularVelocity.y,
        angularVelocity.z,
      );

      if (angularSpeed > this.config.maxAngularSpeed) {
        const scale = this.config.maxAngularSpeed / angularSpeed;

        body.setAngvel(
          {
            x: angularVelocity.x * scale,
            y: angularVelocity.y * scale,
            z: angularVelocity.z * scale,
          },
          true,
        );
      }
    }
  }

  enforceSphereBoundary() {
    const minimumRadius = Math.min(
      this.boundary.radii.x,
      this.boundary.radii.y,
      this.boundary.radii.z,
    );

    for (const item of this.bodies) {
      const translation = item.body.translation();

      const safeScale = Math.max(
        0.05,
        1 -
          item.boundaryRadius /
            Math.max(minimumRadius, Number.EPSILON),
      );

      const radiusX = this.boundary.radii.x * safeScale;
      const radiusY = this.boundary.radii.y * safeScale;
      const radiusZ = this.boundary.radii.z * safeScale;

      this.boundaryPosition
        .set(translation.x, translation.y, translation.z)
        .applyMatrix4(this.boundary.inverseMatrix);

      this.boundaryOffset
        .copy(this.boundaryPosition)
        .sub(this.boundary.center);

      const normalizedDistance = Math.hypot(
        this.boundaryOffset.x / radiusX,
        this.boundaryOffset.y / radiusY,
        this.boundaryOffset.z / radiusZ,
      );

      if (normalizedDistance <= 1) {
        continue;
      }

      this.boundaryOffset.multiplyScalar(1 / normalizedDistance);

      this.boundaryPosition
        .copy(this.boundary.center)
        .add(this.boundaryOffset)
        .applyMatrix4(this.boundary.matrix);

      item.body.setTranslation(this.boundaryPosition, true);

      this.boundaryNormal
        .set(
          this.boundaryOffset.x / (radiusX * radiusX),
          this.boundaryOffset.y / (radiusY * radiusY),
          this.boundaryOffset.z / (radiusZ * radiusZ),
        )
        .applyMatrix3(this.boundary.normalMatrix)
        .normalize();

      const velocity = item.body.linvel();

      const outwardSpeed =
        velocity.x * this.boundaryNormal.x +
        velocity.y * this.boundaryNormal.y +
        velocity.z * this.boundaryNormal.z;

      if (outwardSpeed > 0) {
        const reflection =
          (1 + this.config.restitution) * outwardSpeed;

        item.body.setLinvel(
          {
            x: velocity.x - this.boundaryNormal.x * reflection,
            y: velocity.y - this.boundaryNormal.y * reflection,
            z: velocity.z - this.boundaryNormal.z * reflection,
          },
          true,
        );
      }
    }
  }

  syncNodes() {
    for (const { node, body } of this.bodies) {
      const translation = body.translation();
      const rotation = body.rotation();

      node.position.set(
        translation.x,
        translation.y,
        translation.z,
      );

      node.quaternion.set(
        rotation.x,
        rotation.y,
        rotation.z,
        rotation.w,
      );
    }
  }

  update(deltaTime) {
    if (this.phase === "idle") {
      return;
    }

    const maximumAccumulatedTime =
      this.config.fixedTimeStep * this.config.maxSubSteps;

    this.accumulator = Math.min(
      this.accumulator + Math.max(deltaTime, 0),
      maximumAccumulatedTime,
    );

    let substeps = 0;

    while (
      this.accumulator >= this.config.fixedTimeStep &&
      substeps < this.config.maxSubSteps
    ) {
      if (this.phase === "launch") {
        const released = this.updateLaunchStep();

        this.accumulator -= this.config.fixedTimeStep;
        substeps += 1;

        if (released) {
          this.accumulator = 0;
          break;
        }

        continue;
      }

      this.clampBodySpeeds();
      this.world.step();
      this.enforceSphereBoundary();
      this.clampBodySpeeds();
      this.syncNodes();

      this.accumulator -= this.config.fixedTimeStep;
      substeps += 1;
    }
  }

  dispose() {
    this.eventController.abort();
    this.world.free();
    this.bodies.length = 0;
  }
}

export async function createModelPhysics({
  root,
  camera,
  canvas,
  config,
}) {
  await initializeRapier();

  const sphereNode = root.getObjectByName("Sphere");

  if (!sphereNode?.isMesh) {
    throw new Error("В GLB не найден ограничивающий объект Sphere");
  }

  const movingNodes = [];
  const staticNodes = new Set();

  root.traverse((node) => {
    if (STATIC_BASE_NAME_PATTERN.test(node.name)) {
      node.traverse((child) => {
        if (child.isMesh) {
          staticNodes.add(child);
        }
      });
    }

    if (!node.isMesh) {
      return;
    }

    if (
      CLIP_NAME_PATTERN.test(node.name) ||
      BALL_NAME_PATTERN.test(node.name)
    ) {
      movingNodes.push(node);
    }
  });

  if (movingNodes.length === 0) {
    throw new Error("В GLB не найдены объекты clip_low* и ball*");
  }

  return new ModelPhysics({
    root,
    camera,
    canvas,
    config,
    sphereNode,
    movingNodes,
    staticNodes: [...staticNodes],
  });
}
