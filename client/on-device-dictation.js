(function installEdgebookOnDeviceDictation(global) {
  'use strict';

  const STATIC_TARGETS = new Map([
    ['t-psych-prethought', { label: 'pre-trade thought', context: 'trade' }],
    ['t-psych-execution', { label: 'execution note', context: 'trade' }],
    ['t-psych-review', { label: 'post-trade review', context: 'trade' }],
    ['t-notes', { label: 'trade notes', context: 'trade' }],
    ['dj-mistake', { label: 'biggest mistake', context: 'dailyjournal' }],
    ['dj-keylesson', { label: 'key lesson', context: 'dailyjournal' }],
    ['dj-woulddodiff', { label: 'what you would do differently', context: 'dailyjournal' }],
    ['dj-intentions', { label: "tomorrow's intentions", context: 'dailyjournal' }],
    ['dj-notes', { label: 'journal notes', context: 'dailyjournal' }],
    ['mood-notes-inp', { label: 'mood notes', context: 'mood' }],
    ['mm-notes', { label: 'mood check-in notes', context: 'mood' }],
  ]);

  const INTERIM_INTERVAL_MS = 1900;
  const SILENCE_MS = 900;
  const MAX_SEGMENT_MS = 18000;
  const MIN_FINAL_SPEECH_MS = 640;
  const MIN_INTERIM_SPEECH_MS = 900;
  const SILENCE_HALLUCINATIONS = new Set(['you', 'thank you', 'thanks for watching', 'bye', 'goodbye']);

  function createController(options = {}) {
    const root = options.root || global;
    const document = options.document || root.document;
    const navigator = options.navigator || root.navigator;
    const performance = options.performance || root.performance || { now: () => Date.now() };
    const WorkerClass = options.WorkerClass || root.Worker;
    const AudioContextClass = options.AudioContextClass || root.AudioContext || root.webkitAudioContext;
    const workerUrl = options.workerUrl || './client/on-device-whisper-worker.js';
    const escapeHtml = options.escapeHtml || (value => String(value));
    const showToast = options.showToast || (() => {});
    const onSessionChange = options.onSessionChange || (() => {});
    const cancelDailyAutosave = options.cancelDailyAutosave || (() => {});
    const schedule = options.setTimeout || root.setTimeout.bind(root);
    const unschedule = options.clearTimeout || root.clearTimeout.bind(root);

    let session = null;
    let worker = null;
    let workerState = 'idle';
    let workerRequest = 0;
    let modelProgress = 0;

    function setSession(value) {
      session = value;
      onSessionChange(value);
    }

    function targetSpec(target) {
      const staticSpec = STATIC_TARGETS.get(target);
      if (staticSpec) return staticSpec;
      if (/^cf-v-[A-Za-z0-9_-]+$/.test(target)) return { label: 'custom trade note', context: 'trade' };
      if (/^hm-note-[A-Za-z0-9_-]+$/.test(target)) return { label: 'heatmap note', context: 'heatmap' };
      return null;
    }

    function controlHtml(target, label) {
      if (!targetSpec(target)) return '';
      const safeTarget = escapeHtml(target);
      const safeLabel = escapeHtml(label);
      return `<button type="button" class="trade-voice-btn" data-dictation-target="${safeTarget}" onclick="toggleDictation('${safeTarget}')" aria-label="Dictate ${safeLabel}" aria-pressed="false" title="Private on-device Whisper dictation. Edgebook stores only text you save."><i class="fa-solid fa-microphone"></i><span class="trade-voice-wave" aria-hidden="true"><b></b><b></b><b></b><b></b></span></button>`;
    }

    function statusHtml(target) {
      return `<div class="dictation-status trade-voice-status" id="voice-status-${escapeHtml(target)}" role="status" aria-live="polite"></div>`;
    }

    function capability() {
      if (root.isSecureContext !== true) return { available: false, message: 'Voice dictation requires a secure HTTPS connection. You can still type here.' };
      if (!navigator?.mediaDevices?.getUserMedia) return { available: false, message: 'This browser cannot access a microphone. You can still type here.' };
      if (typeof WorkerClass !== 'function' || typeof AudioContextClass !== 'function') return { available: false, message: 'On-device Whisper is not supported in this browser. You can still type here.' };
      return { available: true, message: '' };
    }

    function joinText(base, transcript) {
      const existing = String(base || '');
      const spoken = String(transcript || '').replace(/\s+/g, ' ').trim();
      if (!spoken) return existing;
      if (!existing) return spoken;
      return existing + (/\s$/.test(existing) ? '' : '\n') + spoken;
    }

    function reviewMessage(context) {
      if (context === 'trade') return 'Transcript added — review it before saving the trade.';
      if (context === 'dailyjournal') return 'Transcript added — review it before saving the journal entry.';
      if (context === 'mood') return 'Transcript added — review it before saving the check-in.';
      return 'Transcript added — review it before saving the note.';
    }

    function errorMessage(code) {
      if (code === 'not-allowed') return 'Microphone permission was blocked. Allow the microphone for Edgebook in the address bar, then try again.';
      if (code === 'audio-capture') return 'No microphone was detected. Check your microphone and try again.';
      if (code === 'no-speech') return 'No speech was detected. Tap the microphone when you are ready.';
      if (code === 'model') return 'On-device Whisper could not start. Check your connection for the first model download, then try again.';
      if (code === 'aborted') return 'Dictation stopped. Any captured words are ready to review.';
      return 'Dictation stopped unexpectedly. Any captured words are ready to review.';
    }

    function setStatus(target, message, state = '') {
      const status = document.getElementById(`voice-status-${target}`);
      if (!status) return;
      status.textContent = message;
      status.classList.remove('is-listening', 'is-ready');
      if (state) status.classList.add(state);
    }

    function buttons() {
      return Array.from(document.querySelectorAll('[data-dictation-target]'));
    }

    function buttonFor(target) {
      return buttons().find(button => button.dataset.dictationTarget === target) || null;
    }

    function refreshControls() {
      const support = capability();
      for (const button of buttons()) {
        const target = button.dataset.dictationTarget;
        const spec = targetSpec(target);
        const active = session?.target === target;
        const preparing = active && session.phase !== 'listening';
        button.disabled = !support.available || !spec;
        button.classList.toggle('is-listening', active);
        button.classList.toggle('is-preparing', preparing);
        button.setAttribute('aria-pressed', String(active));
        button.setAttribute('aria-label', active ? 'Stop private on-device dictation' : `Dictate ${spec?.label || 'note'} on this device`);
        const icon = button.querySelector('i');
        if (icon) icon.className = active ? 'fa-solid fa-stop' : 'fa-solid fa-microphone';
        button.title = support.available
          ? (active ? 'Stop dictation' : 'Private on-device Whisper dictation. The model downloads once; audio never leaves this device.')
          : support.message;
        if (!support.available) setStatus(target, support.message);
      }
    }

    function updateMeter(current, rms = 0, speaking = false) {
      if (session !== current) return;
      const button = buttonFor(current.target);
      if (!button) return;
      button.classList.toggle('is-speaking', speaking);
      button.classList.toggle('is-preparing', current.phase !== 'listening');
      const bars = Array.from(button.querySelectorAll?.('.trade-voice-wave b') || []);
      const level = Math.max(0, Math.min(1, rms * 22));
      const shapes = [.55, 1, .72, .42];
      bars.forEach((bar, index) => { bar.style.height = `${Math.round(2 + 11 * level * (shapes[index] || .6))}px`; });
    }

    function renderTranscript(current) {
      if (session === current) current.element.value = joinText(current.baseText, `${current.finalText} ${current.interimText}`);
    }

    function promoteInterim(current) {
      if (current.interimText.trim()) current.finalText = `${current.finalText} ${current.interimText}`.trim();
      current.interimText = '';
      renderTranscript(current);
    }

    function stopCapture(current) {
      if (current.processor) {
        current.processor.onaudioprocess = null;
        try { current.processor.disconnect(); } catch {}
      }
      for (const node of [current.source, current.analyser, current.silentGain]) {
        try { node?.disconnect(); } catch {}
      }
      for (const track of current.stream?.getTracks?.() || []) {
        try { track.stop(); } catch {}
      }
      try { current.audioContext?.close(); } catch {}
      Object.assign(current, { processor: null, source: null, analyser: null, silentGain: null, stream: null, audioContext: null });
    }

    function finish(current, message, state = 'is-ready') {
      if (session !== current) return;
      promoteInterim(current);
      unschedule(current.watchdog);
      stopCapture(current);
      worker?.postMessage({ type: 'cancel', sessionId: current.id });
      setSession(null);
      current.element.removeEventListener('input', current.onUserInput);
      current.element.readOnly = current.wasReadOnly;
      refreshControls();
      setStatus(current.target, message, state);
    }

    function concatenateAudio(chunks, totalLength) {
      const output = new Float32Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.length;
      }
      return output;
    }

    function resetSegment(current) {
      current.segmentId += 1;
      current.chunks = [];
      current.sampleCount = 0;
      current.speechMs = 0;
      current.speechStarted = false;
      current.lastVoiceAt = 0;
      current.lastInterimAt = 0;
      current.preRoll = [];
      current.interimText = '';
      current.peakRms = 0;
      current.voicedChunks = 0;
      current.totalChunks = 0;
    }

    function submitSegment(current, final = false) {
      const minimumSpeech = final ? MIN_FINAL_SPEECH_MS : MIN_INTERIM_SPEECH_MS;
      if (session !== current || !current.sampleCount || !current.speechStarted || current.speechMs < minimumSpeech) return false;
      const audio = concatenateAudio(current.chunks, current.sampleCount);
      const segmentId = current.segmentId;
      const requestId = ++workerRequest;
      const audioDurationMs = current.sampleCount / current.sampleRate * 1000;
      const activity = {
        speechMs: Math.round(current.speechMs),
        audioDurationMs: Math.round(audioDurationMs),
        peakRms: current.peakRms,
        voicedRatio: current.totalChunks ? current.voicedChunks / current.totalChunks : 0,
      };
      if (final) {
        current.pendingFinals += 1;
        resetSegment(current);
      } else {
        current.latestInterimRequest = requestId;
        current.lastInterimAt = Date.now();
      }
      worker?.postMessage({ type: 'transcribe', sessionId: current.id, requestId, segmentId, final, sampleRate: current.sampleRate, ...activity, audio: audio.buffer }, [audio.buffer]);
      return true;
    }

    function normalizeCandidateText(value) {
      return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function isLikelySilenceHallucination(text, message = {}) {
      const normalized = normalizeCandidateText(text).toLowerCase().replace(/[^a-z0-9' ]+/g, '').trim();
      if (!normalized) return false;
      const words = normalized.split(/\s+/).filter(Boolean);
      const speechMs = Number(message.speechMs) || 0;
      const voicedRatio = Number(message.voicedRatio) || 0;
      const peakRms = Number(message.peakRms) || 0;
      const weakAudio = speechMs < MIN_FINAL_SPEECH_MS || voicedRatio < .1 || peakRms < .014;
      const implausiblySparse = speechMs >= 1500 && words.length === 1;
      return SILENCE_HALLUCINATIONS.has(normalized) && (weakAudio || implausiblySparse);
    }

    function ingestAudio(current, input) {
      if (session !== current || current.phase !== 'listening' || current.stopRequested) return;
      const chunk = new Float32Array(input);
      const now = performance.now();
      let sum = 0;
      for (let index = 0; index < chunk.length; index += 1) sum += chunk[index] * chunk[index];
      const rms = Math.sqrt(sum / Math.max(1, chunk.length));
      if (!current.speechStarted) current.noiseFloor = current.noiseFloor * .94 + rms * .06;
      const speaking = rms > Math.max(.011, current.noiseFloor * 2.35);
      const chunkMs = chunk.length / current.sampleRate * 1000;
      updateMeter(current, rms, speaking);
      if (!current.speechStarted) {
        current.preRoll.push(chunk);
        while (current.preRoll.length > 4) current.preRoll.shift();
        if (!speaking) return;
        current.speechStarted = true;
        current.chunks = current.preRoll.slice();
        current.sampleCount = current.chunks.reduce((total, value) => total + value.length, 0);
        current.preRoll = [];
        current.segmentStartedAt = now;
      } else {
        current.chunks.push(chunk);
        current.sampleCount += chunk.length;
      }
      current.totalChunks += 1;
      current.peakRms = Math.max(current.peakRms, rms);
      if (speaking) {
        current.lastVoiceAt = now;
        current.speechMs += chunkMs;
        current.voicedChunks += 1;
        setStatus(current.target, 'Speech detected — transcribing privately on this device…', 'is-listening');
      }
      const elapsed = now - current.segmentStartedAt;
      const silence = current.lastVoiceAt ? now - current.lastVoiceAt : 0;
      if (silence >= SILENCE_MS && current.speechMs < MIN_FINAL_SPEECH_MS) {
        resetSegment(current);
        setStatus(current.target, 'Listening on this device ··· speak naturally.', 'is-listening');
        return;
      }
      if (current.speechMs >= MIN_INTERIM_SPEECH_MS && Date.now() - current.lastInterimAt >= INTERIM_INTERVAL_MS) submitSegment(current, false);
      if (current.speechMs >= MIN_FINAL_SPEECH_MS && (silence >= SILENCE_MS || elapsed >= MAX_SEGMENT_MS)) submitSegment(current, true);
    }

    async function startCapture(current) {
      if (session !== current || current.stopRequested) return;
      current.phase = 'requesting-microphone';
      refreshControls();
      setStatus(current.target, 'Requesting microphone permission…', 'is-listening');
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
        if (session !== current || current.stopRequested) {
          stream.getTracks().forEach(track => track.stop());
          return;
        }
        const audioContext = new AudioContextClass({ latencyHint: 'interactive' });
        await audioContext.resume();
        const source = audioContext.createMediaStreamSource(stream);
        const analyser = audioContext.createAnalyser();
        const processor = audioContext.createScriptProcessor(4096, 1, 1);
        const silentGain = audioContext.createGain();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = .65;
        silentGain.gain.value = 0;
        source.connect(analyser);
        analyser.connect(processor);
        processor.connect(silentGain);
        silentGain.connect(audioContext.destination);
        Object.assign(current, { stream, audioContext, source, analyser, processor, silentGain, sampleRate: audioContext.sampleRate, phase: 'listening' });
        processor.onaudioprocess = event => ingestAudio(current, event.inputBuffer.getChannelData(0));
        refreshControls();
        setStatus(current.target, 'Listening on this device ··· speak naturally.', 'is-listening');
      } catch (error) {
        if (session !== current) return;
        const code = error?.name === 'NotAllowedError' || error?.name === 'SecurityError'
          ? 'not-allowed'
          : error?.name === 'NotFoundError' ? 'audio-capture' : 'aborted';
        const message = errorMessage(code);
        finish(current, message, '');
        showToast(message, 'error');
      }
    }

    function handleWorkerMessage(event) {
      const message = event.data || {};
      const current = session;
      if (message.type === 'model-loading') {
        workerState = 'loading';
        modelProgress = Math.max(modelProgress, Number(message.progress) || 0);
        if (current) {
          current.phase = 'loading-model';
          refreshControls();
          setStatus(current.target, `Preparing private Whisper model — ${Math.round(modelProgress)}%. First use downloads about 95 MB once.`, 'is-listening');
        }
        return;
      }
      if (message.type === 'model-ready') {
        workerState = 'ready';
        modelProgress = 100;
        if (current?.phase === 'loading-model') void startCapture(current);
        return;
      }
      if (message.type === 'model-error') {
        workerState = 'error';
        if (current) {
          const text = errorMessage('model');
          finish(current, text, '');
          showToast(text, 'error');
        }
        return;
      }
      if (!current || message.sessionId !== current.id) return;
      if (message.type === 'transcription-error') {
        const text = 'On-device transcription failed. Your captured words were preserved where possible; tap the microphone to retry.';
        finish(current, text, current.finalText.trim() ? 'is-ready' : '');
        showToast(text, 'error');
        return;
      }
      if (message.type !== 'transcript') return;
      const rawText = normalizeCandidateText(message.text);
      const rejectedHallucination = isLikelySilenceHallucination(rawText, message);
      const text = rejectedHallucination ? '' : rawText;
      if (message.final) {
        current.pendingFinals = Math.max(0, current.pendingFinals - 1);
        if (text) current.finalText = `${current.finalText} ${text}`.trim();
        if (rejectedHallucination) setStatus(current.target, 'Unclear audio was ignored — keep speaking naturally.', 'is-listening');
        if (message.segmentId !== current.segmentId) current.interimText = '';
        renderTranscript(current);
        if (current.stopRequested && current.pendingFinals === 0) {
          finish(current, current.finalText.trim() ? reviewMessage(current.spec.context) : 'Listening stopped. No transcript was added.', current.finalText.trim() ? 'is-ready' : '');
        }
      } else if (message.requestId >= current.latestRenderedRequest && message.segmentId === current.segmentId) {
        current.latestRenderedRequest = message.requestId;
        current.interimText = text;
        renderTranscript(current);
      }
    }

    function ensureWorker(current) {
      if (!worker || workerState === 'error') {
        try { worker?.terminate(); } catch {}
        worker = new WorkerClass(workerUrl, { type: 'module', name: 'edgebook-on-device-whisper' });
        workerState = 'loading';
        modelProgress = 0;
        worker.addEventListener('message', handleWorkerMessage);
        worker.addEventListener('error', () => {
          workerState = 'error';
          const active = session;
          if (active) {
            const text = errorMessage('model');
            finish(active, text, '');
            showToast(text, 'error');
          }
        });
      }
      if (workerState === 'ready') void startCapture(current);
      else {
        current.phase = 'loading-model';
        worker.postMessage({ type: 'load', sessionId: current.id });
      }
    }

    function stop({ quiet = false, immediate = false } = {}) {
      const current = session;
      if (!current) return;
      if (immediate) {
        promoteInterim(current);
        unschedule(current.watchdog);
        stopCapture(current);
        worker?.postMessage({ type: 'cancel', sessionId: current.id });
        setSession(null);
        current.element.removeEventListener('input', current.onUserInput);
        current.element.readOnly = current.wasReadOnly;
        refreshControls();
        if (!quiet) setStatus(current.target, current.finalText.trim() ? reviewMessage(current.spec.context) : 'Listening stopped. No transcript was added.', current.finalText.trim() ? 'is-ready' : '');
        return;
      }
      if (current.stopRequested) return;
      current.stopRequested = true;
      current.phase = 'finishing';
      stopCapture(current);
      refreshControls();
      setStatus(current.target, 'Finishing on-device transcript…', 'is-listening');
      submitSegment(current, true);
      if (current.pendingFinals === 0) {
        const captured = Boolean(current.finalText.trim() || current.interimText.trim());
        finish(current, captured ? reviewMessage(current.spec.context) : 'Listening stopped. No transcript was added.', captured ? 'is-ready' : '');
        return;
      }
      unschedule(current.watchdog);
      current.watchdog = schedule(() => {
        if (session === current) {
          promoteInterim(current);
          finish(current, reviewMessage(current.spec.context), 'is-ready');
        }
      }, 12000);
    }

    async function toggle(target) {
      const spec = targetSpec(target);
      const element = document.getElementById(target);
      const support = capability();
      if (!spec || !element) return;
      if (session?.target === target) {
        stop();
        return;
      }
      if (session) stop({ quiet: true, immediate: true });
      if (!support.available) {
        refreshControls();
        setStatus(target, support.message);
        showToast(support.message, 'info');
        return;
      }
      if (spec.context === 'dailyjournal') cancelDailyAutosave();
      const current = {
        id: `dictation-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        target,
        spec,
        element,
        baseText: element.value,
        finalText: '',
        interimText: '',
        wasReadOnly: element.readOnly,
        phase: 'loading-model',
        stopRequested: false,
        watchdog: null,
        stream: null,
        audioContext: null,
        source: null,
        analyser: null,
        processor: null,
        silentGain: null,
        sampleRate: 16000,
        segmentId: 1,
        chunks: [],
        sampleCount: 0,
        speechMs: 0,
        speechStarted: false,
        lastVoiceAt: 0,
        lastInterimAt: 0,
        segmentStartedAt: 0,
        preRoll: [],
        noiseFloor: .003,
        peakRms: 0,
        voicedChunks: 0,
        totalChunks: 0,
        pendingFinals: 0,
        latestInterimRequest: 0,
        latestRenderedRequest: 0,
      };
      current.onUserInput = () => {
        if (session !== current) return;
        unschedule(current.watchdog);
        stopCapture(current);
        worker?.postMessage({ type: 'cancel', sessionId: current.id });
        setSession(null);
        element.removeEventListener('input', current.onUserInput);
        refreshControls();
        setStatus(target, 'Dictation stopped so your edit is preserved. Review the text before saving.', 'is-ready');
      };
      setSession(current);
      element.addEventListener('input', current.onUserInput);
      refreshControls();
      setStatus(target, 'Preparing private on-device Whisper…', 'is-listening');
      ensureWorker(current);
    }

    function destroy() {
      stop({ quiet: true, immediate: true });
      try { worker?.terminate(); } catch {}
      worker = null;
      workerState = 'idle';
      modelProgress = 0;
    }

    return Object.freeze({
      targetSpec,
      controlHtml,
      statusHtml,
      capability,
      errorMessage,
      joinText,
      toggle,
      stop,
      refreshControls,
      destroy,
      get activeSession() { return session; },
      get modelState() { return workerState; },
    });
  }

  global.createEdgebookDictationController = createController;
})(globalThis);
