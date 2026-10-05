// app.js — v3
//
// TWO FIXES IN THIS VERSION, both confirmed necessary by real dual-tab
// test logs (not theoretical):
//
// FIX 1 — Retries now reuse ONE sequence number (see audioEngine.js's
// allocateSeq()/transmitFrameWithSeq() split). Before this, every
// retry attempt got a brand-new seq, so a "retry" was indistinguishable
// from a genuinely new message — this alone explained duplicated
// message text arriving at the receiver while the sender simultaneously
// logged the message as FAILED.
//
// FIX 2 — Receiver-side de-dup cache (`seenFrames`). Even with FIX 1,
// a message CAN legitimately arrive twice acoustically (e.g. the
// original got through AND a retry also got through, because the
// thing that actually failed was the ACK coming back, not the message
// going out). The cache remembers the last 50 (sender, seq) pairs per
// peer and skips re-displaying/re-saving anything already seen — but
// still sends an ACK for the duplicate, since the sender's retry means
// its copy of our earlier ACK was the thing that got lost.
//
// ALSO CHANGED: ACK_TIMEOUT_MS raised 2000ms -> 4000ms (the original
// was tighter than real encode+playback+decode round-trip time), and
// the heartbeat PING interval now jitters (7-9s instead of a fixed
// 8s) so it stops reliably colliding with message/ACK traffic on a
// busy channel — both were visible contributors in the test logs
// (near-constant "Channel busy" backoffs up to attempt 5).
//
// Everything else — spectrogram, radar, calibration flow, IndexedDB
// history load, audible/ultrasonic toggle, clean mic shutdown — is
// unchanged from the version you tested.

const engine = new AudioEngine();
const spectrogram = new SpectrogramDrawer(document.getElementById('spectrogramCanvas'));
const radar = new RadarDrawer(document.getElementById('radarCanvas'));

const activeNodes = new Map();
let isRunning = false;
let pingTimeoutId = null; // NEW: was setInterval; now a jittered self-rescheduling setTimeout

const pendingAcks = new Map(); // seq -> { resolve, timeoutId }
const ACK_TIMEOUT_MS = 4000;   // CHANGED: was 2000
const MAX_RETRIES = 3;

// NEW: de-duplication cache. Map<senderId, Set<seq>>. Capped per-sender
// so it can't grow unbounded over a long session.
const seenFrames = new Map();
const SEEN_CACHE_LIMIT = 50;

function isDuplicate(sender, seq) {
  const set = seenFrames.get(sender);
  return !!set && set.has(seq);
}

function markSeen(sender, seq) {
  let set = seenFrames.get(sender);
  if (!set) {
    set = new Set();
    seenFrames.set(sender, set);
  }
  set.add(seq);
  if (set.size > SEEN_CACHE_LIMIT) {
    // Drop the oldest entry (Sets preserve insertion order in JS)
    set.delete(set.values().next().value);
  }
}

// DOM Elements
const startBtn = document.getElementById('startBtn');
const sendBtn = document.getElementById('sendBtn');
const msgInput = document.getElementById('msgInput');
const logs = document.getElementById('logs');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const fallbackToggle = document.getElementById('fallbackToggle');
const peerIdBadge = document.getElementById('peerIdBadge');
const calibrateBar = document.getElementById('calibrateBar');
const calibrateFill = document.getElementById('calibrateFill');
const calibrateLabel = document.getElementById('calibrateLabel');

function log(msg, type = 'sys') {
  const item = document.createElement('div');
  item.className = `log-item log-${type}`;
  item.textContent = `[${new Date().toLocaleTimeString().split(' ')[0]}] ${msg}`;
  logs.appendChild(item);
  logs.scrollTop = logs.scrollHeight;
  return item;
}

function updateLog(item, msg, type = null) {
  if (!item) return;
  const closeBracket = item.textContent.indexOf(']');
  const timePart = closeBracket >= 0 ? item.textContent.slice(0, closeBracket + 1) : '';
  item.textContent = `${timePart} ${msg}`;
  if (type) item.className = `log-item log-${type}`;
  logs.scrollTop = logs.scrollHeight;
}

let lastActivityUpdate = 0;
function handleActivity(peak, threshold) {
  const now = Date.now();
  if (now - lastActivityUpdate < 300) return;
  lastActivityUpdate = now;

  if (!isRunning) return;
  if (peak > threshold) {
    statusText.textContent = `Active (${engine.myDeviceId}) — signal detected`;
  } else {
    statusText.textContent = `Active (${engine.myDeviceId}) — listening...`;
  }
}

if (peerIdBadge) peerIdBadge.textContent = `Peer: ${engine.myDeviceId}`;

(async function loadHistory() {
  try {
    const messages = await Storage.loadMessages(100);
    messages.forEach(m => {
      log(`${m.direction === 'out' ? 'You' : m.senderId}: ${m.text}`, m.direction === 'out' ? 'out' : 'in');
    });
    if (messages.length > 0) log(`Loaded ${messages.length} saved message(s) from local storage`, 'sys');

    const peers = await Storage.loadPeers();
    const now = Date.now();
    peers.forEach(p => {
      if (now - p.lastSeen < 20000) {
        activeNodes.set(p.nodeId, { lastSeen: p.lastSeen, distance: Math.random() * 0.6 + 0.2 });
      }
    });
  } catch (err) {
    console.warn('History load failed (non-fatal):', err);
  }
})();

// NEW: jittered heartbeat scheduler — replaces the old fixed
// setInterval(..., 8000). A fixed interval on TWO tabs tends to drift
// into lockstep and collide with each other repeatedly (visible in
// testing as "Channel busy" backoffs happening over and over on the
// same beat). Randomizing 7-9s per tick breaks that lockstep.
function scheduleHeartbeat() {
  const delay = 7000 + Math.random() * 2000; // 7-9s
  pingTimeoutId = setTimeout(async () => {
    if (isRunning) {
      await engine.transmitFrame('PING', 'hb');
      scheduleHeartbeat();
    }
  }, delay);
}

startBtn.addEventListener('click', async () => {
  if (!isRunning) {
    await engine.init();

    if (calibrateBar) calibrateBar.style.display = 'flex';
    statusText.textContent = 'Calibrating ambient noise floor...';
    const calResult = await engine.calibrateNoiseFloor(1500, (progress) => {
      if (calibrateFill) calibrateFill.style.width = `${Math.round(progress * 100)}%`;
    });
    if (calibrateBar) calibrateBar.style.display = 'none';
    log(`Calibrated: noise floor=${calResult.noiseFloor}, activity threshold=${calResult.recommendedActivityThreshold}`, 'sys');

    isRunning = true;
    statusDot.classList.add('active');
    statusText.textContent = `Active (${engine.myDeviceId})`;
    startBtn.textContent = "Stop Engine";
    msgInput.disabled = false;
    sendBtn.disabled = false;
    log(`Node Online: ${engine.myDeviceId}`, 'sys');

    spectrogram.draw(engine.analyser);
    radar.draw(activeNodes, isRunning);

    engine.startListening(handleFrame);
    engine.startActivityMeter(handleActivity);

    scheduleHeartbeat(); // CHANGED: was setInterval(..., 8000)

  } else {
    await stopEngine();
  }
});

async function stopEngine() {
  if (!isRunning) return;
  isRunning = false;

  if (pingTimeoutId) {
    clearTimeout(pingTimeoutId); // CHANGED: was clearInterval
    pingTimeoutId = null;
  }

  await engine.shutdown();

  statusDot.classList.remove('active');
  statusText.textContent = 'System Offline';
  startBtn.textContent = 'Initialize Engine';
  msgInput.disabled = true;
  sendBtn.disabled = true;
  log('Node offline — microphone released.', 'sys');
}

if (fallbackToggle) {
  fallbackToggle.addEventListener('click', () => {
    engine.useAudibleFallback = !engine.useAudibleFallback;
    fallbackToggle.textContent = engine.useAudibleFallback
      ? "Mode: Audible (tap for Ultrasonic)"
      : "Mode: Ultrasonic (tap for Audible)";
    log(`Switched to ${engine.useAudibleFallback ? 'AUDIBLE' : 'ULTRASONIC'} mode`, 'sys');
  });
}

function waitForAck(seq, timeoutMs = ACK_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      pendingAcks.delete(seq);
      resolve(false);
    }, timeoutMs);
    pendingAcks.set(seq, { resolve, timeoutId });
  });
}

function resolveAck(seq) {
  const pending = pendingAcks.get(seq);
  if (!pending) return;
  clearTimeout(pending.timeoutId);
  pending.resolve(true);
  pendingAcks.delete(seq);
}

// FIX 1 applied here: seq is allocated ONCE, outside the retry loop,
// then reused on every attempt via transmitFrameWithSeq(). This is
// the change that makes a retry an actual retransmission instead of
// a structurally new message.
async function sendReliable(text) {
  const logEl = log(`You: ${text} — PENDING`, 'out');
  const seq = engine.allocateSeq(); // CHANGED: allocate once, not per-attempt

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    updateLog(logEl, `You: ${text} — TRANSMITTING (attempt ${attempt}/${MAX_RETRIES})`, 'out');

    const result = await engine.transmitFrameWithSeq('MSG', text, seq, (bAttempt, waitMs) => {
      log(`Channel busy — backoff ${waitMs}ms (attempt ${bAttempt})`, 'sys');
    });

    if (!result) {
      updateLog(logEl, `You: ${text} — FAILED (engine not ready)`, 'out');
      return;
    }

    updateLog(logEl, `You: ${text} — SENT, awaiting ACK...`, 'out');

    const delivered = await waitForAck(seq);
    if (delivered) {
      updateLog(logEl, `You: ${text} — DELIVERED ✓`, 'out');
      Storage.saveMessage({
        text, senderId: engine.myDeviceId, recipientId: 'broadcast',
        direction: 'out', status: 'delivered', seq
      });
      return;
    }

    log(`No ACK for seq ${seq} within ${ACK_TIMEOUT_MS}ms.`, 'sys');
  }

  updateLog(logEl, `You: ${text} — FAILED ✗ (no ACK after ${MAX_RETRIES} attempts)`, 'out');
  Storage.saveMessage({
    text, senderId: engine.myDeviceId, recipientId: 'broadcast',
    direction: 'out', status: 'failed', seq
  });
}

sendBtn.addEventListener('click', () => {
  const text = msgInput.value.trim();
  if (!text) return;
  msgInput.value = '';
  sendReliable(text);
});

msgInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') sendBtn.click();
});

// FIX 2 applied here: MSG/SOS frames are checked against seenFrames
// before being displayed/saved. A duplicate is recognized and skipped
// for display/storage, but STILL gets an ACK sent back — the sender's
// retry is itself evidence that our earlier ACK never reached them.
function handleFrame(parsed, rawText) {
  if (!parsed.valid) {
    log(`Dropped corrupted frame (${parsed.reason})`, 'sys');
    return;
  }
  if (parsed.sender === engine.myDeviceId) return;

  activeNodes.set(parsed.sender, { lastSeen: Date.now(), distance: Math.random() * 0.6 + 0.2 });
  Storage.savePeer(parsed.sender);

  if (parsed.type === 'MSG') {
    const duplicate = isDuplicate(parsed.sender, parsed.seq); // NEW

    if (!duplicate) {
      log(`${parsed.sender}: ${parsed.payload}`, 'in');
      Storage.saveMessage({
        text: parsed.payload, senderId: parsed.sender, recipientId: engine.myDeviceId,
        direction: 'in', status: 'received', seq: parsed.seq
      });
      markSeen(parsed.sender, parsed.seq); // NEW
    } else {
      log(`(duplicate of seq ${parsed.seq} from ${parsed.sender} — re-ACKing, not re-displayed)`, 'sys'); // NEW
    }

    // ACK sent either way — see comment above.
    engine.transmitFrame('ACK', String(parsed.seq)).catch(() => {});

  } else if (parsed.type === 'PING') {
    log(`Presence Ping from ${parsed.sender}`, 'sys');

  } else if (parsed.type === 'SOS') {
    const duplicate = isDuplicate(parsed.sender, parsed.seq); // NEW
    if (!duplicate) {
      log(`⚠ SOS from ${parsed.sender}: ${parsed.payload}`, 'in');
      Storage.saveSOS({ senderId: parsed.sender, lat: null, lon: null, timestamp: Date.now() });
      markSeen(parsed.sender, parsed.seq); // NEW
    }
    engine.transmitFrame('ACK', String(parsed.seq)).catch(() => {});

  } else if (parsed.type === 'ACK') {
    const ackedSeq = parseInt(parsed.payload, 10);
    if (!Number.isNaN(ackedSeq)) resolveAck(ackedSeq);
  }
}

radar.draw(activeNodes, false);

window.addEventListener('pagehide', () => {
  if (isRunning) engine.shutdown();
});

// ─────────────────────────────────────────────────────────────────
// FORWARD NOTE — for when you package this with Capacitor:
//
//   import { App } from '@capacitor/app';
//   App.addListener('appStateChange', ({ isActive }) => {
//     if (!isActive) stopEngine();
//   });
// ─────────────────────────────────────────────────────────────────
