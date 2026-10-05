// storage.js — NEW FILE
// Local, offline, client-side persistence via IndexedDB. No server, no
// network call of any kind — this is why IndexedDB (not localStorage,
// not a fetch-based API) is the right tool: it's a browser-native
// database that lives entirely on the device.
//
// This module is defensive by design: every public method wraps its
// IndexedDB calls in try/catch and resolves (never throws) so a storage
// hiccup can never crash the calling UI code — a message that fails to
// save still gets displayed and shown as sent; it just won't survive a
// reload. That's a deliberate degrade, not a silent failure.

const Storage = (() => {
  const DB_NAME = 'AcousticSyncDB';
  const DB_VERSION = 1;
  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (event) => {
        const db = event.target.result;

        if (!db.objectStoreNames.contains('messages')) {
          const store = db.createObjectStore('messages', { keyPath: 'id', autoIncrement: true });
          store.createIndex('timestamp', 'timestamp', { unique: false });
          store.createIndex('senderId', 'senderId', { unique: false });
        }

        if (!db.objectStoreNames.contains('peers')) {
          const store = db.createObjectStore('peers', { keyPath: 'nodeId' });
          store.createIndex('lastSeen', 'lastSeen', { unique: false });
        }

        if (!db.objectStoreNames.contains('sos')) {
          const store = db.createObjectStore('sos', { keyPath: 'id', autoIncrement: true });
          store.createIndex('timestamp', 'timestamp', { unique: false });
        }
      };

      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    return dbPromise;
  }

  // Generic transactional put — resolves true/false, never throws.
  async function put(storeName, record) {
    try {
      const db = await openDb();
      return await new Promise((resolve) => {
        const tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).put(record);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => { console.warn(`Storage: put failed on ${storeName}`, tx.error); resolve(false); };
      });
    } catch (err) {
      console.warn('Storage: put threw', err);
      return false;
    }
  }

  async function getAll(storeName, limit = 200) {
    try {
      const db = await openDb();
      return await new Promise((resolve) => {
        const results = [];
        const tx = db.transaction(storeName, 'readonly');
        const cursorReq = tx.objectStore(storeName).openCursor(null, 'prev'); // newest first
        cursorReq.onsuccess = (event) => {
          const cursor = event.target.result;
          if (cursor && results.length < limit) {
            results.push(cursor.value);
            cursor.continue();
          } else {
            resolve(results.reverse()); // chronological order for display
          }
        };
        cursorReq.onerror = () => { console.warn(`Storage: getAll failed on ${storeName}`); resolve([]); };
      });
    } catch (err) {
      console.warn('Storage: getAll threw', err);
      return [];
    }
  }

  // ---- Convenience wrappers matching the app's data shapes ----

  function saveMessage({ text, senderId, recipientId, direction, status, timestamp, seq }) {
    return put('messages', {
      text, senderId, recipientId, direction, status,
      timestamp: timestamp || Date.now(),
      seq: seq ?? null
    });
  }

  function loadMessages(limit = 200) {
    return getAll('messages', limit);
  }

  function savePeer(nodeId, lastSeen = Date.now(), signalStrength = null) {
    return put('peers', { nodeId, lastSeen, signalStrength });
  }

  function loadPeers() {
    return getAll('peers', 500);
  }

  function saveSOS({ lat, lon, senderId, timestamp }) {
    return put('sos', { lat, lon, senderId, timestamp: timestamp || Date.now() });
  }

  function loadSOSLog() {
    return getAll('sos', 100);
  }

  return { saveMessage, loadMessages, savePeer, loadPeers, saveSOS, loadSOSLog };
})();
