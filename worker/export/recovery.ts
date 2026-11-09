// Last-resort local recovery for a completed ZIP. This never sends chat content to Telepathy.
// IndexedDB keeps the Blob on this device until the user explicitly deletes or replaces it.

export interface RecoveryArchive {
  fileName: string;
  bytes: number;
  messageCount: number;
  createdAt: string;
  blob: Blob;
}

const DATABASE = "telepathy-export-recovery";
const STORE = "archives";
const KEY = "latest";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("IndexedDB is unavailable"));
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open recovery storage"));
    request.onblocked = () => reject(new Error("Recovery storage is blocked by another tab"));
  });
}

async function transaction<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = action(tx.objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Recovery storage failed"));
      tx.onabort = () => reject(tx.error ?? new Error("Recovery storage transaction was aborted"));
    });
  } finally {
    db.close();
  }
}

export async function saveRecovery(blob: Blob, fileName: string, messageCount: number): Promise<RecoveryArchive> {
  const archive: RecoveryArchive = { blob, fileName, bytes: blob.size, messageCount, createdAt: new Date().toISOString() };
  await transaction("readwrite", (store) => store.put(archive, KEY));
  return archive;
}

export async function loadRecovery(): Promise<RecoveryArchive | null> {
  return (await transaction("readonly", (store) => store.get(KEY))) as RecoveryArchive | null ?? null;
}

export async function deleteRecovery(): Promise<void> {
  await transaction("readwrite", (store) => store.delete(KEY));
}
