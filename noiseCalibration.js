// noiseCalibration.js — NEW FILE
// Replaces the hardcoded "peak > 40" activity threshold with a baseline
// measured from the actual room/device the app is running on.
//
// Why this matters concretely: a hardcoded 40 might be far too sensitive
// in a noisy room (constant false "signal detected") or far too high on
// a phone with a quieter mic (real signals never cross it). Sampling
// 1.5s of real ambient energy on THIS device, in THIS room, before you
// start, and setting the threshold relative to that, fixes both cases
// at once. This is a well-established DSP technique — the tradeoff is
// simply that it doesn't help if ambient noise changes drastically mid-
// session (e.g. someone starts talking loudly) — that's a live problem,
// not something a one-time calibration step can solve.

const NoiseCalibration = (() => {

  // Samples the 15-20kHz band for `durationMs` and returns the measured
  // baseline (average peak) plus a recommended busy-threshold.
  function calibrate(analyser, audioCtx, durationMs = 1500, onProgress = null) {
    return new Promise((resolve) => {
      const bufferLength = analyser.frequencyBinCount;
      const freqData = new Uint8Array(bufferLength);
      const nyquist = audioCtx.sampleRate / 2;
      const lowBin = Math.floor(bufferLength * (15000 / nyquist));
      const highBin = Math.min(bufferLength - 1, Math.floor(bufferLength * (20000 / nyquist)));

      const samples = [];
      const startTime = performance.now();

      function sampleLoop() {
        analyser.getByteFrequencyData(freqData);
        let peak = 0;
        for (let i = lowBin; i <= highBin; i++) peak = Math.max(peak, freqData[i]);
        samples.push(peak);

        const elapsed = performance.now() - startTime;
        if (onProgress) onProgress(Math.min(1, elapsed / durationMs));

        if (elapsed < durationMs) {
          requestAnimationFrame(sampleLoop);
        } else {
          // Use mean + a margin (not just max) — a single stray spike
          // (door slam, cough) shouldn't permanently inflate the floor.
          const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
          const max = Math.max(...samples);
          resolve({
            noiseFloor: Math.round(mean),
            peakDuringCalibration: max,
            recommendedActivityThreshold: Math.round(mean + 20), // "signal detected" line
            recommendedBusyThreshold: Math.round(mean + 15),      // CSMA "channel busy" line
            sampleCount: samples.length
          });
        }
      }
      sampleLoop();
    });
  }

  return { calibrate };
})();
