import RAPIER from "@dimforge/rapier3d-compat";
import * as THREE from "three";

// GLTFLoader removes dots from node names: clip_low.001 becomes clip_low001.
const CLIP_NAME_PATTERN = /^clip_low(?:[._]?\d+)?$/;
const BALL_NAME_PATTERN = /^ball\d+$/;
const STATIC_BASE_NAME_PATTERN = /^static_base(?:_\d+)?$/;
const MIN_POINTER_DELTA_TIME = 1 / 240;
const MAX_POINTER_DELTA_TIME = 0.12;

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
  return box
    .getCenter(new THREE.Vector3())
    .multiply(node.scale);
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
  constructor({ root, camera, canvas, config, sphereNode, movingNodes, staticNodes }) {
    this.root = root;
    this.camera = camera;
    this.canvas = canvas;
    this.config = config;
    this.world = new RAPIER.World(config.gravity);
    this.world.timestep = config.fixedTimeStep;
    this.world.maxCcdSubsteps = config.ccdSubsteps;
    this.boundary = createBoundary(sphereNode);
    this.bodies = [];
    this.accumulator = 0;
    this.elapsedTime = 0;
    this.activeTouchPointerId = null;
    this.lastPointer = null;
    this.rawPointerVelocity = new THREE.Vector2();
    this.smoothedPointerVelocity = new THREE.Vector2();
    this.eventController = new AbortController();

    this.cameraRight = new THREE.Vector3();
    this.cameraUp = new THREE.Vector3();
    this.cameraForward = new THREE.Vector3();
    this.localCameraRight = new THREE.Vector3();
    this.localCameraUp = new THREE.Vector3();
    this.localPointerVelocity = new THREE.Vector3();
    this.localCameraForward = new THREE.Vector3();
    this.bodyPointerVelocity = new THREE.Vector3();
    this.rootWorldQuaternion = new THREE.Quaternion();
    this.force = new THREE.Vector3();
    this.torque = new THREE.Vector3();
    this.impulse = new THREE.Vector3();
    this.torqueImpulse = new THREE.Vector3();
    this.boundaryPosition = new THREE.Vector3();
    this.boundaryOffset = new THREE.Vector3();
    this.boundaryNormal = new THREE.Vector3();

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
    const rawDepthResponse = hashName(`${node.name}:depth`) * 2 - 1;
    const depthResponse =
      Math.sign(rawDepthResponse || 1) *
      (0.35 + Math.abs(rawDepthResponse) * 0.65);

    this.bodies.push({
      node,
      body,
      boundaryRadius: colliderData.boundaryRadius,
      phase: seed * Math.PI * 2,
      frequency: this.config.idleFrequency * (0.8 + seed * 0.4),
      responsiveness: 0.2 + seed * 1.3,
      depthResponse,
      torqueLever: createDeterministicVector(seed, 0.37).multiplyScalar(
        colliderData.boundaryRadius,
      ),
    });
  }

  bindPointerEvents() {
    const options = { signal: this.eventController.signal };

    this.canvas.addEventListener("pointerenter", (event) => {
      if (event.pointerType === "mouse") {
        this.resetPointerSmoothing();
        this.rememberPointer(event);
      }
    }, options);

    this.canvas.addEventListener("pointerdown", (event) => {
      if (!event.isPrimary || event.pointerType === "mouse") {
        return;
      }

      this.activeTouchPointerId = event.pointerId;
      this.canvas.setPointerCapture(event.pointerId);
      this.resetPointerSmoothing();
      this.rememberPointer(event);
    }, options);

    this.canvas.addEventListener("pointermove", (event) => {
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
    }, options);

    this.canvas.addEventListener("pointerleave", (event) => {
      if (event.pointerType === "mouse") {
        this.lastPointer = null;
        this.resetPointerSmoothing();
      }
    }, options);

    const releasePointer = (event) => {
      if (event.pointerId !== this.activeTouchPointerId) {
        return;
      }

      if (this.canvas.hasPointerCapture(event.pointerId)) {
        this.canvas.releasePointerCapture(event.pointerId);
      }

      this.activeTouchPointerId = null;
      this.lastPointer = null;
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
      1 - Math.pow(
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

  updateCameraAxes() {
    this.camera.updateMatrixWorld();
    this.root.updateMatrixWorld();

    this.cameraRight.setFromMatrixColumn(this.camera.matrixWorld, 0);
    this.cameraUp.setFromMatrixColumn(this.camera.matrixWorld, 1);
    this.camera.getWorldDirection(this.cameraForward);
    this.root.getWorldQuaternion(this.rootWorldQuaternion).invert();
    this.localCameraRight
      .copy(this.cameraRight)
      .applyQuaternion(this.rootWorldQuaternion)
      .normalize();
    this.localCameraUp
      .copy(this.cameraUp)
      .applyQuaternion(this.rootWorldQuaternion)
      .normalize();
    this.localCameraForward
      .copy(this.cameraForward)
      .applyQuaternion(this.rootWorldQuaternion)
      .normalize();
  }

  applyPointerVelocity(velocityX, velocityY) {
    this.updateCameraAxes();

    let pointerSpeed = Math.hypot(velocityX, velocityY);
    let pointerScale = 1;
    if (pointerSpeed > this.config.maxPointerVelocity) {
      pointerScale = this.config.maxPointerVelocity / pointerSpeed;
      pointerSpeed = this.config.maxPointerVelocity;
    }

    this.localPointerVelocity
      .copy(this.localCameraRight)
      .multiplyScalar(velocityX * pointerScale)
      .addScaledVector(this.localCameraUp, velocityY * pointerScale);

    for (const item of this.bodies) {
      this.bodyPointerVelocity
        .copy(this.localPointerVelocity)
        .multiplyScalar(
          this.config.pointerVelocityGain * item.responsiveness,
        )
        .addScaledVector(
          this.localCameraForward,
          pointerSpeed * this.config.pointerDepthGain * item.depthResponse,
        );
      this.impulse
        .copy(this.bodyPointerVelocity)
        .multiplyScalar(item.body.mass());
      item.body.applyImpulse(this.impulse, true);

      this.torqueImpulse
        .copy(item.torqueLever)
        .cross(this.impulse)
        .multiplyScalar(this.config.pointerTorqueGain);
      item.body.applyTorqueImpulse(this.torqueImpulse, true);
    }
  }

  applyIdleMotion() {
    for (const item of this.bodies) {
      const time = this.elapsedTime * item.frequency + item.phase;
      const mass = item.body.mass();

      this.force.set(
        Math.sin(time * 0.91),
        Math.sin(time * 1.17 + 2.1),
        Math.sin(time * 0.73 + 4.2) * this.config.idleDepthMultiplier,
      );
      this.force.setLength(this.config.idleAcceleration * mass);

      this.torque.set(
        Math.sin(time * 0.67 + 1.3),
        Math.sin(time * 0.83 + 3.7),
        Math.sin(time * 1.09 + 5.1),
      );
      this.torque.setLength(this.config.idleTorque);

      item.body.resetForces(false);
      item.body.resetTorques(false);
      item.body.addForce(this.force, false);
      item.body.addTorque(this.torque, false);
    }
  }

  clampBodySpeeds() {
    for (const { body, responsiveness } of this.bodies) {
      const linearVelocity = body.linvel();
      const linearSpeed = Math.hypot(
        linearVelocity.x,
        linearVelocity.y,
        linearVelocity.z,
      );
      const maxLinearSpeed =
        this.config.maxLinearSpeed * responsiveness;

      if (linearSpeed > maxLinearSpeed) {
        const scale = maxLinearSpeed / linearSpeed;
        body.setLinvel({
          x: linearVelocity.x * scale,
          y: linearVelocity.y * scale,
          z: linearVelocity.z * scale,
        }, true);
      }

      const angularVelocity = body.angvel();
      const angularSpeed = Math.hypot(
        angularVelocity.x,
        angularVelocity.y,
        angularVelocity.z,
      );

      if (angularSpeed > this.config.maxAngularSpeed) {
        const scale = this.config.maxAngularSpeed / angularSpeed;
        body.setAngvel({
          x: angularVelocity.x * scale,
          y: angularVelocity.y * scale,
          z: angularVelocity.z * scale,
        }, true);
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
        1 - item.boundaryRadius / Math.max(minimumRadius, Number.EPSILON),
      );
      const radiusX = this.boundary.radii.x * safeScale;
      const radiusY = this.boundary.radii.y * safeScale;
      const radiusZ = this.boundary.radii.z * safeScale;

      this.boundaryPosition
        .set(translation.x, translation.y, translation.z)
        .applyMatrix4(this.boundary.inverseMatrix);
      this.boundaryOffset.copy(this.boundaryPosition).sub(this.boundary.center);

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
        const reflection = (1 + this.config.restitution) * outwardSpeed;
        item.body.setLinvel({
          x: velocity.x - this.boundaryNormal.x * reflection,
          y: velocity.y - this.boundaryNormal.y * reflection,
          z: velocity.z - this.boundaryNormal.z * reflection,
        }, true);
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
      this.elapsedTime += this.config.fixedTimeStep;
      this.applyIdleMotion();
      this.clampBodySpeeds();
      this.world.step();
      this.enforceSphereBoundary();
      this.clampBodySpeeds();
      this.accumulator -= this.config.fixedTimeStep;
      substeps += 1;
    }

    this.syncNodes();
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

    if (CLIP_NAME_PATTERN.test(node.name) || BALL_NAME_PATTERN.test(node.name)) {
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
