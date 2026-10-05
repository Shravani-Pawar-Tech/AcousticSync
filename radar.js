// radar.js — FIXED
//
// BUG 1 (this was the reason dots never appeared): node angle was
// computed as parseInt(id.split('-')[1]). That assumes IDs look like
// "peer-123". Real peer IDs are plain 4-char hex strings like "A1B2"
// with no hyphen at all, so split('-')[1] was always undefined,
// parseInt(undefined) is NaN, and canvas silently refuses to draw
// anything at NaN coordinates — even when a peer WAS correctly
// detected and added to activeNodes. Fixed by hashing the hex ID
// itself into an angle: parseInt(id, 16) % 360.
//
// BUG 2 (minor, wastes CPU / can cause visual glitches): draw() was
// being called twice — once at module load with isRunning=false, once
// on Start with isRunning=true — and each call spawned its OWN
// permanent requestAnimationFrame loop with isRunning frozen at
// whatever value it had at that call. That means two competing loops
// running forever. Fixed so exactly one loop starts, and its "running"
// state can be updated afterwards without starting a second loop.
//
// Public interface (draw(activeNodes, isRunning)) is unchanged, so
// app.js does not need any changes for this file.

class RadarDrawer {
  constructor(canvasElement) {
    this.canvas = canvasElement;
    this.ctx = canvasElement.getContext('2d');
    this.angle = 0;
    this._activeNodes = new Map();
    this._isRunning = false;
    this._loopStarted = false;
  }

  draw(activeNodes, isRunning) {
    this._activeNodes = activeNodes;
    this._isRunning = isRunning;

    if (!this._loopStarted) {
      this._loopStarted = true;
      this._loop();
    }
  }

  _loop() {
    const cx = 100, cy = 100, r = 90;
    this.ctx.clearRect(0, 0, 200, 200);

    // Radar circular grid
    this.ctx.strokeStyle = 'rgba(0, 240, 255, 0.2)';
    this.ctx.lineWidth = 1;
    this.ctx.beginPath();
    this.ctx.arc(cx, cy, r, 0, Math.PI * 2);
    this.ctx.arc(cx, cy, r * 0.6, 0, Math.PI * 2);
    this.ctx.arc(cx, cy, r * 0.3, 0, Math.PI * 2);
    this.ctx.moveTo(cx - r, cy); this.ctx.lineTo(cx + r, cy);
    this.ctx.moveTo(cx, cy - r); this.ctx.lineTo(cx, cy + r);
    this.ctx.stroke();

    // Sweeping line animation
    if (this._isRunning) {
      this.angle += 0.03;
      this.ctx.beginPath();
      this.ctx.moveTo(cx, cy);
      this.ctx.arc(cx, cy, r, this.angle, this.angle + 0.2);
      this.ctx.fillStyle = 'rgba(0, 240, 255, 0.15)';
      this.ctx.fill();
    }

    // Detected nearby nodes
    const now = Date.now();
    this._activeNodes.forEach((node, id) => {
      if (now - node.lastSeen < 20000) {
        // FIX: was parseInt(id.split('-')[1]) -> NaN for hex IDs like "A1B2"
        const nodeAngle = (parseInt(id, 16) % 360) * (Math.PI / 180);
        const nx = cx + Math.cos(nodeAngle) * (r * node.distance);
        const ny = cy + Math.sin(nodeAngle) * (r * node.distance);

        this.ctx.fillStyle = '#2ed573';
        this.ctx.beginPath();
        this.ctx.arc(nx, ny, 5, 0, Math.PI * 2);
        this.ctx.fill();

        this.ctx.fillStyle = '#fff';
        this.ctx.font = '9px monospace';
        this.ctx.fillText(id, nx + 7, ny + 3);
      }
    });

    requestAnimationFrame(() => this._loop());
  }
}
