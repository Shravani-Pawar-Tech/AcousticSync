// audioEngine.js — v3: fixes retries silently generating NEW sequence
// numbers instead of resending the SAME logical frame.
//
// ROOT CAUSE (confirmed from real dual-tab test logs): the old
// transmitFrame() incremented this.seq on every call, including calls
// made from app.js's retry loop. That meant a "retry" of a failed
// message was never actually a retransmission — it was a structurally
// new frame with a new seq number and identical text, which is exactly
// why the receiver displayed the same message twice (Image 15 in the
// test — "hello this is shtavai on first tab" arrived at :11:57:10
// AND :11:57:18, 8s apart, matching the retry interval) while the
// SENDER simultaneously logged the message as FAILED (Image 5) because
// it was waiting for an ACK tied to a seq number that changed out from
// under it every attempt.
//
// FIX: sequence allocation is now separate from transmission.
//   - allocateSeq()            -> call ONCE per logical message
//   - transmitFrameWithSeq()   -> call on EVERY attempt (incl. retries),
//                                 reusing the same seq each time
//   - transmitFrame()          -> convenience wrapper (allocate + send)
//                                 for one-shot frames that never retry
//                                 (PING, ACK, and any legacy caller)
//
// Everything else (calibration, CSMA gating, self-hearing mute, mic
// lifecycle/shutdown) is unchanged from the version you tested.

function convertTypedArray(src, type) {
  const buffer = new ArrayBuffer(src.byteLength);
  new src.constructor(buffer).set(src);
  return new type(buffer);
}

class AudioEngine {
  constructor() {
    this.audioCtx = null;
    this.analyser = null;
    this.ggwave = null;
    this.instance = null;
    this.myDeviceId = this._getOrCreatePeerId();

    this.processorNode = null;
    this.useAudibleFallback = false;

    this.seq = 0;

    this.noiseFloor = 20;
    this.activityThreshold = 40;
    this.busyThreshold = 35;
    this.isCalibrated = false;

    this._muteDecodeUntil = 0;
    this.micStream = null;
  }

  _getOrCreatePeerId() {
    try {
      const existing = sessionStorage.getItem('acousticsync_peer_id');
      if (existing) return existing;
      const id = Math.floor(Math.random() * 0xFFFF).toString(16).toUpperCase().padStart(4, '0');
      sessionStorage.setItem('acousticsync_peer_id', id);
      return id;
    } catch (e) {
      return Math.floor(Math.random() * 0xFFFF).toString(16).toUpperCase().padStart(4, '0');
    }
  }

  async init() {
    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });

    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    });

    const source = this.audioCtx.createMediaStreamSource(this.micStream);
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 2048;
    source.connect(this.analyser);

    if (window.ggwave_factory) {
      this.ggwave = await window.ggwave_factory();
      const parameters = this.ggwave.getDefaultParameters();
      parameters.sampleRateInp = this.audioCtx.sampleRate;
      parameters.sampleRateOut = this.audioCtx.sampleRate;
      this.instance = this.ggwave.init(parameters);
    } else {
      console.error("ggwave_factory not found — check that ggwave.js loaded before audioEngine.js");
    }
  }

  async calibrateNoiseFloor(durationMs = 1500, onProgress = null) {
    if (!this.analyser || !this.audioCtx) {
      throw new Error('calibrateNoiseFloor() called before init()');
    }
    const result = await NoiseCalibration.calibrate(this.analyser, this.audioCtx, durationMs, onProgress);
    this.noiseFloor = result.noiseFloor;
    this.activityThreshold = result.recommendedActivityThreshold;
    this.busyThreshold = result.recommendedBusyThreshold;
    this.isCalibrated = true;
    return result;
  }

  _playWaveform(text, protocol, volume) {
    const waveformInt8 = this.ggwave.encode(this.instance, text, protocol, volume);
    const waveform = convertTypedArray(waveformInt8, Float32Array);

    const buf = this.audioCtx.createBuffer(1, waveform.length, this.audioCtx.sampleRate);
    buf.getChannelData(0).set(waveform);

    const bufSource = this.audioCtx.createBufferSource();
    bufSource.buffer = buf;
    bufSource.connect(this.audioCtx.destination);

    const durationMs = (waveform.length / this.audioCtx.sampleRate) * 1000;
    this._muteDecodeUntil = performance.now() + durationMs + 150;

    return new Promise((resolve) => {
      bufSource.onended = () => resolve(durationMs);
      bufSource.start();
    });
  }

  // NEW: allocate a sequence number ONCE for a logical message, before
  // any of its transmit attempts. Callers doing their own retry loop
  // (app.js's sendReliable) should call this exactly once and reuse
  // the result across every attempt via transmitFrameWithSeq().
  allocateSeq() {
    this.seq = (this.seq + 1) & 0xFF;
    return this.seq;
  }

  // NEW: transmits a frame using an EXPLICIT, caller-supplied seq
  // number rather than allocating a new one. This is what makes a
  // retry an actual retransmission of the same frame instead of a
  // structurally new message.
  async transmitFrameWithSeq(type, payload, seq, onBackoff = null) {
    if (!this.ggwave || this.instance === null || !this.audioCtx) return null;

    const frame = FrameProtocol.buildFrame(type, this.myDeviceId, seq, payload);

    const protocol = this.useAudibleFallback
      ? this.ggwave.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_FAST
      : this.ggwave.ProtocolId.GGWAVE_PROTOCOL_ULTRASOUND_FAST;
    const volume = this.useAudibleFallback ? 10 : 15;

    const doTransmit = () => this._playWaveform(frame, protocol, volume);

    if (this.isCalibrated) {
      await CSMA.transmitWhenClear(this.analyser, this.audioCtx, this.busyThreshold, doTransmit, 5, onBackoff);
    } else {
      await doTransmit();
    }

    return { frame, seq };
  }

  // Convenience wrapper for one-shot frames (PING, ACK, or any caller
  // that doesn't need retry-safe seq reuse) — allocates a fresh seq
  // and sends immediately. Retried messages should NOT use this;
  // use allocateSeq() + transmitFrameWithSeq() instead (see app.js).
  async transmitFrame(type, payload, onBackoff = null) {
    const seq = this.allocateSeq();
    return this.transmitFrameWithSeq(type, payload, seq, onBackoff);
  }

  // Legacy alias — unchanged, still used by test.html.
  transmit(text, protocolOverride = null) {
    if (!this.ggwave || this.instance === null || !this.audioCtx) return;
    const protocol = protocolOverride ||
      (this.useAudibleFallback
        ? this.ggwave.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_FAST
        : this.ggwave.ProtocolId.GGWAVE_PROTOCOL_ULTRASOUND_FAST);
    const volume = this.useAudibleFallback ? 10 : 15;
    this._playWaveform(text, protocol, volume);
  }

  startListening(onFrameReceived) {
    const bufferSize = 4096;
    this.processorNode = this.audioCtx.createScriptProcessor(bufferSize, 1, 1);

    this.analyser.connect(this.processorNode);
    const silentSink = this.audioCtx.createGain();
    silentSink.gain.value = 0;
    this.processorNode.connect(silentSink);
    silentSink.connect(this.audioCtx.destination);

    this.processorNode.onaudioprocess = (event) => {
      if (!this.ggwave || this.instance === null) return;

      const samples = event.inputBuffer.getChannelData(0);
      const res = this.ggwave.decode(
        this.instance,
        convertTypedArray(new Float32Array(samples), Int8Array)
      );

      if (res && res.length > 0) {
        if (performance.now() < this._muteDecodeUntil) return;

        const decodedText = new TextDecoder("utf-8").decode(res);
        const parsed = FrameProtocol.parseFrame(decodedText);
        onFrameReceived(parsed, decodedText);
      }
    };
  }

  stopListening() {
    if (this.processorNode) {
      this.processorNode.disconnect();
      this.processorNode.onaudioprocess = null;
      this.processorNode = null;
    }
  }

  releaseMicrophone() {
    if (this.micStream) {
      this.micStream.getTracks().forEach((track) => track.stop());
      this.micStream = null;
    }
  }

  async shutdown() {
    this.stopListening();
    this.releaseMicrophone();
    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      await this.audioCtx.close();
    }
  }

  startActivityMeter(onActivity) {
    const bufferLength = this.analyser.frequencyBinCount;
    const freqData = new Uint8Array(bufferLength);
    const nyquist = this.audioCtx.sampleRate / 2;
    const lowBin = Math.floor(bufferLength * (15000 / nyquist));
    const highBin = Math.min(bufferLength - 1, Math.floor(bufferLength * (20000 / nyquist)));

    const loop = () => {
      this.analyser.getByteFrequencyData(freqData);
      let peak = 0;
      for (let i = lowBin; i <= highBin; i++) peak = Math.max(peak, freqData[i]);
      onActivity(peak, this.activityThreshold);
      requestAnimationFrame(loop);
    };
    loop();
  }
}
