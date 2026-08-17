/*
 * Edgebook on-device dictation worker.
 *
 * The pretrained model and inference runtime are downloaded as static assets,
 * cached by the browser, and executed inside this worker. Microphone samples
 * never leave the trader's device.
 */
import { env, pipeline } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/dist/transformers.min.js';

const MODEL_ID = 'onnx-community/whisper-tiny.en';
const MODEL_REVISION = 'main';

env.allowLocalModels = false;
env.allowRemoteModels = true;
env.useBrowserCache = true;
env.useWasmCache = true;
if (env.backends?.onnx?.wasm) {
  // Shared-memory WASM requires cross-origin isolation. Edgebook deliberately
  // remains compatible with its existing third-party fonts and login flow.
  env.backends.onnx.wasm.numThreads = globalThis.crossOriginIsolated
    ? Math.max(1, Math.min(4, Number(globalThis.navigator?.hardwareConcurrency) || 1))
    : 1;
}

let transcriberPromise = null;
let latestInterimRequest = null;
const finalRequests = [];
let inferenceRunning = false;
let activeSessionId = null;
const progressByFile = new Map();

function post(type, payload = {}) {
  globalThis.postMessage({ type, ...payload });
}

function normalizeProgress(event) {
  const file = typeof event?.file === 'string' ? event.file : '';
  if (event?.status === 'progress_total' && Number.isFinite(event.progress)) {
    return Math.max(0, Math.min(100, event.progress));
  }
  if (event?.status === 'progress' && file && Number.isFinite(event.loaded) && Number.isFinite(event.total) && event.total > 0) {
    progressByFile.set(file, { loaded: event.loaded, total: event.total });
    const totals = [...progressByFile.values()].reduce((sum, value) => ({
      loaded: sum.loaded + value.loaded,
      total: sum.total + value.total,
    }), { loaded: 0, total: 0 });
    return totals.total > 0 ? Math.max(0, Math.min(100, totals.loaded / totals.total * 100)) : null;
  }
  return Number.isFinite(event?.progress) ? Math.max(0, Math.min(100, event.progress)) : null;
}

async function loadTranscriber() {
  if (!transcriberPromise) {
    progressByFile.clear();
    post('model-loading', { progress: 0 });
    const preferredDevice = globalThis.navigator?.gpu ? 'webgpu' : 'wasm';
    const createPipeline = device => pipeline('automatic-speech-recognition', MODEL_ID, {
      revision: MODEL_REVISION,
      device,
      dtype: 'q4',
      progress_callback(event) {
        const progress = normalizeProgress(event);
        if (progress !== null) post('model-loading', { progress, file: String(event?.file || '') });
      },
    }).then(value => ({ value, device }));
    transcriberPromise = createPipeline(preferredDevice).catch(error => {
      if (preferredDevice !== 'webgpu') throw error;
      post('model-loading', { progress: 100, fallback: 'wasm' });
      return createPipeline('wasm');
    }).then(({ value, device }) => {
      post('model-ready', { model: MODEL_ID, device });
      return value;
    }).catch(error => {
      transcriberPromise = null;
      post('model-error', { message: String(error?.message || error || 'Model initialization failed') });
      throw error;
    });
  }
  return transcriberPromise;
}

function normalizeAudio(value) {
  if (value instanceof Float32Array) return value;
  if (value instanceof ArrayBuffer) return new Float32Array(value);
  if (ArrayBuffer.isView(value)) return new Float32Array(value.buffer, value.byteOffset, Math.floor(value.byteLength / 4));
  return new Float32Array(0);
}

function resampleTo16Khz(input, inputRate) {
  const sourceRate = Number(inputRate);
  if (!Number.isFinite(sourceRate) || sourceRate <= 0 || !input.length) return new Float32Array(0);
  if (Math.abs(sourceRate - 16000) < 1) return input;
  const outputLength = Math.max(1, Math.round(input.length * 16000 / sourceRate));
  const output = new Float32Array(outputLength);
  const ratio = sourceRate / 16000;
  for (let index = 0; index < outputLength; index += 1) {
    const position = index * ratio;
    const left = Math.min(input.length - 1, Math.floor(position));
    const right = Math.min(input.length - 1, left + 1);
    const weight = position - left;
    output[index] = input[left] * (1 - weight) + input[right] * weight;
  }
  return output;
}

function prepareWhisperAudio(input) {
  if (!input.length) return input;
  let mean = 0;
  for (let index = 0; index < input.length; index += 1) mean += input[index];
  mean /= input.length;
  let peak = 0;
  const centered = new Float32Array(input.length);
  for (let index = 0; index < input.length; index += 1) {
    const value = input[index] - mean;
    centered[index] = value;
    peak = Math.max(peak, Math.abs(value));
  }
  if (peak < .0015) return new Float32Array(0);
  const gain = peak < .35 ? Math.min(4, .35 / peak) : 1;
  if (gain === 1) return centered;
  for (let index = 0; index < centered.length; index += 1) centered[index] = Math.max(-1, Math.min(1, centered[index] * gain));
  return centered;
}

function audioEvidence(input) {
  if (!input.length) return { peak: 0, rms: 0 };
  let mean = 0;
  for (let index = 0; index < input.length; index += 1) mean += input[index];
  mean /= input.length;
  let peak = 0;
  let squared = 0;
  for (let index = 0; index < input.length; index += 1) {
    const centered = input[index] - mean;
    peak = Math.max(peak, Math.abs(centered));
    squared += centered * centered;
  }
  return { peak, rms: Math.sqrt(squared / input.length) };
}

function requestHasSpeech(request, evidence = {}) {
  const speechMs = Number(request.speechMs) || 0;
  const peakRms = Number(request.peakRms) || 0;
  const voicedRatio = Number(request.voicedRatio) || 0;
  const captureRms = Number(request.captureRms) || 0;
  const audioDurationMs = Number(request.audioDurationMs) || 0;
  const realSignal = Number(evidence.peak) >= .0015 && Number(evidence.rms) >= .00035;
  if (!realSignal || audioDurationMs < 300) return false;
  if (request.forced === true) return true;
  return speechMs >= 220 || voicedRatio >= .025 || peakRms >= .004 || captureRms >= .001;
}

async function drainQueue() {
  if (inferenceRunning) return;
  const request = finalRequests.shift() || latestInterimRequest;
  if (!request) return;
  if (request === latestInterimRequest) latestInterimRequest = null;
  inferenceRunning = true;
  try {
    const transcriber = await loadTranscriber();
    if (request.sessionId !== activeSessionId) return;
    const resampled = resampleTo16Khz(normalizeAudio(request.audio), request.sampleRate);
    const evidence = audioEvidence(resampled);
    const audio = prepareWhisperAudio(resampled);
    if (!requestHasSpeech(request, evidence) || audio.length < 4800) {
      post('transcript', { ...request, audio: undefined, text: '', reason: 'audio-too-quiet', evidence });
      return;
    }
    const result = await transcriber(audio, {
      return_timestamps: false,
      chunk_length_s: 20,
      stride_length_s: 2,
      task: 'transcribe',
      do_sample: false,
      condition_on_prev_tokens: false,
    });
    if (request.sessionId === activeSessionId) {
      const text = String(result?.text || '').replace(/\s+/g, ' ').trim();
      post('transcript', { ...request, audio: undefined, text, reason: text ? '' : 'no-words-recognized', evidence });
    }
  } catch (error) {
    if (request.sessionId === activeSessionId) {
      post('transcription-error', { sessionId: request.sessionId, requestId: request.requestId, message: String(error?.message || error || 'Transcription failed') });
    }
  } finally {
    inferenceRunning = false;
    void drainQueue();
  }
}

globalThis.addEventListener('message', event => {
  const message = event.data || {};
  if (message.type === 'load') {
    activeSessionId = message.sessionId || activeSessionId;
    void loadTranscriber();
    return;
  }
  if (message.type === 'cancel') {
    if (!message.sessionId || message.sessionId === activeSessionId) {
      activeSessionId = null;
      latestInterimRequest = null;
      finalRequests.length = 0;
    }
    return;
  }
  if (message.type !== 'transcribe' || !message.sessionId) return;
  activeSessionId = message.sessionId;
  const next = {
    type: 'transcript',
    sessionId: message.sessionId,
    requestId: Number(message.requestId) || 0,
    segmentId: Number(message.segmentId) || 0,
    final: message.final === true,
    sampleRate: Number(message.sampleRate) || 16000,
    speechMs: Number(message.speechMs) || 0,
    audioDurationMs: Number(message.audioDurationMs) || 0,
    peakRms: Number(message.peakRms) || 0,
    voicedRatio: Number(message.voicedRatio) || 0,
    captureRms: Number(message.captureRms) || 0,
    forced: message.forced === true,
    audio: message.audio,
  };
  // Preserve every final segment in order while coalescing only disposable
  // interim snapshots. This prevents rapid silence boundaries from losing text.
  if (next.final) finalRequests.push(next);
  else latestInterimRequest = next;
  void drainQueue();
});
