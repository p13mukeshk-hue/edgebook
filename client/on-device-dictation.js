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

  const INTERIM_INTERVAL_MS = 2800;
  const SILENCE_MS = 900;
  const MAX_SEGMENT_MS = 18000;
  const BROWSER_RESTART_DELAY_MS = 240;
  const FINALIZATION_STATUS_INTERVAL_MS = 2000;
  const MIN_AUTO_SPEECH_MS = 300;
  const MIN_INTERIM_CAPTURE_MS = 900;
  const MIN_MANUAL_CAPTURE_MS = 350;
  const SILENCE_HALLUCINATIONS = new Set(['you', 'thank you', 'thanks for watching', 'bye', 'goodbye']);

  function createController(options = {}) {
    const root = options.root || global;
    const document = options.document || root.document;
    const navigator = options.navigator || root.navigator;
    const performance = options.performance || root.performance || { now: () => Date.now() };
    const WorkerClass = options.WorkerClass || root.Worker;
    const AudioContextClass = options.AudioContextClass || root.AudioContext || root.webkitAudioContext;
    const SpeechRecognitionClass = options.SpeechRecognitionClass === undefined
      ? (root.SpeechRecognition || root.webkitSpeechRecognition)
      : options.SpeechRecognitionClass;
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

    function resolveCompletion(current) {
      if (current.completionResolved) return;
      current.completionResolved = true;
      current.resolveCompletion?.({ text: current.finalText.trim(), target: current.target });
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
      return `<button type="button" class="trade-voice-btn" data-dictation-target="${safeTarget}" onclick="toggleDictation('${safeTarget}')" aria-label="Dictate ${safeLabel}" aria-pressed="false" title="Live Chrome or Edge dictation with a private on-device fallback."><i class="fa-solid fa-microphone"></i><span class="trade-voice-wave" aria-hidden="true"><b></b><b></b><b></b><b></b></span></button>`;
    }

    function statusHtml(target) {
      return `<div class="dictation-status trade-voice-status" id="voice-status-${escapeHtml(target)}" role="status" aria-live="polite"></div>`;
    }

    function capability() {
      if (root.isSecureContext !== true) return { available: false, message: 'Voice dictation requires a secure HTTPS connection. You can still type here.' };
      if (typeof SpeechRecognitionClass === 'function') return { available: true, engine: 'browser', message: '' };
      if (!navigator?.mediaDevices?.getUserMedia) return { available: false, message: 'This browser cannot access a microphone. You can still type here.' };
      if (typeof WorkerClass !== 'function' || typeof AudioContextClass !== 'function') return { available: false, message: 'Voice dictation is not supported in this browser. Use current Chrome or Edge, or type here.' };
      return { available: true, message: '' };
    }

    function dictationLanguage() {
      const value = String(navigator?.language || navigator?.languages?.[0] || document?.documentElement?.lang || 'en-IN').trim();
      return /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(value) ? value : 'en-IN';
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
        button.setAttribute('aria-label', active ? 'Stop voice dictation' : `Dictate ${spec?.label || 'note'}`);
        const icon = button.querySelector('i');
        if (icon) icon.className = active ? 'fa-solid fa-stop' : 'fa-solid fa-microphone';
        button.title = support.available
          ? (active ? 'Stop dictation' : 'Live Chrome or Edge dictation with a private on-device fallback.')
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

    function releaseRecognition(current, abort = false) {
      const recognition = current.recognition;
      current.recognition = null;
      if (!recognition) return;
      for (const name of ['onstart', 'onaudiostart', 'onspeechstart', 'onspeechend', 'onresult', 'onerror', 'onend']) recognition[name] = null;
      if (abort) {
        try { recognition.abort(); } catch {}
      }
    }

    function finish(current, message, state = 'is-ready') {
      if (session !== current) return;
      promoteInterim(current);
      unschedule(current.watchdog);
      unschedule(current.restartTimer);
      stopCapture(current);
      releaseRecognition(current, true);
      if (current.engine === 'whisper') worker?.postMessage({ type: 'cancel', sessionId: current.id });
      setSession(null);
      current.element.removeEventListener('input', current.onUserInput);
      current.element.readOnly = current.wasReadOnly;
      refreshControls();
      setStatus(current.target, message, state);
      resolveCompletion(current);
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
      current.energySquaredSum = 0;
      current.energySampleCount = 0;
    }

    function submitSegment(current, final = false, forced = false) {
      if (session !== current || !current.sampleCount) return false;
      const audioDurationMs = current.sampleCount / current.sampleRate * 1000;
      const detectedSpeech = current.speechStarted && current.speechMs >= MIN_AUTO_SPEECH_MS;
      if (forced) {
        if (audioDurationMs < MIN_MANUAL_CAPTURE_MS) return false;
      } else if (!detectedSpeech || (!final && audioDurationMs < MIN_INTERIM_CAPTURE_MS)) return false;
      const audio = concatenateAudio(current.chunks, current.sampleCount);
      const segmentId = current.segmentId;
      const requestId = ++workerRequest;
      const activity = {
        speechMs: Math.round(current.speechMs),
        audioDurationMs: Math.round(audioDurationMs),
        peakRms: current.peakRms,
        voicedRatio: current.totalChunks ? current.voicedChunks / current.totalChunks : 0,
        captureRms: current.energySampleCount ? Math.sqrt(current.energySquaredSum / current.energySampleCount) : 0,
        forced,
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
      const audioDurationMs = Number(message.audioDurationMs) || 0;
      const voicedRatio = Number(message.voicedRatio) || 0;
      const peakRms = Number(message.peakRms) || 0;
      const captureRms = Number(message.captureRms) || 0;
      const weakAudio = (speechMs < MIN_AUTO_SPEECH_MS && message.forced !== true) || (voicedRatio < .04 && peakRms < .006 && captureRms < .0015);
      const implausiblySparse = audioDurationMs >= MIN_INTERIM_CAPTURE_MS && words.length === 1;
      return SILENCE_HALLUCINATIONS.has(normalized) && (weakAudio || implausiblySparse);
    }

    function switchToWhisper(current, reason = '') {
      if (session !== current || current.stopRequested || current.engine === 'whisper') return;
      promoteInterim(current);
      if (!navigator?.mediaDevices?.getUserMedia || typeof WorkerClass !== 'function' || typeof AudioContextClass !== 'function') {
        const message = 'Chrome speech streaming disconnected and this browser cannot run the on-device fallback. Reload in current Chrome or Edge and try again.';
        finish(current, message, current.finalText.trim() ? 'is-ready' : '');
        showToast(message, 'error');
        return;
      }
      current.engine = 'whisper';
      current.phase = 'loading-model';
      current.browserFallbackReason = reason;
      unschedule(current.restartTimer);
      releaseRecognition(current, true);
      updateMeter(current, 0, false);
      refreshControls();
      setStatus(current.target, 'Chrome speech streaming disconnected — continuing with private on-device transcription…', 'is-listening');
      ensureWorker(current);
    }

    function scheduleBrowserRestart(current) {
      if (session !== current || current.stopRequested || current.engine !== 'browser') return;
      unschedule(current.restartTimer);
      current.restartTimer = schedule(() => {
        if (session !== current || current.stopRequested || current.engine !== 'browser') return;
        current.phase = 'requesting-microphone';
        refreshControls();
        setStatus(current.target, 'Reconnecting live Chrome transcription…', 'is-listening');
        try { current.recognition?.start(); }
        catch { switchToWhisper(current, 'browser-restart-failed'); }
      }, BROWSER_RESTART_DELAY_MS);
    }

    function startBrowserRecognition(current) {
      if (session !== current || current.stopRequested || typeof SpeechRecognitionClass !== 'function') return false;
      let recognition;
      try { recognition = new SpeechRecognitionClass(); }
      catch { switchToWhisper(current, 'browser-constructor-failed'); return false; }
      current.engine = 'browser';
      current.recognition = recognition;
      current.phase = 'requesting-microphone';
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;
      recognition.lang = dictationLanguage();
      recognition.onstart = () => {
        if (session !== current || current.engine !== 'browser') return;
        current.phase = 'listening';
        current.browserStarted = true;
        current.lastBrowserError = '';
        refreshControls();
        setStatus(current.target, 'Chrome live transcription is listening… speak naturally.', 'is-listening');
      };
      recognition.onaudiostart = () => {
        if (session !== current || current.engine !== 'browser') return;
        setStatus(current.target, 'Listening… your words will appear here live.', 'is-listening');
      };
      recognition.onspeechstart = () => {
        if (session !== current || current.engine !== 'browser') return;
        updateMeter(current, .035, true);
        setStatus(current.target, 'Speech detected — adding words live…', 'is-listening');
      };
      recognition.onspeechend = () => {
        if (session === current && current.engine === 'browser') updateMeter(current, 0, false);
      };
      recognition.onresult = event => {
        if (session !== current || current.engine !== 'browser') return;
        let interimText = '';
        for (let index = Number(event.resultIndex) || 0; index < event.results.length; index += 1) {
          const text = String(event.results[index]?.[0]?.transcript || '').trim();
          if (!text) continue;
          if (event.results[index].isFinal) current.finalText = `${current.finalText} ${text}`.trim();
          else interimText = `${interimText} ${text}`.trim();
        }
        current.interimText = interimText;
        renderTranscript(current);
      };
      recognition.onerror = event => {
        if (session !== current || current.engine !== 'browser') return;
        const code = String(event?.error || '');
        current.lastBrowserError = code;
        if (code === 'no-speech') {
          setStatus(current.target, 'Still listening… start speaking when you are ready.', 'is-listening');
          return;
        }
        if (code === 'aborted' && current.stopRequested) return;
        if (code === 'network' || code === 'service-not-allowed' || code === 'language-not-supported' || code === 'aborted') {
          switchToWhisper(current, code || 'browser-service-ended');
          return;
        }
        const message = errorMessage(code);
        finish(current, message, current.finalText.trim() || current.interimText.trim() ? 'is-ready' : '');
        showToast(message, 'error');
      };
      recognition.onend = () => {
        if (session !== current || current.engine !== 'browser') return;
        updateMeter(current, 0, false);
        if (current.stopRequested) {
          const captured = Boolean(current.finalText.trim() || current.interimText.trim());
          finish(current, captured ? reviewMessage(current.spec.context) : 'Listening stopped. No transcript was added.', captured ? 'is-ready' : '');
          return;
        }
        promoteInterim(current);
        scheduleBrowserRestart(current);
      };
      refreshControls();
      setStatus(current.target, 'Connecting to Chrome live transcription…', 'is-listening');
      try { recognition.start(); }
      catch { switchToWhisper(current, 'browser-start-failed'); return false; }
      return true;
    }

    function ingestAudio(current, input) {
      if (session !== current || current.phase !== 'listening' || current.stopRequested) return;
      const chunk = new Float32Array(input);
      const now = performance.now();
      let sum = 0;
      for (let index = 0; index < chunk.length; index += 1) sum += chunk[index] * chunk[index];
      const rms = Math.sqrt(sum / Math.max(1, chunk.length));
      if (!current.speechStarted) current.noiseFloor = current.noiseFloor * .94 + rms * .06;
      const speaking = rms > Math.max(.0035, current.noiseFloor * 1.6);
      const chunkMs = chunk.length / current.sampleRate * 1000;
      updateMeter(current, rms, speaking);
      if (!current.sampleCount) current.segmentStartedAt = now;
      current.chunks.push(chunk);
      current.sampleCount += chunk.length;
      current.totalChunks += 1;
      current.peakRms = Math.max(current.peakRms, rms);
      current.energySquaredSum += sum;
      current.energySampleCount += chunk.length;
      if (!current.speechStarted && speaking) {
        current.speechStarted = true;
      }
      if (speaking) {
        current.lastVoiceAt = now;
        current.speechMs += chunkMs;
        current.voicedChunks += 1;
        setStatus(current.target, 'Speech detected — transcribing privately on this device…', 'is-listening');
      }
      const elapsed = now - current.segmentStartedAt;
      const silence = current.lastVoiceAt ? now - current.lastVoiceAt : 0;
      const captureDurationMs = current.sampleCount / current.sampleRate * 1000;
      const captureRms = current.energySampleCount ? Math.sqrt(current.energySquaredSum / current.energySampleCount) : 0;
      const lowLevelSignal = current.peakRms >= .0015 && captureRms >= .00035;
      if ((current.speechMs >= MIN_AUTO_SPEECH_MS || lowLevelSignal) && captureDurationMs >= MIN_INTERIM_CAPTURE_MS && Date.now() - current.lastInterimAt >= INTERIM_INTERVAL_MS) {
        submitSegment(current, false, current.speechMs < MIN_AUTO_SPEECH_MS);
      }
      if (current.speechMs >= MIN_AUTO_SPEECH_MS && silence >= SILENCE_MS) submitSegment(current, true);
      else if (elapsed >= MAX_SEGMENT_MS) submitSegment(current, true, true);
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
        setStatus(current.target, 'Listening privately on this device ··· audio never leaves this device.', 'is-listening');
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
        if (!text && message.reason) current.lastEmptyReason = String(message.reason);
        if (rejectedHallucination) setStatus(current.target, 'Unclear audio was ignored — keep speaking naturally.', 'is-listening');
        if (message.segmentId !== current.segmentId) current.interimText = '';
        renderTranscript(current);
        if (current.stopRequested && current.pendingFinals === 0) {
          const emptyMessage = current.lastEmptyReason === 'audio-too-quiet'
            ? 'No words were captured because the microphone level was too low. Check the selected input and try again.'
            : 'Speech was captured, but no words were recognized. Please try again and speak naturally.';
          finish(current, current.finalText.trim() ? reviewMessage(current.spec.context) : emptyMessage, current.finalText.trim() ? 'is-ready' : '');
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
        try { worker = new WorkerClass(workerUrl, { type: 'module', name: 'edgebook-on-device-whisper' }); }
        catch {
          workerState = 'error';
          const text = errorMessage('model');
          finish(current, text, current.finalText.trim() ? 'is-ready' : '');
          showToast(text, 'error');
          return;
        }
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

    function scheduleWhisperFinalizationStatus(current) {
      unschedule(current.watchdog);
      const update = () => {
        if (session !== current || current.engine !== 'whisper' || !current.stopRequested || current.pendingFinals === 0) return;
        const count = current.pendingFinals;
        setStatus(current.target, `Finishing ${count} captured audio segment${count === 1 ? '' : 's'}… no recorded words will be discarded.`, 'is-listening');
        current.watchdog = schedule(update, FINALIZATION_STATUS_INTERVAL_MS);
      };
      update();
    }

    function stop({ quiet = false, immediate = false } = {}) {
      const current = session;
      if (!current) return Promise.resolve({ text: '', target: '' });
      if (immediate) {
        promoteInterim(current);
        unschedule(current.watchdog);
        unschedule(current.restartTimer);
        stopCapture(current);
        releaseRecognition(current, true);
        if (current.engine === 'whisper') worker?.postMessage({ type: 'cancel', sessionId: current.id });
        setSession(null);
        current.element.removeEventListener('input', current.onUserInput);
        current.element.readOnly = current.wasReadOnly;
        refreshControls();
        if (!quiet) setStatus(current.target, current.finalText.trim() ? reviewMessage(current.spec.context) : 'Listening stopped. No transcript was added.', current.finalText.trim() ? 'is-ready' : '');
        resolveCompletion(current);
        return current.completion;
      }
      if (current.stopRequested) return current.completion;
      current.stopRequested = true;
      current.phase = 'finishing';
      refreshControls();
      if (current.engine === 'browser') {
        setStatus(current.target, 'Finishing the live Chrome transcript…', 'is-listening');
        try { current.recognition?.stop(); }
        catch {
          const captured = Boolean(current.finalText.trim() || current.interimText.trim());
          finish(current, captured ? reviewMessage(current.spec.context) : 'Listening stopped. No transcript was added.', captured ? 'is-ready' : '');
        }
        if (session !== current) return current.completion;
        unschedule(current.watchdog);
        current.watchdog = schedule(() => {
          if (session === current) {
            const captured = Boolean(current.finalText.trim() || current.interimText.trim());
            finish(current, captured ? reviewMessage(current.spec.context) : 'Listening stopped. No transcript was added.', captured ? 'is-ready' : '');
          }
        }, 4000);
        return current.completion;
      }
      stopCapture(current);
      setStatus(current.target, 'Finishing the private on-device transcript…', 'is-listening');
      submitSegment(current, true, true);
      if (current.pendingFinals === 0) {
        const captured = Boolean(current.finalText.trim() || current.interimText.trim());
        finish(current, captured ? reviewMessage(current.spec.context) : 'The recording was too short to transcribe. Hold the microphone for a moment and speak naturally.', captured ? 'is-ready' : '');
        return current.completion;
      }
      scheduleWhisperFinalizationStatus(current);
      return current.completion;
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
      if (session) await stop({ quiet: true, immediate: true });
      if (!support.available) {
        refreshControls();
        setStatus(target, support.message);
        showToast(support.message, 'info');
        return;
      }
      if (spec.context === 'dailyjournal') cancelDailyAutosave();
      let resolveCurrentCompletion;
      const completion = new Promise(resolve => { resolveCurrentCompletion = resolve; });
      const current = {
        id: `dictation-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        target,
        spec,
        element,
        baseText: element.value,
        finalText: '',
        interimText: '',
        wasReadOnly: element.readOnly,
        phase: support.engine === 'browser' ? 'requesting-microphone' : 'loading-model',
        engine: support.engine === 'browser' ? 'browser' : 'whisper',
        stopRequested: false,
        watchdog: null,
        restartTimer: null,
        recognition: null,
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
        energySquaredSum: 0,
        energySampleCount: 0,
        pendingFinals: 0,
        lastEmptyReason: '',
        completion,
        resolveCompletion: resolveCurrentCompletion,
        completionResolved: false,
        latestInterimRequest: 0,
        latestRenderedRequest: 0,
      };
      current.onUserInput = () => {
        if (session !== current) return;
        unschedule(current.watchdog);
        unschedule(current.restartTimer);
        stopCapture(current);
        releaseRecognition(current, true);
        if (current.engine === 'whisper') worker?.postMessage({ type: 'cancel', sessionId: current.id });
        setSession(null);
        element.removeEventListener('input', current.onUserInput);
        refreshControls();
        setStatus(target, 'Dictation stopped so your edit is preserved. Review the text before saving.', 'is-ready');
        resolveCompletion(current);
      };
      setSession(current);
      element.addEventListener('input', current.onUserInput);
      refreshControls();
      if (support.engine === 'browser') startBrowserRecognition(current);
      else {
        setStatus(target, 'Preparing private on-device Whisper fallback…', 'is-listening');
        ensureWorker(current);
      }
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
