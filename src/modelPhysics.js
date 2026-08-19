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

const PRESETTLE_MIN_STEPS = 120;
const PRESETTLE_MAX_STEPS = 600;
const PRESETTLE_STABLE_STEPS = 30;
const PRESETTLE_LINEAR_SPEED = 0.01;
const PRESETTLE_ANGULAR_SPEED = 0.05;

const DEFAULT_FLUID = {
  drag: 2.2,
  flowDecay: 0.95,
  minimumEnergy: 0.015,
  upwardSpeedMin: 1.05,
  upwardSpeedMax: 1.45,
  swirlSpeedMin: 0.035,
  swirlSpeedMax: 0.075,
  turbulenceSpeed: 0.075,
  returnFlowSpeed: 0.42,
  inwardSpeed: 0.16,
  wallStartRadius: 0.68,
  topSlowdownStart: 0.58,
};

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

  return {
    descriptor: RAPIER.ColliderDesc.cylinder(halfHeight, radius),
    center,
    boundaryRadius:
      center.length() + Math.hypot(visualRadius, visualHalfHeight),
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

  return {
    descriptor: RAPIER.ColliderDesc.ball(
      visualRadius * config.ballColliderScale,
    ),
    center,
    boundaryRadius: center.length() + visualRadius,
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
  constructor({ root, camera, canvas, config, sphereNode, movingNodes, staticNodes }) {
    this.root = root;
    this.camera = camera;
    this.canvas = canvas;
    this.config = config;
    this.fluid = { ...DEFAULT_FLUID, ...(config.fluid ?? {}) };

    this.world = new RAPIER.World(config.gravity);
    this.world.timestep = config.fixedTimeStep;
    this.world.maxCcdSubsteps = config.ccdSubsteps;

    this.boundary = createBoundary(sphereNode);
    this.bodies = [];
    this.accumulator = 0;

    this.fluidEnergy = 0;
    this.fluidAge = 0;
    this.fluidStrength = 0;
    this.swirlDirection = 1;
    this.flowSerial = 0;

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

    this.boundary.matrix.decompose(
      this.matrixPosition,
      this.matrixQuaternion,
      this.matrixScale,
    );

    this.physicsCenter = this.boundary.center
      .clone()
      .applyMatrix4(this.boundary.matrix);

    this.physicsRadii = this.boundary.radii.clone().multiply(
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

    movingNodes.forEach((node) => this.createDynamicBody(node));

    this.preSettleBodies();
    this.syncNodes();
    this.bindPointerEvents();
  }

  createDynamicBody(node) {
    const colliderData = BALL_NAME_PATTERN.test(node.name)
      ? createBallCollider(node, this.config)
      : createClipCollider(node, this.config);

    const bodyDescriptor = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(node.position.x, node.position.y, node.position.z)
      .setRotation({
        x: node.quaternion.x,
        y: node.quaternion.y,
        z: node.quaternion.z,
        w: node.quaternion.w,
      })
      .setLinearDamping(this.config.linearDamping)
      .setAngularDamping(this.config.angularDamping)
      .setCanSleep(true)
      .setCcdEnabled(true);

    const body = this.world.createRigidBody(bodyDescriptor);

    if (typeof body.setAdditionalSolverIterations === "function") {
      body.setAdditionalSolverIterations(
        this.config.additionalSolverIterations ?? 4,
      );
    }

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
      seed,
      boundaryRadius: colliderData.boundaryRadius,
      dragFactor: THREE.MathUtils.lerp(0.88, 1.12, seed),
      turbulenceFactor: THREE.MathUtils.lerp(
        0.75,
        1.2,
        hashName(`${node.name}:turbulence`),
      ),
      phaseX: seed * Math.PI * 2,
      phaseY: hashName(`${node.name}:phase-y`) * Math.PI * 2,
      phaseZ: hashName(`${node.name}:phase-z`) * Math.PI * 2,
      frequency: THREE.MathUtils.lerp(
        0.8,
        1.35,
        hashName(`${node.name}:frequency`),
      ),
    });
  }

  areBodiesSettled() {
    for (const { body } of this.bodies) {
      if (body.isSleeping()) {
        continue;
      }

      const linearVelocity = body.linvel();
      const angularVelocity = body.angvel();
      const linearSpeed = Math.hypot(
        linearVelocity.x,
        linearVelocity.y,
        linearVelocity.z,
      );
      const angularSpeed = Math.hypot(
        angularVelocity.x,
        angularVelocity.y,
        angularVelocity.z,
      );

      if (
        linearSpeed > PRESETTLE_LINEAR_SPEED ||
        angularSpeed > PRESETTLE_ANGULAR_SPEED
      ) {
        return false;
      }
    }

    return true;
  }

  preSettleBodies() {
    let stableSteps = 0;

    for (let step = 0; step < PRESETTLE_MAX_STEPS; step += 1) {
      this.applyFluidForces(false);
      this.clampBodySpeeds();
      this.world.step();
      this.enforceSphereBoundary();
      this.clampBodySpeeds();

      if (step < PRESETTLE_MIN_STEPS) {
        continue;
      }

      if (this.areBodiesSettled()) {
        stableSteps += 1;
        if (stableSteps >= PRESETTLE_STABLE_STEPS) {
          break;
        }
      } else {
        stableSteps = 0;
      }
    }

    for (const { body } of this.bodies) {
      body.resetForces(false);
      body.resetTorques(false);
    }
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

    if (!this.gestureArmed || gestureSpeed < GESTURE_THRESHOLD) {
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

    this.startFluidMotion(strength, direction);
  }

  startFluidMotion(strength, direction) {
    this.fluidStrength = strength;
    this.fluidEnergy = Math.max(
      this.fluidEnergy * 0.55,
      THREE.MathUtils.lerp(0.72, 1, strength),
    );
    this.fluidAge = 0;
    this.flowSerial += 1;
    this.swirlDirection = direction || 1;

    for (const { body } of this.bodies) {
      body.wakeUp();
    }
  }

  getFluidVelocity(item, position, allowFlow) {
    if (!allowFlow || this.fluidEnergy <= 0) {
      return { x: 0, y: 0, z: 0 };
    }

    const dx = position.x - this.physicsCenter.x;
    const dy = position.y - this.physicsCenter.y;
    const dz = position.z - this.physicsCenter.z;

    const radiusX = Math.max(this.physicsRadii.x, Number.EPSILON);
    const radiusY = Math.max(this.physicsRadii.y, Number.EPSILON);
    const radiusZ = Math.max(this.physicsRadii.z, Number.EPSILON);

    const normalizedX = dx / radiusX;
    const normalizedY = dy / radiusY;
    const normalizedZ = dz / radiusZ;
    const normalizedRadius = Math.hypot(normalizedX, normalizedZ);
    const radialLength = Math.hypot(dx, dz);

    const wallFactor = THREE.MathUtils.smoothstep(
      normalizedRadius,
      this.fluid.wallStartRadius,
      1,
    );

    const topFactor = THREE.MathUtils.smoothstep(
      normalizedY,
      this.fluid.topSlowdownStart,
      1,
    );

    const upwardBase = THREE.MathUtils.lerp(
      this.fluid.upwardSpeedMin,
      this.fluid.upwardSpeedMax,
      this.fluidStrength,
    );

    const upwardFlow = upwardBase * (1 - 0.45 * wallFactor) * (1 - topFactor);
    const returnFlow = this.fluid.returnFlowSpeed * wallFactor;

    let tangentX = 0;
    let tangentZ = 0;
    let inwardX = 0;
    let inwardZ = 0;

    if (radialLength > Number.EPSILON) {
      tangentX = -dz / radialLength;
      tangentZ = dx / radialLength;
      inwardX = -dx / radialLength;
      inwardZ = -dz / radialLength;
    }

    const swirlSpeed = THREE.MathUtils.lerp(
      this.fluid.swirlSpeedMin,
      this.fluid.swirlSpeedMax,
      this.fluidStrength,
    );

    const time = this.fluidAge * item.frequency + this.flowSerial * 0.67;
    const turbulence =
      this.fluid.turbulenceSpeed * item.turbulenceFactor;

    const turbulenceX =
      Math.sin(time + item.phaseX + normalizedY * 2.1) * turbulence;
    const turbulenceY =
      Math.sin(time * 0.71 + item.phaseY + normalizedX * 1.7) *
      turbulence *
      0.28;
    const turbulenceZ =
      Math.cos(time * 0.89 + item.phaseZ + normalizedY * 1.9) * turbulence;

    const energy = this.fluidEnergy;

    return {
      x:
        (tangentX * swirlSpeed * this.swirlDirection +
          inwardX * this.fluid.inwardSpeed * wallFactor +
          turbulenceX) *
        energy,
      y: (upwardFlow - returnFlow + turbulenceY) * energy,
      z:
        (tangentZ * swirlSpeed * this.swirlDirection +
          inwardZ * this.fluid.inwardSpeed * wallFactor +
          turbulenceZ) *
        energy,
    };
  }

  applyFluidForces(allowFlow = true) {
    const flowActive =
      allowFlow && this.fluidEnergy > this.fluid.minimumEnergy;

    for (const item of this.bodies) {
      const { body } = item;

      if (body.isSleeping() && !flowActive) {
        continue;
      }

      if (flowActive && body.isSleeping()) {
        body.wakeUp();
      }

      const position = body.translation();
      const velocity = body.linvel();
      const fluidVelocity = this.getFluidVelocity(
        item,
        position,
        flowActive,
      );
      const mass = body.mass();
      const drag = this.fluid.drag * item.dragFactor;

      body.resetForces(false);
      body.resetTorques(false);

      body.addForce(
        {
          x: (fluidVelocity.x - velocity.x) * drag * mass,
          y: (fluidVelocity.y - velocity.y) * drag * mass,
          z: (fluidVelocity.z - velocity.z) * drag * mass,
        },
        false,
      );
    }
  }

  updateFluidState() {
    if (this.fluidEnergy <= 0) {
      return;
    }

    this.fluidAge += this.config.fixedTimeStep;
    this.fluidEnergy *= Math.exp(
      -this.fluid.flowDecay * this.config.fixedTimeStep,
    );

    if (this.fluidEnergy < this.fluid.minimumEnergy) {
      this.fluidEnergy = 0;
    }
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

      node.position.set(translation.x, translation.y, translation.z);
      node.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
    }
  }

  update(deltaTime) {
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
      this.applyFluidForces(true);
      this.clampBodySpeeds();
      this.world.step();
      this.enforceSphereBoundary();
      this.clampBodySpeeds();
      this.syncNodes();
      this.updateFluidState();

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

export async function createModelPhysics({ root, camera, canvas, config }) {
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
