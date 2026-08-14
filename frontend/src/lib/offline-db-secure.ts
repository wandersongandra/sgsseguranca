import { sanitizeSensitiveDraftValue } from "./sensitive-draft-sanitizer";
import { logger } from "./logger";

const DB_NAME = "sgs-offline-secure";
const DB_VERSION = 1;
const KEY_STORE = "sgs-key-store";
const KEY_NAME = "encryption-key";

let _dbPromise: Promise<IDBDatabase> | null = null;
let _cryptoKey: CryptoKey | null = null;

function getDB(): Promise<IDBDatabase> {
  if (typeof window === "undefined" || !window.indexedDB) {
    return Promise.reject(new Error("IndexedDB is not supported in this environment"));
  }

  if (_dbPromise) return _dbPromise;

  _dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(KEY_STORE)) {
        db.createObjectStore(KEY_STORE);
      }
      if (!db.objectStoreNames.contains("sgs-cache")) {
        db.createObjectStore("sgs-cache");
      }
      if (!db.objectStoreNames.contains("sgs-queue")) {
        db.createObjectStore("sgs-queue");
      }
      if (!db.objectStoreNames.contains("sgs-session")) {
        db.createObjectStore("sgs-session");
      }
    };
  });

  return _dbPromise;
}

// Inicializa a chave de criptografia de forma segura (extractable: false)
async function getOrCreateCryptoKey(): Promise<CryptoKey> {
  if (_cryptoKey) return _cryptoKey;

  const db = await getDB();
  
  // Tentar ler a chave persistida
  const storedKey = await new Promise<CryptoKey | null>((resolve) => {
    try {
      const transaction = db.transaction(KEY_STORE, "readonly");
      const store = transaction.objectStore(KEY_STORE);
      const req = store.get(KEY_NAME);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });

  if (storedKey) {
    _cryptoKey = storedKey;
    return _cryptoKey;
  }

  // Se não existir, gerar nova chave não-extraível
  if (typeof window === "undefined" || !window.crypto?.subtle) {
    throw new Error("Web Crypto API is not supported in this environment");
  }

  const newKey = await window.crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false, // extractable: false para segurança contra XSS
    ["encrypt", "decrypt"]
  );

  // Salvar a nova chave
  await new Promise<void>((resolve, reject) => {
    try {
      const transaction = db.transaction(KEY_STORE, "readwrite");
      const store = transaction.objectStore(KEY_STORE);
      const req = store.put(newKey, KEY_NAME);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    } catch (err) {
      reject(err);
    }
  });

  _cryptoKey = newKey;
  return _cryptoKey;
}

// Métodos de Cifra Simétrica AES-GCM
async function encrypt(plaintext: string): Promise<string> {
  const key = await getOrCreateCryptoKey();
  if (typeof window === "undefined" || !window.crypto) {
    throw new Error("Crypto API not available");
  }
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await window.crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoded
  );
  
  const combined = new Uint8Array(iv.length + new Uint8Array(ciphertext).length);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);
  
  // Utilizar Base64 seguro para armazenar a string
  return "enc:" + btoa(String.fromCharCode(...combined));
}

async function decrypt(data: string): Promise<string> {
  if (!data.startsWith("enc:")) return data;
  const key = await getOrCreateCryptoKey();
  if (typeof window === "undefined" || !window.crypto) {
    throw new Error("Crypto API not available");
  }
  
  try {
    const combined = Uint8Array.from(atob(data.slice(4)), (c) => c.charCodeAt(0));
    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);
    const decrypted = await window.crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      ciphertext
    );
    return new TextDecoder().decode(decrypted);
  } catch (err) {
    logger.error("Falha ao decodificar storage local seguro:", err);
    throw new Error("Decryption failed");
  }
}

// Interface Geral do Storage Seguro IndexedDB
export const secureOfflineDB = {
  async get<T>(storeName: "sgs-cache" | "sgs-queue" | "sgs-session", key: string): Promise<T | null> {
    try {
      const db = await getDB();
      const rawEncrypted = await new Promise<string | null>((resolve, reject) => {
        const transaction = db.transaction(storeName, "readonly");
        const store = transaction.objectStore(storeName);
        const req = store.get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });

      if (!rawEncrypted) return null;
      const decrypted = await decrypt(rawEncrypted);
      return JSON.parse(decrypted) as T;
    } catch (err) {
      logger.warn(`Erro na leitura segura do IndexedDB [store: ${storeName}, key: ${key}]:`, err);
      return null;
    }
  },

  async set<T>(storeName: "sgs-cache" | "sgs-queue" | "sgs-session", key: string, value: T): Promise<void> {
    try {
      const db = await getDB();
      const sanitized = sanitizeSensitiveDraftValue(value);
      const encrypted = await encrypt(JSON.stringify(sanitized));

      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(storeName, "readwrite");
        const store = transaction.objectStore(storeName);
        const req = store.put(encrypted, key);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    } catch (err) {
      logger.warn(`Erro na gravacao segura do IndexedDB [store: ${storeName}, key: ${key}]:`, err);
    }
  },

  async del(storeName: "sgs-cache" | "sgs-queue" | "sgs-session", key: string): Promise<void> {
    try {
      const db = await getDB();
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(storeName, "readwrite");
        const store = transaction.objectStore(storeName);
        const req = store.delete(key);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    } catch (err) {
      logger.warn(`Erro ao excluir do IndexedDB [store: ${storeName}, key: ${key}]:`, err);
    }
  },

  async keys(storeName: "sgs-cache" | "sgs-queue" | "sgs-session"): Promise<string[]> {
    try {
      const db = await getDB();
      return await new Promise<string[]>((resolve, reject) => {
        const transaction = db.transaction(storeName, "readonly");
        const store = transaction.objectStore(storeName);
        const req = store.getAllKeys();
        req.onsuccess = () => resolve((req.result as string[]) || []);
        req.onerror = () => reject(req.error);
      });
    } catch (err) {
      logger.warn(`Erro ao carregar chaves do IndexedDB [store: ${storeName}]:`, err);
      return [];
    }
  },

  async clear(storeName: "sgs-cache" | "sgs-queue" | "sgs-session"): Promise<void> {
    try {
      const db = await getDB();
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(storeName, "readwrite");
        const store = transaction.objectStore(storeName);
        const req = store.clear();
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    } catch (err) {
      logger.warn(`Erro ao limpar IndexedDB [store: ${storeName}]:`, err);
    }
  }
};
