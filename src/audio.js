const audioUrls = {
  button: `${import.meta.env.BASE_URL}music/button.wav`,
  prediction: `${import.meta.env.BASE_URL}music/prediction.wav`,
  chip1: `${import.meta.env.BASE_URL}music/chip1.mp3`,
  chip2: `${import.meta.env.BASE_URL}music/chip2.mp3`,
  chip3: `${import.meta.env.BASE_URL}music/chip3.mp3`,
};
const collisionEffects = {
  base: "chip1",
  body: "chip2",
  sphere: "chip3",
};

async function readResponseWithProgress(response, onProgress) {
  const total = Number(response.headers.get("content-length")) || 0;
  if (!response.body || typeof response.body.getReader !== "function") {
    const data = await response.arrayBuffer();
    onProgress?.(data.byteLength, total || data.byteLength);
    return data;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;
  let result;

  while (!(result = await reader.read()).done) {
    chunks.push(result.value);
    loaded += result.value.byteLength;
    if (total > 0) {
      onProgress?.(loaded, total);
    }
  }

  const data = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  onProgress?.(loaded, total || loaded);
  return data.buffer;
}

function getAudioContextConstructor() {
  return window.AudioContext ?? window.webkitAudioContext ?? null;
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

export function createAudioController({ collisionSound = {}, onProgress } = {}) {
  const AudioContextConstructor = getAudioContextConstructor();
  const context = AudioContextConstructor
    ? new AudioContextConstructor()
    : null;
  const minImpactSpeed = Math.max(
    Number.isFinite(collisionSound.minImpactSpeed)
      ? collisionSound.minImpactSpeed
      : 0.45,
    0,
  );
  const fullVolumeImpactSpeed = Math.max(
    Number.isFinite(collisionSound.fullVolumeImpactSpeed)
      ? collisionSound.fullVolumeImpactSpeed
      : 2,
    minImpactSpeed + Number.EPSILON,
  );
  const minVolume = clamp(
    Number.isFinite(collisionSound.minVolume)
      ? collisionSound.minVolume
      : 0.25,
    0,
    1,
  );
  const maxVolume = clamp(
    Number.isFinite(collisionSound.maxVolume)
      ? collisionSound.maxVolume
      : 0.85,
    minVolume,
    1,
  );
  const playbackRateMin = Math.max(
    Number.isFinite(collisionSound.playbackRateMin)
      ? collisionSound.playbackRateMin
      : 0.96,
    Number.EPSILON,
  );
  const playbackRateMax = Math.max(
    Number.isFinite(collisionSound.playbackRateMax)
      ? collisionSound.playbackRateMax
      : 1.04,
    playbackRateMin,
  );
  const buffers = new Map();
  const loadingEffects = new Set();
  const pendingEffects = new Map();
  let enabled = false;
  let disposed = false;
  let preloadPromise = null;

  function playBuffer(buffer, { volume = 1, playbackRate = 1 } = {}) {
    if (!context || context.state !== "running" || disposed) {
      return;
    }

    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = buffer;
    source.playbackRate.value = playbackRate;
    gain.gain.value = volume;
    source.connect(gain);
    gain.connect(context.destination);
    source.addEventListener(
      "ended",
      () => {
        source.disconnect();
        gain.disconnect();
      },
      { once: true },
    );
    source.start();
  }

  function flushPendingEffects() {
    if (!context || context.state !== "running") {
      return;
    }

    for (const [effectName, options] of pendingEffects) {
      const buffer = buffers.get(effectName);
      if (buffer) {
        playBuffer(buffer, options);
        pendingEffects.delete(effectName);
      } else if (!loadingEffects.has(effectName)) {
        pendingEffects.delete(effectName);
      }
    }
  }

  function preload() {
    if (!context || preloadPromise || disposed) {
      return preloadPromise;
    }

    preloadPromise = Promise.all(
      Object.entries(audioUrls).map(async ([effectName, url]) => {
        loadingEffects.add(effectName);
        try {
          const response = await fetch(url);
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
          const data = await readResponseWithProgress(
            response,
            (loaded, total) => onProgress?.(
              effectName,
              loaded,
              total,
              Object.keys(audioUrls).length,
            ),
          );
          const buffer = await context.decodeAudioData(data);
          buffers.set(effectName, buffer);
        } catch (error) {
          console.warn(`Не удалось загрузить звук ${effectName}`, error);
        } finally {
          onProgress?.(
            effectName,
            1,
            1,
            Object.keys(audioUrls).length,
          );
          loadingEffects.delete(effectName);
          flushPendingEffects();
        }
      }),
    ).then(() => undefined);

    return preloadPromise;
  }

  function enable() {
    if (!context || disposed) {
      return Promise.resolve();
    }

    enabled = true;
    const resumePromise = context.resume().catch((error) => {
      console.warn("Не удалось включить звук", error);
    }).then(() => {
      flushPendingEffects();
    });
    const loadPromise = preload() ?? Promise.resolve();

    return Promise.all([resumePromise, loadPromise]).then(() => undefined);
  }

  function play(effectName, options) {
    if (!enabled || !context || disposed) {
      return;
    }

    const buffer = buffers.get(effectName);
    if (buffer) {
      if (context.state === "running") {
        playBuffer(buffer, options);
      } else {
        pendingEffects.set(effectName, options);
      }
      return;
    }

    if (loadingEffects.has(effectName)) {
      pendingEffects.set(effectName, options);
    }
  }

  function playButton() {
    play("button");
  }

  function playPrediction() {
    play("prediction");
  }

  function playCollision({ type, impactSpeed } = {}) {
    const effectName = collisionEffects[type];
    if (!effectName) {
      return;
    }

    const normalizedImpact = clamp(
      ((Number.isFinite(impactSpeed) ? impactSpeed : minImpactSpeed)
        - minImpactSpeed)
        / (fullVolumeImpactSpeed - minImpactSpeed),
      0,
      1,
    );
    const volume = minVolume
      + (maxVolume - minVolume) * Math.sqrt(normalizedImpact);
    const playbackRate = playbackRateMin
      + Math.random() * (playbackRateMax - playbackRateMin);

    play(effectName, {
      volume,
      playbackRate,
    });
  }

  function dispose() {
    if (disposed) {
      return;
    }

    disposed = true;
    enabled = false;
    pendingEffects.clear();
    buffers.clear();
    void context?.close();
  }

  return {
    enable,
    playButton,
    playPrediction,
    playCollision,
    dispose,
  };
}
