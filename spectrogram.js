// spectrogram.js — FIXED
//
// BUG (this was the reason it looked permanently black): the previous
// version set `canvas.width = canvas.clientWidth` and `canvas.height =
// canvas.clientHeight` on EVERY frame (~60 times/sec). In the Canvas
// API, assigning to .width or .height — even to the exact same value —
// clears the entire bitmap. So on every single frame the canvas was
// wiped an instant before the "shift the old image left and paste it
// back" trick ran, meaning the scrolling waterfall history could never
// accumulate. It only ever showed the current instant's 2px column,
// which looks flat/black unless a strong signal happens to be present
// at that exact moment. Sizing now happens once (and again on window
// resize), never inside the per-frame draw loop.

class SpectrogramDrawer {
  constructor(canvasElement) {
    this.canvas = canvasElement;
    this.ctx = canvasElement.getContext('2d');
    this._sized = false;

    window.addEventListener('resize', () => { this._sized = false; });
  }

  _ensureSized() {
    if (this._sized) return;
    this.canvas.width = this.canvas.clientWidth;
    this.canvas.height = this.canvas.clientHeight;
    this._sized = true;
  }

  draw(analyser) {
    if (!analyser) return;

    this._ensureSized();
    const width = this.canvas.width;
    const height = this.canvas.height;

    const freqData = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(freqData);

    // Shift previous frame left to scroll over time — now actually
    // accumulates, since the canvas is no longer being wiped each frame.
    const imgData = this.ctx.getImageData(2, 0, width - 2, height);
    this.ctx.putImageData(imgData, 0, 0);

    // Filter strictly for 15 kHz to 20 kHz
    const binMin = Math.floor(15000 / (48000 / 2048));
    const binMax = Math.floor(20000 / (48000 / 2048));

    for (let i = 0; i < height; i++) {
      const binIndex = Math.floor(binMin + (i / height) * (binMax - binMin));
      const val = freqData[binIndex];

      this.ctx.fillStyle = `hsl(${280 - (val / 255) * 280}, 100%, ${val / 512 * 100}%)`;
      this.ctx.fillRect(width - 2, height - i, 2, 1);
    }

    requestAnimationFrame(() => this.draw(analyser));
  }
}
