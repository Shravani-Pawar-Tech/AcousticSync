// csma.js — FIXED (one small but important change)
//
// CHANGE: doTransmit() is now awaited instead of fire-and-forget. This
// matters because audioEngine.js's _playWaveform() has been upgraded to
// return a Promise that resolves only when the waveform actually
// finishes playing (bufSource.onended), rather than resolving the
// instant playback starts. If transmitWhenClear() didn't await it, the
// caller (transmitFrame in audioEngine.js) would think a message was
// "SENT" before the audio had actually finished — which breaks the
// ARQ timing in app.js (the 2000ms ACK-wait timer needs to start only
// after transmission genuinely completes, not the moment it begins).
//
// Carrier-sense logic itself (isChannelClear) is unchanged.

const CSMA = (() => {

  function isChannelClear(analyser, audioCtx, noiseFloorRms) {
    const bufferLength = analyser.frequencyBinCount;
    const freqData = new Uint8Array(bufferLength);
    analyser.getByteFrequencyData(freqData);

    const nyquist = audioCtx.sampleRate / 2;
    const lowBin = Math.floor(bufferLength * (15000 / nyquist));
    const highBin = Math.min(bufferLength - 1, Math.floor(bufferLength * (20000 / nyquist)));

    let peak = 0;
    for (let i = lowBin; i <= highBin; i++) peak = Math.max(peak, freqData[i]);

    const busyThreshold = noiseFloorRms + 15;
    return peak < busyThreshold;
  }

  async function transmitWhenClear(analyser, audioCtx, noiseFloorRms, doTransmit, maxAttempts = 5, onBackoff = null) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (isChannelClear(analyser, audioCtx, noiseFloorRms)) {
        await doTransmit(); // FIX: was fire-and-forget
        return true;
      }
      const backoff = 200 + Math.random() * 600; // 200-800ms
      if (onBackoff) onBackoff(attempt + 1, Math.round(backoff));
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
    // Channel never cleared — transmit anyway rather than blocking
    // forever; CRC + ARQ downstream will catch a collision if it happens.
    await doTransmit(); // FIX: was fire-and-forget
    return false;
  }

  return { isChannelClear, transmitWhenClear };
})();
