// frameProtocol.js — NEW FILE
// Data-link framing + CRC16 error detection.
// This module has ZERO dependency on audio/DOM — pure data transforms —
// so it can be tested in isolation (see the self-test at the bottom).
//
// Frame layout (all fields are plain text, colon-delimited, then a
// checksum appended — we stay text-based rather than raw binary because
// ggwave's text protocols are what your baseline already uses, and this
// keeps the change additive rather than a rewrite):
//
//   TYPE:SENDER:SEQ:PAYLOAD:CRC
//
//   TYPE    - "MSG" | "ACK" | "PING" | "SOS"
//   SENDER  - 4-char hex peer id, e.g. "A1B2"
//   SEQ     - sequence number (0-255, wraps)
//   PAYLOAD - the actual text (chat text, ping marker, compressed SOS coords)
//   CRC     - CRC16-CCITT (XModem, poly 0x1021, init 0x0000) of
//             "TYPE:SENDER:SEQ:PAYLOAD" as a 4-digit hex string
//
// Why CRC16 and not something heavier: acoustic bit errors here are
// bursty (echo/multipath flips a run of bits), not random single-bit
// noise. CRC16-CCITT is the standard choice for exactly that error
// pattern (it's what XModem/Bluetooth/USB use) and is cheap enough to
// compute on every frame with no perceptible delay.

const FrameProtocol = (() => {

  // ---- CRC16-CCITT (XModem variant) ----------------------------------
  // Deterministic: same input bytes ALWAYS produce the same CRC. This is
  // the one piece of this whole system that can be made mathematically
  // airtight — there's no "probably works", it's arithmetic.
  function crc16(str) {
    let crc = 0x0000;
    for (let i = 0; i < str.length; i++) {
      crc ^= (str.charCodeAt(i) << 8);
      for (let b = 0; b < 8; b++) {
        crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
        crc &= 0xFFFF;
      }
    }
    return crc.toString(16).padStart(4, '0');
  }

  // ---- Frame builder ---------------------------------------------------
  // type: 'MSG'|'ACK'|'PING'|'SOS', senderId: string, seq: number, payload: string
  function buildFrame(type, senderId, seq, payload) {
    const seqStr = (seq & 0xFF).toString(); // wrap at 255
    const body = `${type}:${senderId}:${seqStr}:${payload}`;
    const checksum = crc16(body);
    return `${body}:${checksum}`;
  }

  // ---- Frame parser ------------------------------------------------------
  // Returns { valid, type, sender, seq, payload } or { valid: false, reason }
  // IMPORTANT: never throws. Malformed/truncated acoustic decodes are
  // expected (that's the whole reason this module exists) — a parse
  // failure must always be a clean, reportable result, never an
  // exception that could crash the caller.
  function parseFrame(raw) {
    if (typeof raw !== 'string' || raw.length === 0) {
      return { valid: false, reason: 'empty' };
    }

    // Payload itself may contain ':' (chat text), so split only the
    // first 3 and last 1 delimiters, leaving the payload intact.
    const firstColon = raw.indexOf(':');
    const secondColon = raw.indexOf(':', firstColon + 1);
    const thirdColon = raw.indexOf(':', secondColon + 1);
    const lastColon = raw.lastIndexOf(':');

    if (firstColon < 0 || secondColon < 0 || thirdColon < 0 || lastColon <= thirdColon) {
      return { valid: false, reason: 'malformed: missing fields' };
    }

    const type = raw.slice(0, firstColon);
    const sender = raw.slice(firstColon + 1, secondColon);
    const seqStr = raw.slice(secondColon + 1, thirdColon);
    const payload = raw.slice(thirdColon + 1, lastColon);
    const receivedCrc = raw.slice(lastColon + 1);

    if (!['MSG', 'ACK', 'PING', 'SOS'].includes(type)) {
      return { valid: false, reason: `unknown type: ${type}` };
    }
    const seq = parseInt(seqStr, 10);
    if (Number.isNaN(seq)) {
      return { valid: false, reason: 'bad sequence number' };
    }
    if (!/^[0-9a-f]{4}$/i.test(receivedCrc)) {
      return { valid: false, reason: 'malformed checksum field' };
    }

    const body = `${type}:${sender}:${seqStr}:${payload}`;
    const expectedCrc = crc16(body);

    if (expectedCrc.toLowerCase() !== receivedCrc.toLowerCase()) {
      return { valid: false, reason: 'CRC mismatch (corrupted in transit)' };
    }

    return { valid: true, type, sender, seq, payload };
  }

  // ---- Self-test — run once at load time in dev; throws loudly if the
  // CRC/parse logic itself is broken, so a bug here is caught immediately
  // rather than surfacing later as mysterious "always failed" packets.
  function _selfTest() {
    const f = buildFrame('MSG', 'A1B2', 7, 'hello:world');
    const parsed = parseFrame(f);
    if (!parsed.valid || parsed.payload !== 'hello:world' || parsed.seq !== 7) {
      throw new Error('FrameProtocol self-test FAILED — do not trust CRC/framing until fixed');
    }
    // Corrupt one character and confirm it's correctly rejected
    const corrupted = f.slice(0, -1) + (f.slice(-1) === 'a' ? 'b' : 'a');
    if (parseFrame(corrupted).valid) {
      throw new Error('FrameProtocol self-test FAILED — corruption was not detected');
    }
  }
  _selfTest();

  return { crc16, buildFrame, parseFrame };
})();
