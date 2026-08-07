// File System Access API helpers for the "Save to folder" feature.
//
// This is the remote-friendly path: the BROWSER writes the generated project
// straight into a folder the user picks on THEIR machine — no server-side disk
// write, no zip, no unzip. The tester then opens that folder in VS Code.
//
// Only Chromium browsers (Chrome/Edge/Brave/Opera) expose showDirectoryPicker.
// Callers feature-detect with isFsAccessSupported() and fall back to the ZIP
// download elsewhere (Firefox/Safari).
//
// We persist the chosen directory handle per project in IndexedDB, so after the
// first pick a save is one click (subject to the browser re-confirming
// read/write permission, which is a cheap prompt on a user gesture).

export function isFsAccessSupported() {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

// ── Minimal IndexedDB store for FileSystemDirectoryHandle objects ──
// Directory handles are structured-cloneable, so they survive in IndexedDB
// across sessions (the OS permission is re-checked on use, not stored).
const DB_NAME = 'qaai-fs';
const STORE = 'dirHandles';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function idbGet(key) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const r = tx.objectStore(STORE).get(key);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => reject(r.error);
    });
  } finally {
    db.close();
  }
}

const keyFor = (projectId) => `proj:${projectId}`;

export async function getSavedDirHandle(projectId) {
  try { return await idbGet(keyFor(projectId)); } catch { return null; }
}

export async function rememberDirHandle(projectId, handle) {
  try { await idbSet(keyFor(projectId), handle); } catch { /* non-fatal — we just won't remember it */ }
}

export async function forgetDirHandle(projectId) {
  try { await idbSet(keyFor(projectId), undefined); } catch { /* ignore */ }
}

// Ensure we hold read/write permission on a (possibly persisted) handle.
// Must be called from a user-gesture context (button click) so the browser
// allows requestPermission to prompt.
export async function verifyPermission(handle, readWrite = true) {
  if (!handle || typeof handle.queryPermission !== 'function') return false;
  const opts = { mode: readWrite ? 'readwrite' : 'read' };
  try {
    if ((await handle.queryPermission(opts)) === 'granted') return true;
    if ((await handle.requestPermission(opts)) === 'granted') return true;
  } catch {
    return false;
  }
  return false;
}

export async function pickDirectory() {
  return window.showDirectoryPicker({ mode: 'readwrite' });
}

async function removeGeneratedDirs(dirHandle, files) {
  const ownedDirs = new Set();
  for (const file of files || []) {
    const first = String(file.path || '').replace(/\\/g, '/').split('/').filter(Boolean)[0];
    if (first && !first.startsWith('.') && !first.includes('.')) ownedDirs.add(first);
  }
  for (const dir of ownedDirs) {
    try {
      await dirHandle.removeEntry(dir, { recursive: true });
    } catch (err) {
      if (err && err.name === 'NotFoundError') continue;
      throw err;
    }
  }
}

// Write [{ path, content }] into dirHandle, creating nested folders as needed.
// `path` uses forward slashes (e.g. "src/test/java/Foo.java").
function filePayload(file) {
  if (file && file.encoding === 'base64') {
    const binary = atob(file.content || '');
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  return file.content ?? '';
}

export async function writeFilesToDir(dirHandle, files) {
  await removeGeneratedDirs(dirHandle, files);
  for (const file of files) {
    const parts = String(file.path).split('/').filter(Boolean);
    const fileName = parts.pop();
    if (!fileName) continue;
    let dir = dirHandle;
    for (const seg of parts) {
      dir = await dir.getDirectoryHandle(seg, { create: true });
    }
    const fh = await dir.getFileHandle(fileName, { create: true });
    const writable = await fh.createWritable();
    await writable.write(filePayload(file));
    await writable.close();
  }
}
