// Browser-local camera inference. Camera frames never leave this page.
const MODEL_SIZE = 416;
const PERSON_CLASS = 0;
const PERSON_CONFIDENCE = 0.35;
const NMS_IOU = 0.45;
const FACE_NEAR_RATIO = 0.20;
const FRAME_INTERVAL_MS = 160;
const PULSE_SAMPLE_INTERVAL_MS = 80;
const PULSE_WINDOW_MS = 16000;
const PULSE_MIN_DURATION_MS = 10000;
const ORT_VERSION = '1.27.0';
const MEDIAPIPE_VERSION = '0.10.32';

const $ = (id) => document.getElementById(id);
const consoleEl = $('visionConsole');
const startButton = $('visionBtn');
const startLabel = $('visionBtnLabel');
const stopButton = $('visionStop');
const statusEl = $('visionStatus');
const video = $('visionVideo');
const canvas = $('visionCanvas');
const ctx = canvas.getContext('2d');
const errorEl = $('visionError');
const faceState = $('visionFaceState');
const faceMetric = faceState.parentElement;
const peopleCount = $('visionPeopleCount');
const engineEl = $('visionEngine');
const facingSelect = $('visionFacing');
const pulseValue = $('visionPulseValue');
const pulseQuality = $('visionPulseQuality');
const pulseCanvas = document.createElement('canvas');
pulseCanvas.width = 16;
pulseCanvas.height = 16;
const pulseCtx = pulseCanvas.getContext('2d', { willReadFrequently: true });

let running = false;
let starting = false;
let generation = 0;
let stream = null;
let ort = null;
let yoloSession = null;
let poseLandmarker = null;
let faceDetector = null;
let frameBusy = false;
let lastInferenceAt = 0;
let lastVideoTime = -1;
let nextTrackId = 1;
let tracks = [];
let pulseFace = null;
let pulseSamples = [];
let lastPulseSampleAt = 0;
let lastPulseVideoTime = -1;
let lastPulseFace = null;
let lastPulseBrightness = null;
let smoothedPulse = null;

const translate = (key) => (typeof window.appTr === 'function' ? window.appTr(key) : key);
const text = (key, value) => { const el = $(key); if (el) el.textContent = value ?? translate(key); };

function setStatus(key) {
  statusEl.dataset.i = key;
  statusEl.textContent = translate(key);
}

function updateControls() {
  const active = starting || running;
  facingSelect.disabled = active;
  startButton.setAttribute('aria-pressed', String(running));
  startLabel.dataset.i = active ? 'visionStop' : 'visionStart';
  startLabel.textContent = translate(active ? 'visionStop' : 'visionStart');
  stopButton.disabled = !active;
  consoleEl.classList.toggle('is-running', running);
  consoleEl.classList.toggle('is-live', Boolean(stream && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA));
}

function refreshLocalizedState() {
  if (running) setStatus('visionRunning');
  else if (starting) setStatus('visionLoading');
  else setStatus('visionOff');
  if (faceState.dataset.i) faceState.textContent = translate(faceState.dataset.i);
  if (pulseQuality.dataset.i) pulseQuality.textContent = translate(pulseQuality.dataset.i);
  updateControls();
}

window.addEventListener('app:language-change', refreshLocalizedState);

async function createYoloSession(runtime) {
  runtime.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
  runtime.env.wasm.numThreads = 1;
  const modelUrl = new URL('./models/yolox_nano.onnx', document.baseURI).href;
  if (navigator.gpu) {
    try {
      const session = await runtime.InferenceSession.create(modelUrl, { executionProviders: ['webgpu'] });
      return { session, provider: 'WebGPU' };
    } catch {
      // Some factory browsers expose WebGPU but lack an operator needed by this model.
    }
  }
  const session = await runtime.InferenceSession.create(modelUrl, { executionProviders: ['wasm'] });
  return { session, provider: 'CPU / WebAssembly' };
}

async function loadModels(token) {
  const [runtime, vision] = await Promise.all([
    import(`https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/ort.webgpu.min.mjs`),
    import(`https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/vision_bundle.mjs`),
  ]);
  ort = runtime;
  const fileset = await vision.FilesetResolver.forVisionTasks(
    `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`,
  );
  const [yolo, pose, face] = await Promise.all([
    createYoloSession(runtime),
    vision.PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: new URL('./models/pose_landmarker_lite.task', document.baseURI).href },
      runningMode: 'VIDEO', numPoses: 6, minPoseDetectionConfidence: 0.45,
      minPosePresenceConfidence: 0.45, minTrackingConfidence: 0.45,
    }),
    vision.FaceDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: new URL('./models/blaze_face_short_range.tflite', document.baseURI).href },
      runningMode: 'VIDEO', minDetectionConfidence: 0.55,
    }),
  ]);
  const dispose = () => {
    try { yolo.session.release(); } catch {}
    try { pose.close(); } catch {}
    try { face.close(); } catch {}
  };
  if (token !== generation) { dispose(); return null; }
  return { yolo: yolo.session, provider: yolo.provider, pose, face, dispose };
}

function preprocessFrame() {
  const width = video.videoWidth;
  const height = video.videoHeight;
  const scale = Math.min(MODEL_SIZE / width, MODEL_SIZE / height);
  const resizedWidth = Math.round(width * scale);
  const resizedHeight = Math.round(height * scale);
  const padX = Math.floor((MODEL_SIZE - resizedWidth) / 2);
  const padY = Math.floor((MODEL_SIZE - resizedHeight) / 2);
  const image = document.createElement('canvas');
  image.width = MODEL_SIZE;
  image.height = MODEL_SIZE;
  const imageCtx = image.getContext('2d', { willReadFrequently: true });
  imageCtx.fillStyle = 'rgb(114,114,114)';
  imageCtx.fillRect(0, 0, MODEL_SIZE, MODEL_SIZE);
  imageCtx.drawImage(video, padX, padY, resizedWidth, resizedHeight);
  const pixels = imageCtx.getImageData(0, 0, MODEL_SIZE, MODEL_SIZE).data;
  const planeSize = MODEL_SIZE * MODEL_SIZE;
  const data = new Float32Array(planeSize * 3);
  for (let i = 0; i < planeSize; i++) {
    // YOLOX was trained with OpenCV BGR input; canvas supplies RGBA.
    data[i] = pixels[i * 4 + 2];
    data[planeSize + i] = pixels[i * 4 + 1];
    data[planeSize * 2 + i] = pixels[i * 4];
  }
  return { tensor: new ort.Tensor('float32', data, [1, 3, MODEL_SIZE, MODEL_SIZE]), scale, padX, padY, width, height };
}

function iou(a, b) {
  const x1 = Math.max(a.x1, b.x1), y1 = Math.max(a.y1, b.y1);
  const x2 = Math.min(a.x2, b.x2), y2 = Math.min(a.y2, b.y2);
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = Math.max(0, a.x2 - a.x1) * Math.max(0, a.y2 - a.y1);
  const areaB = Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1);
  return intersection / (areaA + areaB - intersection + 1e-6);
}

function suppressOverlaps(boxes) {
  const kept = [];
  for (const box of boxes.sort((a, b) => b.score - a.score)) {
    if (kept.every((other) => iou(box, other) < NMS_IOU)) kept.push(box);
    if (kept.length >= 40) break;
  }
  return kept;
}

function decodePeople(output, prep) {
  const dims = output.dims;
  const channelsFirst = dims.length === 3 && dims[1] === 85;
  const rowCount = channelsFirst ? dims[2] : dims[1];
  const value = (row, column) => output.data[channelsFirst ? column * rowCount + row : row * 85 + column];
  const boxes = [];
  const strides = [8, 16, 32];
  let row = 0;
  for (const stride of strides) {
    const cells = MODEL_SIZE / stride;
    for (let gy = 0; gy < cells; gy++) {
      for (let gx = 0; gx < cells; gx++, row++) {
        if (row >= rowCount) break;
        const score = value(row, 4) * value(row, 5 + PERSON_CLASS);
        if (score < PERSON_CONFIDENCE) continue;
        const cx = (value(row, 0) + gx) * stride;
        const cy = (value(row, 1) + gy) * stride;
        const width = Math.exp(value(row, 2)) * stride;
        const height = Math.exp(value(row, 3)) * stride;
        const x1 = Math.max(0, (cx - width / 2 - prep.padX) / prep.scale);
        const y1 = Math.max(0, (cy - height / 2 - prep.padY) / prep.scale);
        const x2 = Math.min(prep.width, (cx + width / 2 - prep.padX) / prep.scale);
        const y2 = Math.min(prep.height, (cy + height / 2 - prep.padY) / prep.scale);
        if (x2 > x1 && y2 > y1) boxes.push({ x1, y1, x2, y2, score });
      }
    }
  }
  return suppressOverlaps(boxes);
}

function assignTrackIds(boxes, now) {
  const used = new Set();
  for (const box of boxes) {
    let best = null, bestIou = 0.15;
    for (const track of tracks) {
      if (used.has(track.id) || now - track.time > 1200) continue;
      const overlap = iou(box, track);
      if (overlap > bestIou) { bestIou = overlap; best = track; }
    }
    box.id = best ? best.id : `P${String(nextTrackId++).padStart(2, '0')}`;
    used.add(box.id);
  }
  tracks = boxes.map((box) => ({ ...box, time: now }));
  return boxes;
}

const POSE_LINKS = [[11,12],[11,13],[13,15],[12,14],[14,16],[11,23],[12,24],[23,24],[23,25],[25,27],[24,26],[26,28],[27,29],[27,31],[28,30],[28,32]];
function drawOverlay(boxes, poseResult, faces) {
  const w = video.videoWidth, h = video.videoHeight;
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  ctx.clearRect(0, 0, w, h);
  ctx.lineWidth = Math.max(2, w / 500);
  ctx.font = `bold ${Math.max(14, w / 45)}px Segoe UI, sans-serif`;
  for (const box of boxes) {
    ctx.strokeStyle = '#57f0c2'; ctx.fillStyle = '#57f0c2';
    ctx.strokeRect(box.x1, box.y1, box.x2 - box.x1, box.y2 - box.y1);
    ctx.fillText(`${box.id} ${(box.score * 100).toFixed(0)}%`, box.x1 + 4, Math.max(18, box.y1 - 7));
  }
  ctx.strokeStyle = '#54d6ff'; ctx.fillStyle = '#54d6ff'; ctx.lineWidth = Math.max(2, w / 600);
  for (const landmarks of poseResult.landmarks || []) {
    for (const [a, b] of POSE_LINKS) {
      const p = landmarks[a], q = landmarks[b];
      if (!p || !q || (p.visibility ?? 1) < 0.35 || (q.visibility ?? 1) < 0.35) continue;
      ctx.beginPath(); ctx.moveTo(p.x * w, p.y * h); ctx.lineTo(q.x * w, q.y * h); ctx.stroke();
    }
  }
  for (const detection of faces) {
    const b = detection.boundingBox;
    ctx.strokeStyle = (b.width / w) >= FACE_NEAR_RATIO ? '#ffb454' : '#ffd66b';
    ctx.strokeRect(b.originX, b.originY, b.width, b.height);
  }
}

function showPulseQuality(key) {
  pulseQuality.dataset.i = key;
  pulseQuality.textContent = translate(key);
}

function resetPulse(key = 'visionPulseWaiting') {
  pulseSamples = [];
  lastPulseSampleAt = 0;
  lastPulseVideoTime = -1;
  lastPulseFace = null;
  lastPulseBrightness = null;
  smoothedPulse = null;
  pulseValue.textContent = '—';
  showPulseQuality(key);
}

function estimatePulse() {
  const duration = pulseSamples.at(-1).time - pulseSamples[0].time;
  if (duration < PULSE_MIN_DURATION_MS) {
    showPulseQuality('visionPulseCollecting');
    return;
  }
  if (pulseSamples.length < 90) {
    showPulseQuality('visionPulsePoor');
    return;
  }
  const sampleRate = (pulseSamples.length - 1) * 1000 / (pulseSamples.at(-1).time - pulseSamples[0].time);
  const radius = Math.max(2, Math.round(sampleRate * 0.45));
  const filtered = pulseSamples.map((sample, index) => {
    const start = Math.max(0, index - radius);
    const end = Math.min(pulseSamples.length, index + radius + 1);
    let average = 0;
    for (let i = start; i < end; i++) average += pulseSamples[i].green;
    return sample.green - average / (end - start);
  });
  const variance = filtered.reduce((sum, value) => sum + value * value, 0) / filtered.length;
  if (variance < 0.0064 || variance > 180) {
    showPulseQuality('visionPulsePoor');
    return;
  }

  const minLag = Math.max(2, Math.floor(sampleRate * 60 / 180));
  const maxLag = Math.min(filtered.length / 2, Math.ceil(sampleRate * 60 / 45));
  const correlations = [];
  for (let lag = minLag; lag <= maxLag; lag++) {
    let product = 0, leftEnergy = 0, rightEnergy = 0;
    for (let i = lag; i < filtered.length; i++) {
      const left = filtered[i], right = filtered[i - lag];
      product += left * right;
      leftEnergy += left * left;
      rightEnergy += right * right;
    }
    correlations.push({ lag, value: product / Math.sqrt(leftEnergy * rightEnergy + 1e-9) });
  }
  const peaks = correlations.filter((entry, index) =>
    entry.value > 0 && entry.value >= (correlations[index - 1]?.value ?? -1)
      && entry.value >= (correlations[index + 1]?.value ?? -1),
  ).sort((a, b) => b.value - a.value);
  const best = peaks[0];
  if (!best || best.value < 0.36) {
    showPulseQuality('visionPulsePoor');
    return;
  }
  const bpm = 60 * sampleRate / best.lag;
  if (!Number.isFinite(bpm) || bpm < 45 || bpm > 180) {
    showPulseQuality('visionPulsePoor');
    return;
  }
  smoothedPulse = smoothedPulse === null ? bpm : smoothedPulse * 0.75 + bpm * 0.25;
  pulseValue.textContent = `~${Math.round(smoothedPulse)} bpm`;
  showPulseQuality('visionPulseEstimate');
}

function samplePulse(now) {
  if (!pulseFace || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    if (pulseSamples.length) resetPulse('visionPulseNoFace');
    else showPulseQuality('visionPulseNoFace');
    return;
  }
  if (video.currentTime === lastPulseVideoTime) {
    if (now - lastPulseSampleAt > 1200 && pulseSamples.length) {
      resetPulse('visionPulsePoor');
      lastPulseVideoTime = video.currentTime;
    }
    return;
  }
  if (now - lastPulseSampleAt < PULSE_SAMPLE_INTERVAL_MS) return;
  lastPulseSampleAt = now;
  lastPulseVideoTime = video.currentTime;

  const { originX, originY, width, height } = pulseFace;
  const face = { x: originX + width / 2, y: originY + height / 2, width, height };
  if (lastPulseFace) {
    const moved = Math.hypot(face.x - lastPulseFace.x, face.y - lastPulseFace.y) / Math.max(face.width, lastPulseFace.width);
    const resized = Math.abs(face.width - lastPulseFace.width) / lastPulseFace.width;
    if (moved > 0.12 || resized > 0.16) resetPulse('visionPulsePoor');
  }
  lastPulseFace = face;

  const x = originX + width * 0.20, y = originY + height * 0.24;
  pulseCtx.drawImage(video, x, y, width * 0.60, height * 0.52, 0, 0, pulseCanvas.width, pulseCanvas.height);
  const pixels = pulseCtx.getImageData(0, 0, pulseCanvas.width, pulseCanvas.height).data;
  let green = 0, brightness = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    green += pixels[i + 1];
    brightness += (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3;
  }
  green /= pixels.length / 4;
  brightness /= pixels.length / 4;
  if (brightness < 25 || brightness > 235 || (lastPulseBrightness !== null && Math.abs(brightness - lastPulseBrightness) > 18)) {
    resetPulse('visionPulsePoor');
    return;
  }
  lastPulseBrightness = brightness;
  pulseSamples.push({ time: now, green });
  while (pulseSamples.length && now - pulseSamples[0].time > PULSE_WINDOW_MS) pulseSamples.shift();
  estimatePulse();
}

async function inferFrame(now) {
  const prep = preprocessFrame();
  const resultMap = await yoloSession.run({ [yoloSession.inputNames[0]]: prep.tensor });
  const output = resultMap[yoloSession.outputNames[0]];
  const people = assignTrackIds(decodePeople(output, prep), now);
  const poseResult = poseLandmarker.detectForVideo(video, now);
  const faceResult = faceDetector.detectForVideo(video, now);
  const faces = faceResult.detections || [];
  const nearestFace = faces
    .map((detection) => detection.boundingBox)
    .filter((box) => box.width / video.videoWidth >= FACE_NEAR_RATIO)
    .sort((a, b) => b.width - a.width)[0] || null;
  if (!nearestFace && pulseFace) resetPulse('visionPulseNoFace');
  pulseFace = nearestFace;
  drawOverlay(people, poseResult, faces);
  peopleCount.textContent = `${people.length}${people.length ? ` · ${people.map((p) => p.id).join(', ')}` : ''}`;
  const near = faces.some((d) => d.boundingBox.width / video.videoWidth >= FACE_NEAR_RATIO);
  faceState.dataset.i = near ? 'visionFaceNear' : 'visionFaceNone';
  faceState.textContent = translate(faceState.dataset.i);
  faceMetric.classList.toggle('near', near);
}

async function renderLoop(token) {
  if (token !== generation || !running) return;
  const now = performance.now();
  if (!frameBusy && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.currentTime !== lastVideoTime && now - lastInferenceAt >= FRAME_INTERVAL_MS) {
    frameBusy = true; lastInferenceAt = now; lastVideoTime = video.currentTime;
    try { await inferFrame(now); }
    catch { stopVision('visionRuntimeError'); return; }
    finally { frameBusy = false; }
  }
  if (token === generation && running) requestAnimationFrame(() => renderLoop(token));
}

function pulseLoop(token) {
  if (token !== generation || !running) return;
  samplePulse(performance.now());
  requestAnimationFrame(() => pulseLoop(token));
}

function stopMedia(streamToStop) {
  if (streamToStop) for (const track of streamToStop.getTracks()) track.stop();
}

function releaseModels() {
  try { yoloSession?.release(); } catch {}
  try { poseLandmarker?.close(); } catch {}
  try { faceDetector?.close(); } catch {}
  yoloSession = null; poseLandmarker = null; faceDetector = null; ort = null;
}

function stopVision(errorKey = null) {
  generation++;
  running = false; starting = false; frameBusy = false;
  stopMedia(stream); stream = null; video.srcObject = null;
  releaseModels(); tracks = []; nextTrackId = 1; lastVideoTime = -1;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  peopleCount.textContent = '—'; $('visionEngine').textContent = '—';
  faceState.dataset.i = 'visionFaceNone'; faceState.textContent = translate('visionFaceNone'); faceMetric.classList.remove('near');
  pulseFace = null; resetPulse('visionPulseWaiting');
  consoleEl.classList.remove('is-live');
  errorEl.hidden = !errorKey;
  if (errorKey) errorEl.textContent = translate(errorKey);
  setStatus('visionOff'); updateControls();
}

async function startVision() {
  const token = ++generation;
  starting = true; errorEl.hidden = true; tracks = []; nextTrackId = 1;
  setStatus('visionStarting'); updateControls();
  let cameraStream = null;
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('secure'), { code: 'secure' });
    cameraStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: facingSelect.value }, width: { ideal: 960 }, height: { ideal: 540 }, frameRate: { ideal: 30, max: 30 } },
    });
    if (token !== generation) { stopMedia(cameraStream); return; }
    const actualFacing = cameraStream.getVideoTracks()[0]?.getSettings?.().facingMode;
    if (actualFacing && actualFacing !== facingSelect.value) {
      stopMedia(cameraStream);
      throw Object.assign(new Error('facing-unsupported'), { code: 'facing-unsupported' });
    }
    stream = cameraStream; video.srcObject = stream; await video.play();
    consoleEl.classList.add('is-live');
    setStatus('visionLoading'); updateControls();
    const loaded = await loadModels(token);
    if (!loaded || token !== generation) { stopMedia(cameraStream); return; }
    yoloSession = loaded.yolo; poseLandmarker = loaded.pose; faceDetector = loaded.face;

    $('visionEngine').textContent = loaded.provider;
    running = true; starting = false; setStatus('visionRunning'); updateControls();
    requestAnimationFrame(() => renderLoop(token));
    requestAnimationFrame(() => pulseLoop(token));
  } catch (error) {
    stopMedia(cameraStream);
    const key = error?.code === 'secure' ? 'visionSecureError'
      : error?.code === 'facing-unsupported' || ((error?.name === 'OverconstrainedError' || error?.name === 'ConstraintNotSatisfiedError') && error?.constraint === 'facingMode') ? 'visionFacingUnsupported'
      : error?.name === 'NotAllowedError' ? 'visionCameraDenied'
      : error?.name === 'NotFoundError' ? 'visionCameraMissing'
      : error?.name === 'NotReadableError' ? 'visionCameraBusy'
      : error?.name === 'AbortError' ? 'visionCameraUnavailable'
      : error?.name === 'OverconstrainedError' || error?.name === 'ConstraintNotSatisfiedError' ? 'visionCameraConstraint'
      : stream ? 'visionModelError' : 'visionCameraMissing';
    stopVision(key);
  }
}

startButton.addEventListener('click', () => {
  if (starting || running) stopVision();
  else startVision();
});
stopButton.addEventListener('click', () => stopVision());
updateControls();
