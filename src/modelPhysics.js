import RAPIER from "@dimforge/rapier3d-compat";
import * as THREE from "three";

// GLTFLoader removes dots from node names: clip_low.001 becomes clip_low001.
const CLIP_NAME_PATTERN = /^clip_low(?:[._]?\d+)?$/;
const BALL_NAME_PATTERN = /^ball\d+$/;
const STATIC_BASE_NAME_PATTERN = /^static_base(?:_\d+)?$/;
const MIN_POINTER_DELTA_TIME = 1 / 240;
const ENVIRONMENT_COLLISION_GROUPS = 0x00010006;
const MOVING_COLLISION_GROUPS = 0x00020001;
const BALL_COLLISION_GROUPS = 0x00040005;

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

function createRandomHorizontalVector(upAxis) {
  const vector = new THREE.Vector3(
    Math.random() * 2 - 1,
    Math.random() * 2 - 1,
    Math.random() * 2 - 1,
  );

  vector.addScaledVector(upAxis, -vector.dot(upAxis));

  if (vector.lengthSq() < Number.EPSILON) {
    vector.set(1, 0, 0);
    vector.addScaledVector(upAxis, -vector.dot(upAxis));

    if (vector.lengthSq() < Number.EPSILON) {
      vector.set(0, 0, 1);
      vector.addScaledVector(upAxis, -vector.dot(upAxis));
    }
  }

  return vector.normalize();
}

function randomFloat(min, max) {
  return THREE.MathUtils.lerp(min, max, Math.random());
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

function getRootLocalBounds(mesh, rootInverseWorldMatrix) {
  const box = getGeometryBox(mesh.geometry);
  const rootLocalMatrix = new THREE.Matrix4().multiplyMatrices(
    rootInverseWorldMatrix,
    mesh.matrixWorld,
  );

  return box.clone().applyMatrix4(rootLocalMatrix);
}

function createStaticTrimesh(
  world,
  mesh,
  rootInverseWorldMatrix,
  restitution,
  friction,
  contactSkin = 0,
) {
  const { vertices, indices } = createTrimeshData(
    mesh,
    rootInverseWorldMatrix,
  );
  const collider = RAPIER.ColliderDesc.trimesh(
    vertices,
    indices,
    RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES,
  )
    .setFriction(friction)
    .setRestitution(restitution)
    .setContactSkin(contactSkin)
    .setCollisionGroups(ENVIRONMENT_COLLISION_GROUPS)
    .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Min);

  return world.createCollider(collider);
}

function createStaticBaseCuboid(
  world,
  mesh,
  rootInverseWorldMatrix,
  restitution,
  friction,
  thickness,
  contactSkin,
) {
  const bounds = getRootLocalBounds(mesh, rootInverseWorldMatrix);
  const size = bounds.getSize(new THREE.Vector3());
  const halfHeight = Math.max(size.y * 0.5, thickness * 0.5);
  const center = bounds.getCenter(new THREE.Vector3());

  // Keep the rendered upper surface aligned while extending the collider down.
  center.y = bounds.max.y - halfHeight;

  const collider = RAPIER.ColliderDesc.cuboid(
    size.x * 0.5,
    halfHeight,
    size.z * 0.5,
  )
    .setTranslation(center.x, center.y, center.z)
    .setFriction(friction)
    .setRestitution(restitution)
    .setContactSkin(contactSkin)
    .setCollisionGroups(ENVIRONMENT_COLLISION_GROUPS)
    .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Min);

  return world.createCollider(collider);
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

class ModelPhysics {
  constructor({
    root,
    camera,
    canvas,
    config,
    sphereColliderNode,
    movingNodes,
    staticNodes,
    staticBaseColliderNodes = new Set(),
  }) {
    this.root = root;
    this.camera = camera;
    this.canvas = canvas;
    this.config = config;
    this.world = new RAPIER.World(config.gravity);
    this.world.timestep = config.fixedTimeStep;
    this.world.maxCcdSubsteps = config.ccdSubsteps;
    this.bodies = [];
    this.floorColliderHandles = new Set();
    this.accumulator = 0;
    this.elapsedTime = 0;
    this.vortexEnergy = 0;
    this.settleCheckAccumulator = 0;
    this.physicsActivated = false;
    this.activeBodyCount = 0;
    this.pendingLaunch = null;
    this.pendingPointerImpulse = null;
    this.interactionBatchCycle = 0;
    this.stepCostEstimateMs = 0;
    this.performanceSnapshot = {
      activeBodies: 0,
      droppedTimeMs: 0,
      queuedBodies: 0,
      substeps: 0,
      worldStepMs: 0,
    };
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
    this.localCameraForward = new THREE.Vector3();
    this.rootWorldQuaternion = new THREE.Quaternion();
    this.pointerPlanarVelocity = new THREE.Vector3();
    this.pointerForwardDirection = new THREE.Vector3();
    this.pointerSpeed = 0;
    this.bodyPointerVelocity = new THREE.Vector3();
    this.pointerImpulse = new THREE.Vector3();
    this.pointerTorqueImpulse = new THREE.Vector3();
    this.bodyLaunchVelocity = new THREE.Vector3();
    this.bodyLaunchAngularVelocity = new THREE.Vector3();
    this.bodyTranslation = new THREE.Vector3();
    this.bodyRotation = new THREE.Quaternion();
    this.bodyAngularVelocity = new THREE.Vector3();
    this.zeroVelocity = new THREE.Vector3();
    this.fluidForce = new THREE.Vector3();
    this.flowVelocity = new THREE.Vector3();
    this.bodyVelocity = new THREE.Vector3();
    this.radialOffset = new THREE.Vector3();
    this.radialDirection = new THREE.Vector3();
    this.tangentDirection = new THREE.Vector3();
    this.fallDriftForce = new THREE.Vector3();
    this.upAxis = new THREE.Vector3(
      -config.gravity.x,
      -config.gravity.y,
      -config.gravity.z,
    ).normalize();

    root.updateMatrixWorld(true);
    const rootInverseWorldMatrix = root.matrixWorld.clone().invert();
    const sphereBounds = getRootLocalBounds(
      sphereColliderNode,
      rootInverseWorldMatrix,
    );
    const sphereSize = sphereBounds.getSize(new THREE.Vector3());
    this.vortexCenter = sphereBounds.getCenter(new THREE.Vector3());
    this.vortexRadius = Math.max(sphereSize.x, sphereSize.z) * 0.5;

    createStaticTrimesh(
      this.world,
      sphereColliderNode,
      rootInverseWorldMatrix,
      config.boundaryRestitution,
      config.friction,
      config.sphereContactSkin,
    );
    staticNodes.forEach((node) => {
      const collider = staticBaseColliderNodes.has(node)
        ? createStaticBaseCuboid(
            this.world,
            node,
            rootInverseWorldMatrix,
            config.staticRestitution,
            config.floorFriction,
            config.staticBaseColliderThickness,
            config.staticBaseColliderContactSkin,
          )
        : createStaticTrimesh(
            this.world,
            node,
            rootInverseWorldMatrix,
            config.staticRestitution,
            config.floorFriction,
          );
      this.floorColliderHandles.add(collider.handle);
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
      .setGravityScale(1)
      .setLinearDamping(this.config.linearDamping)
      .setAngularDamping(this.config.angularDamping)
      .setCanSleep(false)
      .setEnabled(false)
      .setCcdEnabled(
        isBall
          ? this.config.ballCcdEnabled ?? true
          : this.config.clipCcdEnabled ?? true,
      )
      .setAdditionalSolverIterations(this.config.additionalSolverIterations);
    const body = this.world.createRigidBody(bodyDescriptor);

    colliderData.descriptor
      .setTranslation(
        colliderData.center.x,
        colliderData.center.y,
        colliderData.center.z,
      )
      .setMass(colliderData.mass)
      .setFriction(this.config.friction)
      .setRestitution(this.config.restitution)
      .setCollisionGroups(
        isBall ? BALL_COLLISION_GROUPS : MOVING_COLLISION_GROUPS,
      );

    const collider = this.world.createCollider(colliderData.descriptor, body);

    const seed = hashName(node.name);
    const rawPointerDepthResponse =
      hashName(`${node.name}:pointer-depth`) * 2 - 1;
    const vortexGroup = hashName(`${node.name}:vortex-group`);
    const usesPrimaryVortex =
      vortexGroup < this.config.primaryVortexFraction;
    const usesReverseVortex =
      !usesPrimaryVortex &&
      vortexGroup <
        this.config.primaryVortexFraction +
          this.config.reverseVortexFraction;
    const swirlDirection = usesPrimaryVortex
      ? 1
      : usesReverseVortex
        ? -1
        : 0;
    const vortexOffset = createDeterministicVector(
      hashName(`${node.name}:vortex-center`),
      0.19,
    );
    vortexOffset
      .addScaledVector(this.upAxis, -vortexOffset.dot(this.upAxis))
      .normalize()
      .multiplyScalar(
        this.config.vortexCenterJitter *
          hashName(`${node.name}:vortex-radius`),
      );

    this.bodies.push({
      node,
      body,
      collider,
      isBall,
      enabled: false,
      launchOrder: hashName(`${node.name}:launch-order`),
      mass: colliderData.mass,
      pointerResponsiveness: 0.2 + seed * 1.3,
      pointerDepthResponse:
        Math.sign(rawPointerDepthResponse || 1) *
        (0.35 + Math.abs(rawPointerDepthResponse) * 0.65),
      pointerTorqueLever: createDeterministicVector(
        seed,
        0.37,
      ).multiplyScalar(colliderData.boundaryRadius),
      settled: false,
      settleTime: 0,
      fallStarted: false,
      fallGravityScale: 1,
      fallLinearDamping: this.config.linearDamping,
      fallDriftStrength: 1,
      fallDriftDirection: new THREE.Vector3(1, 0, 0),
      responsiveness: THREE.MathUtils.lerp(
        this.config.launchResponsivenessMin,
        this.config.launchResponsivenessMax,
        seed,
      ),
      launchRadialFactor: THREE.MathUtils.lerp(
        -1,
        1,
        hashName(`${node.name}:radial`),
      ),
      swirlDirection,
      swirlResponse: THREE.MathUtils.lerp(
        0.55,
        1.45,
        hashName(`${node.name}:swirl`),
      ),
      vortexResponse:
        swirlDirection === 0
          ? 0
          : THREE.MathUtils.lerp(
              0.45,
              1.35,
              hashName(`${node.name}:vortex-response`),
            ),
      turbulenceResponse:
        swirlDirection === 0
          ? this.config.chaoticTurbulenceMultiplier
          : 1,
      vortexOffset,
      flowPhaseX: seed * Math.PI * 2,
      flowPhaseY: hashName(`${node.name}:phase-y`) * Math.PI * 2,
      flowPhaseZ: hashName(`${node.name}:phase-z`) * Math.PI * 2,
      flowFrequencyX: THREE.MathUtils.lerp(
        this.config.turbulenceFrequencyMin,
        this.config.turbulenceFrequencyMax,
        hashName(`${node.name}:frequency-x`),
      ),
      flowFrequencyY: THREE.MathUtils.lerp(
        this.config.turbulenceFrequencyMin,
        this.config.turbulenceFrequencyMax,
        hashName(`${node.name}:frequency-y`),
      ),
      flowFrequencyZ: THREE.MathUtils.lerp(
        this.config.turbulenceFrequencyMin,
        this.config.turbulenceFrequencyMax,
        hashName(`${node.name}:frequency-z`),
      ),
      flowStrength: THREE.MathUtils.lerp(
        0.75,
        1.25,
        hashName(`${node.name}:strength`),
      ),
      launchDrift: createDeterministicVector(seed, 0.71),
      spinAxis: createDeterministicVector(
        hashName(`${node.name}:spin-axis`),
        0.47,
      ),
      spinDirection:
        hashName(`${node.name}:spin-direction`) < 0.5 ? -1 : 1,
      spinSpeed: THREE.MathUtils.lerp(
        this.config.launchSpinSpeedMin,
        this.config.launchSpinSpeedMax,
        hashName(`${node.name}:spin-speed`),
      ),
    });

    this.initializeFallProfile(this.bodies[this.bodies.length - 1]);
  }

  initializeFallProfile(item) {
    const weightRatio = item.isBall ? 1 : Math.random();
    const mass = item.isBall
      ? this.config.ballMass
      : this.config.clipMass *
        THREE.MathUtils.lerp(
          this.config.clipMassFactorMin,
          this.config.clipMassFactorMax,
          weightRatio,
        );

    item.collider.setMass(mass);
    item.body.recomputeMassPropertiesFromColliders();
    item.mass = mass;
    item.body.setGravityScale(1, false);
    item.body.setLinearDamping(this.config.linearDamping);

    const fallSpeedMultiplier = THREE.MathUtils.clamp(
      this.config.fallSpeedMultiplier ?? 1,
      0.05,
      2,
    );
    item.fallGravityScale =
      (item.isBall
        ? this.config.ballFallGravityScale
        : THREE.MathUtils.lerp(
            this.config.fallGravityScaleMin,
            this.config.fallGravityScaleMax,
            weightRatio,
          )) * fallSpeedMultiplier;
    item.fallLinearDamping = item.isBall
      ? this.config.ballFallLinearDamping
      : THREE.MathUtils.lerp(
          this.config.fallLinearDampingMax,
          this.config.fallLinearDampingMin,
          weightRatio,
        );
    item.fallDriftStrength = randomFloat(
      this.config.fallDriftStrengthMin,
      this.config.fallDriftStrengthMax,
    );
    item.fallDriftDirection.copy(createRandomHorizontalVector(this.upAxis));
    item.fallStarted = false;
  }

  resetFallState(item) {
    item.body.setGravityScale(1, false);
    item.body.setLinearDamping(this.config.linearDamping);
    item.body.setAngularDamping(
      this.config.flightAngularDamping ?? this.config.angularDamping,
    );
    item.fallStarted = false;
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
    const coalescedEvents = event.getCoalescedEvents?.();
    const samples = coalescedEvents?.length ? coalescedEvents : [event];

    for (const sample of samples) {
      this.processPointerSample(sample);
    }
  }

  processPointerSample(event) {
    if (!this.lastPointer) {
      this.resetPointerSmoothing();
      this.rememberPointer(event);
      return;
    }

    const deltaTime = (event.timeStamp - this.lastPointer.time) / 1000;
    const maximumDeltaTime = Math.max(
      this.config.pointerMaxDeltaTime ?? 0.12,
      MIN_POINTER_DELTA_TIME,
    );

    if (deltaTime <= 0 || deltaTime > maximumDeltaTime) {
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
    let pointerSpeed = Math.hypot(velocityX, velocityY);
    if (pointerSpeed <= Number.EPSILON) {
      return;
    }

    let pointerScale = 1;
    if (pointerSpeed > this.config.maxPointerVelocity) {
      pointerScale = this.config.maxPointerVelocity / pointerSpeed;
      pointerSpeed = this.config.maxPointerVelocity;
    }

    this.updateCameraAxes();
    this.pointerPlanarVelocity
      .copy(this.localCameraRight)
      .multiplyScalar(velocityX * pointerScale)
      .addScaledVector(this.localCameraUp, velocityY * pointerScale);
    this.pointerForwardDirection.copy(this.localCameraForward);
    this.pointerSpeed = pointerSpeed;

    this.physicsActivated = true;
    this.vortexEnergy = 1;
    this.settleCheckAccumulator = 0;

    if (this.pendingPointerImpulse || this.bodies.length === 0) {
      return;
    }

    this.pendingPointerImpulse = this.createPendingBodyBatch();
  }

  applyPointerImpulseToBody(item) {
    const wasActive = item.enabled && !item.settled;
    const shouldResetFlight = !item.enabled || item.settled;

    if (!item.enabled) {
      item.body.setEnabled(true);
      item.enabled = true;
    }

    item.settled = false;
    item.settleTime = 0;
    if (!wasActive) {
      this.activeBodyCount += 1;
    }
    if (shouldResetFlight) {
      this.resetFallState(item);
    }

    this.bodyPointerVelocity
      .copy(this.pointerPlanarVelocity)
      .multiplyScalar(
        this.config.pointerVelocityGain * item.pointerResponsiveness,
      )
      .addScaledVector(
        this.pointerForwardDirection,
        this.pointerSpeed *
          this.config.pointerDepthGain *
          item.pointerDepthResponse,
      );
    this.pointerImpulse
      .copy(this.bodyPointerVelocity)
      .multiplyScalar(item.mass);
    item.body.applyImpulse(this.pointerImpulse, true);

    this.pointerTorqueImpulse
      .copy(item.pointerTorqueLever)
      .cross(this.pointerImpulse)
      .multiplyScalar(this.config.pointerTorqueGain);
    item.body.applyTorqueImpulse(this.pointerTorqueImpulse, true);
  }

  processPendingPointerImpulseBatch() {
    const pendingPointerImpulse = this.pendingPointerImpulse;
    if (!pendingPointerImpulse) {
      return;
    }

    const endIndex = Math.min(
      pendingPointerImpulse.nextIndex + pendingPointerImpulse.batchSize,
      pendingPointerImpulse.items.length,
    );

    for (
      let index = pendingPointerImpulse.nextIndex;
      index < endIndex;
      index += 1
    ) {
      this.applyPointerImpulseToBody(pendingPointerImpulse.items[index]);
    }

    pendingPointerImpulse.nextIndex = endIndex;
    if (
      pendingPointerImpulse.nextIndex >= pendingPointerImpulse.items.length
    ) {
      this.pendingPointerImpulse = null;
    }
  }

  applyShake({ strength = 1 } = {}) {
    const safeStrength = THREE.MathUtils.clamp(
      Number.isFinite(strength) ? strength : 1,
      0.35,
      1,
    );
    const shakeUpwardSpeed = THREE.MathUtils.lerp(
      this.config.launchMinSpeed,
      this.config.launchMaxSpeed,
      safeStrength,
    );
    this.launchBodies(shakeUpwardSpeed);
  }

  createLaunchProfile(upwardSpeed) {
    const launchSpeed = Math.min(upwardSpeed, this.config.launchMaxSpeed);
    const gestureStrength = THREE.MathUtils.clamp(
      (launchSpeed - this.config.launchMinSpeed) /
        Math.max(
          this.config.launchMaxSpeed - this.config.launchMinSpeed,
          Number.EPSILON,
        ),
      0,
      1,
    );
    const baseLaunchVelocity = THREE.MathUtils.lerp(
      this.config.launchVelocityMin,
      this.config.launchVelocityMax,
      gestureStrength,
    );

    return { baseLaunchVelocity, gestureStrength, launchSpeed };
  }

  launchBody(item, profile, shouldLift) {
    const wasActive = item.enabled && !item.settled;

    if (!item.enabled) {
      item.body.setEnabled(true);
      item.enabled = true;
    }

    item.settled = false;
    item.settleTime = 0;
    if (!wasActive) {
      this.activeBodyCount += 1;
    }

    if (shouldLift) {
      this.resetFallState(item);
    } else {
      item.body.resetForces(false);
      item.body.resetTorques(false);
    }

    const targetUpwardVelocity =
      profile.baseLaunchVelocity * item.responsiveness;

    item.body.translation(this.bodyTranslation);

    this.radialOffset
      .copy(this.bodyTranslation)
      .sub(this.vortexCenter)
      .sub(item.vortexOffset)
      .addScaledVector(
        this.upAxis,
        -this.radialOffset.dot(this.upAxis),
      );

    if (this.radialOffset.lengthSq() < Number.EPSILON) {
      this.radialOffset
        .copy(item.launchDrift)
        .addScaledVector(
          this.upAxis,
          -item.launchDrift.dot(this.upAxis),
        );
    }

    this.radialDirection.copy(this.radialOffset).normalize();
    this.tangentDirection
      .crossVectors(this.upAxis, this.radialDirection)
      .normalize();

    if (shouldLift) {
      this.bodyLaunchVelocity
        .copy(item.launchDrift)
        .addScaledVector(
          this.upAxis,
          -item.launchDrift.dot(this.upAxis),
        )
        .normalize()
        .multiplyScalar(this.config.launchSpread)
        .addScaledVector(
          this.radialDirection,
          this.config.launchRadialVelocity * item.launchRadialFactor,
        )
        .addScaledVector(
          this.tangentDirection,
          this.config.launchSwirlVelocity *
            item.swirlResponse *
            item.swirlDirection,
        )
        .addScaledVector(this.upAxis, targetUpwardVelocity);
    } else {
      item.body.linvel(this.bodyVelocity);
      this.bodyLaunchVelocity
        .copy(this.bodyVelocity)
        .addScaledVector(
          this.tangentDirection,
          this.config.launchSwirlVelocity *
            item.swirlResponse *
            item.swirlDirection,
        )
        .addScaledVector(
          this.radialDirection,
          this.config.launchRadialVelocity *
            0.35 *
            item.launchRadialFactor,
        )
        .addScaledVector(
          this.upAxis,
          this.config.repeatLiftVelocity,
        );
    }

    item.body.setLinvel(this.bodyLaunchVelocity, true);
    const spinSpeed =
      item.spinSpeed *
      THREE.MathUtils.lerp(0.85, 1.15, profile.gestureStrength);
    this.bodyLaunchAngularVelocity
      .copy(item.spinAxis)
      .multiplyScalar(spinSpeed * item.spinDirection);
    item.body.setAngvel(this.bodyLaunchAngularVelocity, false);
  }

  createPendingBodyBatch() {
    const batchFrames = Math.max(
      Math.floor(this.config.launchBatchFrames ?? 1),
      1,
    );
    const items = [...this.bodies].sort(
      (left, right) => left.launchOrder - right.launchOrder,
    );
    const batchSize = Math.ceil(items.length / batchFrames);
    const startIndex =
      (this.interactionBatchCycle * batchSize) % items.length;

    if (startIndex > 0) {
      items.push(...items.splice(0, startIndex));
    }

    this.interactionBatchCycle =
      (this.interactionBatchCycle + 1) % batchFrames;

    return {
      batchSize,
      items,
      nextIndex: 0,
    };
  }

  processPendingLaunchBatch() {
    const pendingLaunch = this.pendingLaunch;
    if (!pendingLaunch) {
      return;
    }

    const endIndex = Math.min(
      pendingLaunch.nextIndex + pendingLaunch.batchSize,
      pendingLaunch.items.length,
    );

    for (
      let index = pendingLaunch.nextIndex;
      index < endIndex;
      index += 1
    ) {
      const item = pendingLaunch.items[index];
      const shouldLift = !item.enabled || item.settled;
      this.launchBody(item, pendingLaunch.profile, shouldLift);
    }

    pendingLaunch.nextIndex = endIndex;
    if (pendingLaunch.nextIndex >= pendingLaunch.items.length) {
      this.pendingLaunch = null;
    }
  }

  launchBodies(upwardSpeed) {
    this.physicsActivated = true;
    this.vortexEnergy = 1;
    this.settleCheckAccumulator = 0;

    const profile = this.createLaunchProfile(upwardSpeed);
    if (this.bodies.length === 0) {
      return;
    }

    const pendingProfile = this.pendingLaunch?.profile;
    const strongestProfile =
      pendingProfile?.launchSpeed > profile.launchSpeed
        ? pendingProfile
        : profile;
    if (this.pendingLaunch) {
      this.pendingLaunch.profile = strongestProfile;
      return;
    }

    this.pendingLaunch = {
      ...this.createPendingBodyBatch(),
      profile: strongestProfile,
    };
  }

  clampBodySpeeds() {
    for (const { body, enabled, settled } of this.bodies) {
      if (!enabled || settled) {
        continue;
      }

      body.linvel(this.bodyVelocity);
      const linearSpeed = Math.hypot(
        this.bodyVelocity.x,
        this.bodyVelocity.y,
        this.bodyVelocity.z,
      );
      const maxLinearSpeed = this.config.maxLinearSpeed;

      if (linearSpeed > maxLinearSpeed) {
        const scale = maxLinearSpeed / linearSpeed;
        this.bodyVelocity.multiplyScalar(scale);
        body.setLinvel(this.bodyVelocity, true);
      }

      body.angvel(this.bodyAngularVelocity);
      const angularSpeed = Math.hypot(
        this.bodyAngularVelocity.x,
        this.bodyAngularVelocity.y,
        this.bodyAngularVelocity.z,
      );

      if (angularSpeed > this.config.maxAngularSpeed) {
        const scale = this.config.maxAngularSpeed / angularSpeed;
        this.bodyAngularVelocity.multiplyScalar(scale);
        body.setAngvel(this.bodyAngularVelocity, true);
      }
    }
  }

  applyFluidMotion(deltaTime) {
    const vortexEnergy = this.vortexEnergy;
    const coreRadius = Math.max(
      this.vortexRadius * this.config.vortexCoreRatio,
      Number.EPSILON,
    );
    const vortexActive = vortexEnergy > 0.01;

    for (const item of this.bodies) {
      if (!item.enabled || item.settled) {
        continue;
      }

      item.body.linvel(this.bodyVelocity);
      const verticalVelocity =
        this.bodyVelocity.x * this.upAxis.x +
        this.bodyVelocity.y * this.upAxis.y +
        this.bodyVelocity.z * this.upAxis.z;

      if (!item.fallStarted && verticalVelocity <= 0) {
        item.fallStarted = true;
        item.body.setGravityScale(item.fallGravityScale, true);
        item.body.setLinearDamping(item.fallLinearDamping);
      }

      const hasCustomForce = vortexActive || item.fallStarted;
      if (!hasCustomForce) {
        continue;
      }

      this.fluidForce.set(0, 0, 0);

      if (vortexActive) {
        const acceleration =
          this.config.turbulenceAcceleration *
          item.flowStrength *
          item.turbulenceResponse *
          vortexEnergy;

        this.fluidForce
          .set(
            Math.sin(
              this.elapsedTime * item.flowFrequencyX + item.flowPhaseX,
            ),
            Math.sin(
              this.elapsedTime * item.flowFrequencyY + item.flowPhaseY,
            ) * this.config.verticalTurbulenceRatio,
            Math.cos(
              this.elapsedTime * item.flowFrequencyZ + item.flowPhaseZ,
            ),
          )
          .multiplyScalar(acceleration * item.mass);

        item.body.translation(this.bodyTranslation);
        this.radialOffset
          .copy(this.bodyTranslation)
          .sub(this.vortexCenter)
          .sub(item.vortexOffset)
          .addScaledVector(
            this.upAxis,
            -this.radialOffset.dot(this.upAxis),
          );

        const radialDistance = this.radialOffset.length();
        const radialRatio = THREE.MathUtils.clamp(
          radialDistance / this.vortexRadius,
          0,
          1,
        );
        this.radialDirection.set(0, 0, 0);
        if (radialDistance > Number.EPSILON) {
          this.radialDirection
            .copy(this.radialOffset)
            .multiplyScalar(1 / radialDistance);
        }

        if (this.radialDirection.lengthSq() > Number.EPSILON) {
          this.tangentDirection
            .crossVectors(this.upAxis, this.radialDirection)
            .normalize();

          const radialProfile =
            radialDistance <= coreRadius
              ? radialDistance / coreRadius
              : coreRadius / radialDistance;
          const tangentialSpeed = this.config.vortexTangentialSpeed;
          const vortexResponse = item.vortexResponse;
          const swirlDirection = item.swirlDirection;
          const targetTangentialSpeed =
            tangentialSpeed *
            radialProfile *
            vortexEnergy *
            vortexResponse *
            swirlDirection;

          this.bodyVelocity
            .addScaledVector(
              this.upAxis,
              -(
                this.bodyVelocity.x * this.upAxis.x +
                this.bodyVelocity.y * this.upAxis.y +
                this.bodyVelocity.z * this.upAxis.z
              ),
            );
          this.flowVelocity
            .copy(this.tangentDirection)
            .multiplyScalar(targetTangentialSpeed)
            .sub(this.bodyVelocity)
            .multiplyScalar(
              this.config.vortexFlowCoupling *
                vortexEnergy *
                vortexResponse *
                item.mass,
          );
          this.fluidForce.add(this.flowVelocity);
          this.fluidForce.addScaledVector(
            this.radialDirection,
            -this.config.vortexInwardAcceleration *
              vortexEnergy *
              item.mass,
          );
        }

        const liftRatio = THREE.MathUtils.lerp(
          1,
          this.config.vortexMinimumLiftRatio,
          radialRatio,
        );
        this.fluidForce.addScaledVector(
          this.upAxis,
          this.config.vortexLiftAcceleration *
            liftRatio *
            vortexEnergy *
            item.mass,
        );
      }

      if (item.fallStarted) {
        const driftPulse =
          0.75 +
          0.25 *
            Math.sin(
              this.elapsedTime * item.flowFrequencyX + item.flowPhaseX,
            );
        this.fallDriftForce
          .copy(item.fallDriftDirection)
          .multiplyScalar(
            this.config.fallDriftAcceleration *
              item.fallDriftStrength *
              driftPulse *
              item.mass,
          );
        this.fluidForce.add(this.fallDriftForce);
      }

      item.body.resetForces(false);
      item.body.addForce(this.fluidForce, false);
    }

    this.vortexEnergy *= Math.exp(
      -this.config.vortexDecayRate * deltaTime,
    );
    if (this.vortexEnergy < 0.01) {
      this.vortexEnergy = 0;
    }
  }

  isTouchingFloor(item) {
    let touchingFloor = false;

    this.world.contactPairsWith(item.collider, (otherCollider) => {
      if (this.floorColliderHandles.has(otherCollider.handle)) {
        touchingFloor = true;
      }
    });

    return touchingFloor;
  }

  updateSettledBodies(deltaTime) {
    if (this.vortexEnergy > this.config.settleVortexEnergy) {
      for (const item of this.bodies) {
        item.settleTime = 0;
      }
      return;
    }

    for (const item of this.bodies) {
      if (!item.enabled || item.settled || !this.isTouchingFloor(item)) {
        item.settleTime = 0;
        continue;
      }

      item.body.linvel(this.bodyVelocity);
      item.body.angvel(this.bodyAngularVelocity);
      const linearSpeed = Math.hypot(
        this.bodyVelocity.x,
        this.bodyVelocity.y,
        this.bodyVelocity.z,
      );
      const angularSpeed = Math.hypot(
        this.bodyAngularVelocity.x,
        this.bodyAngularVelocity.y,
        this.bodyAngularVelocity.z,
      );

      if (
        linearSpeed > this.config.settleLinearSpeed ||
        angularSpeed > this.config.settleAngularSpeed
      ) {
        item.settleTime = 0;
        continue;
      }

      item.settleTime += deltaTime;
      if (item.settleTime < this.config.settleDelay) {
        continue;
      }

      item.body.resetForces(false);
      item.body.resetTorques(false);
      item.body.setLinvel(this.zeroVelocity, false);
      item.body.setAngvel(this.zeroVelocity, false);
      item.body.setAngularDamping(this.config.angularDamping);
      item.body.sleep();
      item.settled = true;
      this.activeBodyCount = Math.max(this.activeBodyCount - 1, 0);
    }
  }

  syncNodes() {
    for (const { node, body, enabled } of this.bodies) {
      if (!enabled) {
        continue;
      }

      body.translation(node.position);
      body.rotation(this.bodyRotation);
      node.quaternion.copy(this.bodyRotation);
    }
  }

  getPerformanceSnapshot() {
    return this.performanceSnapshot;
  }

  getQueuedBodyCount() {
    const queuedLaunchBodies = this.pendingLaunch
      ? this.pendingLaunch.items.length - this.pendingLaunch.nextIndex
      : 0;
    const queuedPointerBodies = this.pendingPointerImpulse
      ? this.pendingPointerImpulse.items.length -
          this.pendingPointerImpulse.nextIndex
      : 0;

    return queuedLaunchBodies + queuedPointerBodies;
  }

  update(deltaTime) {
    const queuedBodies = this.getQueuedBodyCount();
    if (
      !this.physicsActivated ||
      (this.activeBodyCount === 0 && queuedBodies === 0)
    ) {
      this.accumulator = 0;
      this.performanceSnapshot.activeBodies = this.activeBodyCount;
      this.performanceSnapshot.droppedTimeMs = 0;
      this.performanceSnapshot.queuedBodies = queuedBodies;
      this.performanceSnapshot.substeps = 0;
      this.performanceSnapshot.worldStepMs = 0;
      return;
    }

    const fixedTimeStep = this.config.fixedTimeStep;
    const maximumAccumulatedTime = fixedTimeStep * this.config.maxSubSteps;
    const accumulatedTime = this.accumulator + Math.max(deltaTime, 0);
    let droppedTime = Math.max(accumulatedTime - maximumAccumulatedTime, 0);
    this.accumulator = Math.min(accumulatedTime, maximumAccumulatedTime);

    const updateStartTime = performance.now();
    if (this.accumulator >= fixedTimeStep) {
      if (this.pendingLaunch) {
        this.processPendingLaunchBatch();
      } else if (this.pendingPointerImpulse) {
        this.processPendingPointerImpulseBatch();
      }
    }

    let substeps = 0;
    let worldStepTime = 0;
    const physicsFrameBudgetMs = Math.max(
      this.config.physicsFrameBudgetMs ?? Infinity,
      0,
    );

    while (
      this.accumulator >= fixedTimeStep &&
      substeps < this.config.maxSubSteps
    ) {
      if (substeps > 0) {
        const elapsedUpdateTime = performance.now() - updateStartTime;
        if (
          elapsedUpdateTime + this.stepCostEstimateMs >
          physicsFrameBudgetMs
        ) {
          const wholeStepDebt =
            Math.floor(this.accumulator / fixedTimeStep) * fixedTimeStep;
          this.accumulator -= wholeStepDebt;
          droppedTime += wholeStepDebt;
          break;
        }
      }

      const substepStartTime = performance.now();
      this.elapsedTime += fixedTimeStep;
      this.applyFluidMotion(fixedTimeStep);
      const worldStepStartTime = performance.now();
      this.world.step();
      worldStepTime += performance.now() - worldStepStartTime;
      this.settleCheckAccumulator += fixedTimeStep;
      if (
        this.settleCheckAccumulator >= this.config.settleCheckInterval
      ) {
        const settleDeltaTime = this.settleCheckAccumulator;
        this.settleCheckAccumulator = 0;
        this.updateSettledBodies(settleDeltaTime);
      }
      this.clampBodySpeeds();
      const substepCost = performance.now() - substepStartTime;
      this.stepCostEstimateMs =
        this.stepCostEstimateMs === 0
          ? substepCost
          : THREE.MathUtils.lerp(this.stepCostEstimateMs, substepCost, 0.2);
      this.accumulator -= fixedTimeStep;
      substeps += 1;
    }

    this.syncNodes();
    this.performanceSnapshot.activeBodies = this.activeBodyCount;
    this.performanceSnapshot.droppedTimeMs = droppedTime * 1000;
    this.performanceSnapshot.queuedBodies = this.getQueuedBodyCount();
    this.performanceSnapshot.substeps = substeps;
    this.performanceSnapshot.worldStepMs = worldStepTime;
  }

  dispose() {
    this.eventController.abort();
    this.world.free();
    this.bodies.length = 0;
    this.pendingLaunch = null;
    this.pendingPointerImpulse = null;
  }
}

export async function createModelPhysics({ root, camera, canvas, config }) {
  await initializeRapier();

  const sphereColliderNode = root.getObjectByName(config.sphereColliderName);
  if (!sphereColliderNode?.isMesh) {
    throw new Error(
      `В GLB не найден ограничивающий объект ${config.sphereColliderName}`,
    );
  }

  const movingNodes = [];
  const staticNodes = new Set();
  const staticBaseColliderNodes = new Set();

  root.traverse((node) => {
    const isStaticBaseCollider =
      node.name === config.staticBaseColliderName;

    if (
      STATIC_BASE_NAME_PATTERN.test(node.name) ||
      isStaticBaseCollider
    ) {
      node.traverse((child) => {
        if (child.isMesh) {
          staticNodes.add(child);
          if (isStaticBaseCollider) {
            staticBaseColliderNodes.add(child);
          }
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
    sphereColliderNode,
    movingNodes,
    staticNodes: [...staticNodes],
    staticBaseColliderNodes,
  });
}
