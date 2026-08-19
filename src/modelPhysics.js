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

const PRESETTLE_MIN_STEPS = 60;
const PRESETTLE_MAX_STEPS = 240;

const MIN_SHAKE_DURATION = 1.1;
const MAX_SHAKE_DURATION = 1.35;
const MIN_LIFT_ACCELERATION = 1.25;
const MAX_LIFT_ACCELERATION = 1.7;
const MIN_SWIRL_ACCELERATION = 0.025;
const MAX_SWIRL_ACCELERATION = 0.05;
const TURBULENCE_ACCELERATION = 0.035;
const CENTERING_ACCELERATION = 0.12;
const CENTERING_START_RADIUS = 0.58;
const MIN_SPIN_TORQUE = 0.004;
const MAX_SPIN_TORQUE = 0.009;

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

  const radius = visualRadius * config.ballColliderScale;

  return {
    descriptor: RAPIER.ColliderDesc.ball(radius),
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
    this.accumulator = 0;

    this.shakeActive = false;
    this.shakeElapsed = 0;
    this.shakeDuration = MAX_SHAKE_DURATION;
    this.shakeStrength = 0;
    this.shakeSerial = 0;
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

    movingNodes.forEach((node) => {
      this.createDynamicBody(node);
    });

    this.preSettleBodies();
    this.syncNodes();
    this.bindPointerEvents();
  }

  createDynamicBody(node) {
    const isBall = BALL_NAME_PATTERN.test(node.name);
    const colliderData = isBall
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
      spinAxis: createDeterministicVector(seed, 0.73),
      noisePhaseX: seed * Math.PI * 2,
      noisePhaseZ: hashName(`${node.name}:noise-z`) * Math.PI * 2,
      noiseFrequency: 1.35 + hashName(`${node.name}:noise-frequency`) * 1.2,
    });
  }

  preSettleBodies() {
    for (let step = 0; step < PRESETTLE_MAX_STEPS; step += 1) {
      this.world.step();
      this.enforceSphereBoundary();
      this.clampBodySpeeds();

      if (
        step >= PRESETTLE_MIN_STEPS &&
        this.bodies.every(({ body }) => body.isSleeping())
      ) {
        break;
      }
    }

    for (const { body } of this.bodies) {
      body.resetForces(false);
      body.resetTorques(false);
      body.setLinvel({ x: 0, y: 0, z: 0 }, false);
      body.setAngvel({ x: 0, y: 0, z: 0 }, false);
      body.sleep();
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

    this.startShake(strength, direction);
  }

  startShake(strength, direction) {
    this.shakeActive = true;
    this.shakeElapsed = 0;
    this.shakeStrength = strength;
    this.shakeSerial += 1;
    this.swirlDirection = direction || 1;

    this.shakeDuration = THREE.MathUtils.lerp(
      MAX_SHAKE_DURATION,
      MIN_SHAKE_DURATION,
      strength,
    );

    for (const { body } of this.bodies) {
      body.resetForces(false);
      body.resetTorques(false);
      body.wakeUp();
    }
  }

  applyShakeForces() {
    this.shakeElapsed = Math.min(
      this.shakeElapsed + this.config.fixedTimeStep,
      this.shakeDuration,
    );

    const progress = THREE.MathUtils.clamp(
      this.shakeElapsed /
        Math.max(this.shakeDuration, Number.EPSILON),
      0,
      1,
    );

    const envelope = Math.sin(Math.PI * progress) ** 1.6;

    const liftAcceleration =
      THREE.MathUtils.lerp(
        MIN_LIFT_ACCELERATION,
        MAX_LIFT_ACCELERATION,
        this.shakeStrength,
      ) * envelope;

    const swirlAcceleration =
      THREE.MathUtils.lerp(
        MIN_SWIRL_ACCELERATION,
        MAX_SWIRL_ACCELERATION,
        this.shakeStrength,
      ) * envelope;

    const spinTorque =
      THREE.MathUtils.lerp(
        MIN_SPIN_TORQUE,
        MAX_SPIN_TORQUE,
        this.shakeStrength,
      ) * envelope;

    for (const item of this.bodies) {
      const { body } = item;
      const position = body.translation();
      const mass = body.mass();

      body.resetForces(false);
      body.resetTorques(false);

      const dx = position.x - this.physicsCenter.x;
      const dz = position.z - this.physicsCenter.z;
      const radialLength = Math.hypot(dx, dz);

      let tangentX = 0;
      let tangentZ = 0;

      if (radialLength > Number.EPSILON) {
        tangentX = -dz / radialLength;
        tangentZ = dx / radialLength;
      }

      const noiseTime =
        this.shakeElapsed * item.noiseFrequency +
        this.shakeSerial * 0.73;

      const noiseX =
        Math.sin(noiseTime + item.noisePhaseX) *
        TURBULENCE_ACCELERATION *
        envelope;

      const noiseZ =
        Math.cos(noiseTime * 0.91 + item.noisePhaseZ) *
        TURBULENCE_ACCELERATION *
        envelope;

      const normalizedX =
        dx / Math.max(this.physicsRadii.x, Number.EPSILON);
      const normalizedZ =
        dz / Math.max(this.physicsRadii.z, Number.EPSILON);
      const normalizedRadius = Math.hypot(normalizedX, normalizedZ);

      let centeringX = 0;
      let centeringZ = 0;

      if (
        normalizedRadius > CENTERING_START_RADIUS &&
        radialLength > Number.EPSILON
      ) {
        const centeringStrength =
          ((normalizedRadius - CENTERING_START_RADIUS) /
            Math.max(1 - CENTERING_START_RADIUS, Number.EPSILON)) *
          CENTERING_ACCELERATION *
          envelope;

        centeringX = (-dx / radialLength) * centeringStrength;
        centeringZ = (-dz / radialLength) * centeringStrength;
      }

      const accelerationX =
        tangentX * swirlAcceleration * this.swirlDirection +
        noiseX +
        centeringX;

      const accelerationZ =
        tangentZ * swirlAcceleration * this.swirlDirection +
        noiseZ +
        centeringZ;

      body.addForce(
        {
          x: accelerationX * mass,
          y: liftAcceleration * mass,
          z: accelerationZ * mass,
        },
        true,
      );

      body.addTorque(
        {
          x: item.spinAxis.x * spinTorque * mass,
          y: item.spinAxis.y * spinTorque * mass,
          z: item.spinAxis.z * spinTorque * mass,
        },
        true,
      );
    }

    if (progress >= 1) {
      this.stopShake();
    }
  }

  stopShake() {
    this.shakeActive = false;
    this.shakeElapsed = 0;

    for (const { body } of this.bodies) {
      body.resetForces(false);
      body.resetTorques(false);
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
      if (this.shakeActive) {
        this.applyShakeForces();
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
