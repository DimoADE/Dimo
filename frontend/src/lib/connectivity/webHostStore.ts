/**
 * IndexedDB-backed multi-host credential store and persistent Ed25519
 * client identity for WebUI (`dimo_connectivity_v1`).
 *
 * - Default mode persists connected Hosts + device credentials in IndexedDB
 *   so refreshing or reopening the browser reconnects automatically via
 *   Happy Eyeballs.
 * - Optional session-only mode (`setWebRememberHosts(false)`) keeps the
 *   current session in `sessionStorage` only and never writes tokens to IDB.
 * - `clearAccountLinkedWebHosts()` is called on Dimo account sign-out so
 *   account-issued sessions end cleanly while manually paired Hosts remain.
 */

import { base64ToBytes, bytesToBase64Url, hasSubtleCrypto } from './webE2ee';
import {
  normalizeRemoteOrigin,
  type ReachabilityEndpoint,
} from './happyEyeballs';

const DB_NAME = 'dimo_connectivity_v1';
const DB_VERSION = 1;
const STORE_HOSTS = 'hosts';
const STORE_IDENTITY = 'client_identity';
const STORE_META = 'meta';

const REMEMBER_PREF_KEY = 'dimo.web.rememberHosts.v1';
const LAST_ACTIVE_HOST_META_KEY = 'last_active_host_id';
const PRIMARY_IDENTITY_KEY = 'primary_ed25519';

export type WebHostTrustSource = 'paired' | 'account_linked';

export interface SavedWebHost {
  id: string;
  hostId?: string;
  name: string;
  origin: string;
  endpoints: ReachabilityEndpoint[];
  lastGoodOrigin?: string;
  accessToken: string;
  deviceId?: string;
  trustSource: WebHostTrustSource;
  accountUserId?: string;
  lastConnectedAt: string;
}

interface StoredEd25519Identity {
  id: string;
  publicKeyB64: string;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  createdAt: string;
}

const listeners = new Set<() => void>();

// Fallback in-memory stores for non-IDB environments (e.g., restricted private tabs or unit tests).
const memoryHosts = new Map<string, SavedWebHost>();
const memoryMeta = new Map<string, string>();
let memoryIdentity: StoredEd25519Identity | null = null;

function notifyStoreChanged(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // Ignore individual subscriber failures.
    }
  }
}

export function subscribeWebHostStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getWebRememberHosts(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    const raw = window.localStorage.getItem(REMEMBER_PREF_KEY);
    if (raw === null) return true;
    return raw !== 'false';
  } catch {
    return true;
  }
}

export function setWebRememberHosts(remember: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(REMEMBER_PREF_KEY, remember ? 'true' : 'false');
  } catch {
    // Ignore storage errors.
  }
  notifyStoreChanged();
}

function hasIndexedDb(): boolean {
  return (
    typeof globalThis !== 'undefined' &&
    typeof globalThis.indexedDB !== 'undefined'
  );
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!hasIndexedDb()) {
    return Promise.reject(new Error('IndexedDB unavailable'));
  }
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = globalThis.indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_HOSTS)) {
        db.createObjectStore(STORE_HOSTS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_IDENTITY)) {
        db.createObjectStore(STORE_IDENTITY, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      dbPromise = null;
      reject(request.error ?? new Error('Failed to open IndexedDB'));
    };
  });
  return dbPromise;
}

function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () =>
      reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function normalizeSavedHost(host: SavedWebHost): SavedWebHost {
  const origin = normalizeRemoteOrigin(host.origin);
  const lastGoodOrigin = host.lastGoodOrigin
    ? normalizeRemoteOrigin(host.lastGoodOrigin)
    : origin;
  const endpoints: ReachabilityEndpoint[] = [];
  const pushEndpoint = (ep: ReachabilityEndpoint) => {
    const clean = normalizeRemoteOrigin(ep.origin);
    if (!clean) return;
    if (!endpoints.some((e) => e.origin === clean)) {
      endpoints.push({ origin: clean, kind: ep.kind });
    }
  };
  for (const ep of host.endpoints ?? []) {
    pushEndpoint(ep);
  }
  pushEndpoint({ origin });
  if (lastGoodOrigin) {
    pushEndpoint({ origin: lastGoodOrigin });
  }
  return {
    ...host,
    id: host.id || host.hostId || origin,
    origin,
    lastGoodOrigin,
    endpoints,
  };
}

export async function listSavedWebHosts(): Promise<SavedWebHost[]> {
  if (!hasIndexedDb()) {
    return Array.from(memoryHosts.values()).sort((a, b) =>
      b.lastConnectedAt.localeCompare(a.lastConnectedAt)
    );
  }
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_HOSTS, 'readonly');
    const items = await idbRequest(
      tx.objectStore(STORE_HOSTS).getAll() as IDBRequest<SavedWebHost[]>
    );
    return (items ?? []).sort((a, b) =>
      (b.lastConnectedAt ?? '').localeCompare(a.lastConnectedAt ?? '')
    );
  } catch {
    return Array.from(memoryHosts.values());
  }
}

export async function getSavedWebHost(
  idOrHostId: string
): Promise<SavedWebHost | null> {
  const list = await listSavedWebHosts();
  const clean = idOrHostId.trim();
  return (
    list.find(
      (item) =>
        item.id === clean ||
        item.hostId === clean ||
        normalizeRemoteOrigin(item.origin) === normalizeRemoteOrigin(clean)
    ) ?? null
  );
}

export async function upsertSavedWebHost(
  input: SavedWebHost
): Promise<SavedWebHost> {
  const existing = input.hostId
    ? await getSavedWebHost(input.hostId)
    : await getSavedWebHost(input.id || input.origin);
  const mergedEndpoints = [
    ...(existing?.endpoints ?? []),
    ...(input.endpoints ?? []),
  ];
  const record = normalizeSavedHost({
    ...existing,
    ...input,
    id:
      existing?.id ||
      input.hostId ||
      input.id ||
      normalizeRemoteOrigin(input.origin),
    endpoints: mergedEndpoints,
    lastConnectedAt: input.lastConnectedAt || new Date().toISOString(),
  });

  memoryHosts.set(record.id, record);
  if (hasIndexedDb()) {
    try {
      const db = await openDb();
      const tx = db.transaction(STORE_HOSTS, 'readwrite');
      await idbRequest(tx.objectStore(STORE_HOSTS).put(record));
    } catch {
      // Keep memory copy if IDB write fails.
    }
  }
  notifyStoreChanged();
  return record;
}

export async function removeSavedWebHost(idOrHostId: string): Promise<void> {
  const target = await getSavedWebHost(idOrHostId);
  const key = target?.id ?? idOrHostId.trim();
  if (!key) return;
  memoryHosts.delete(key);
  if (hasIndexedDb()) {
    try {
      const db = await openDb();
      const tx = db.transaction(STORE_HOSTS, 'readwrite');
      await idbRequest(tx.objectStore(STORE_HOSTS).delete(key));
    } catch {
      // Ignore IDB delete error.
    }
  }
  const activeId = await getLastActiveWebHostId();
  if (activeId === key) {
    await setLastActiveWebHostId(null);
  }
  notifyStoreChanged();
}

export async function clearAccountLinkedWebHosts(): Promise<number> {
  const hosts = await listSavedWebHosts();
  const accountHosts = hosts.filter((h) => h.trustSource === 'account_linked');
  for (const host of accountHosts) {
    await removeSavedWebHost(host.id);
  }
  return accountHosts.length;
}

export async function clearAllSavedWebHosts(): Promise<void> {
  memoryHosts.clear();
  if (hasIndexedDb()) {
    try {
      const db = await openDb();
      const tx = db.transaction(STORE_HOSTS, 'readwrite');
      await idbRequest(tx.objectStore(STORE_HOSTS).clear());
    } catch {
      // Ignore IDB clear error.
    }
  }
  await setLastActiveWebHostId(null);
  notifyStoreChanged();
}

export async function getLastActiveWebHostId(): Promise<string | null> {
  if (!hasIndexedDb()) {
    return memoryMeta.get(LAST_ACTIVE_HOST_META_KEY) ?? null;
  }
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_META, 'readonly');
    const row = (await idbRequest(
      tx.objectStore(STORE_META).get(LAST_ACTIVE_HOST_META_KEY)
    )) as { key: string; value?: string } | undefined;
    return row?.value ?? memoryMeta.get(LAST_ACTIVE_HOST_META_KEY) ?? null;
  } catch {
    return memoryMeta.get(LAST_ACTIVE_HOST_META_KEY) ?? null;
  }
}

export async function setLastActiveWebHostId(id: string | null): Promise<void> {
  if (id) {
    memoryMeta.set(LAST_ACTIVE_HOST_META_KEY, id);
  } else {
    memoryMeta.delete(LAST_ACTIVE_HOST_META_KEY);
  }
  if (hasIndexedDb()) {
    try {
      const db = await openDb();
      const tx = db.transaction(STORE_META, 'readwrite');
      if (id) {
        await idbRequest(
          tx
            .objectStore(STORE_META)
            .put({ key: LAST_ACTIVE_HOST_META_KEY, value: id })
        );
      } else {
        await idbRequest(
          tx.objectStore(STORE_META).delete(LAST_ACTIVE_HOST_META_KEY)
        );
      }
    } catch {
      // Ignore IDB meta write error.
    }
  }
  notifyStoreChanged();
}

async function getOrCreateEd25519Identity(): Promise<StoredEd25519Identity> {
  if (memoryIdentity) return memoryIdentity;
  if (hasIndexedDb()) {
    try {
      const db = await openDb();
      const tx = db.transaction(STORE_IDENTITY, 'readonly');
      const stored = (await idbRequest(
        tx.objectStore(STORE_IDENTITY).get(PRIMARY_IDENTITY_KEY)
      )) as StoredEd25519Identity | undefined;
      if (stored?.publicKeyB64 && stored?.privateKey) {
        memoryIdentity = stored;
        return stored;
      }
    } catch {
      // Fall through to generate a fresh keypair.
    }
  }
  if (!hasSubtleCrypto()) {
    throw new Error('WebCrypto is unavailable in this browser context');
  }
  let keyPair: CryptoKeyPair;
  try {
    keyPair = (await globalThis.crypto.subtle.generateKey(
      { name: 'Ed25519' } as AlgorithmIdentifier,
      false,
      ['sign', 'verify']
    )) as CryptoKeyPair;
  } catch {
    throw new Error(
      'This browser does not support WebCrypto Ed25519; use a pairing code to connect.'
    );
  }
  const pubRaw = new Uint8Array(
    await globalThis.crypto.subtle.exportKey('raw', keyPair.publicKey)
  );
  const identity: StoredEd25519Identity = {
    id: PRIMARY_IDENTITY_KEY,
    publicKeyB64: bytesToBase64Url(pubRaw),
    privateKey: keyPair.privateKey,
    publicKey: keyPair.publicKey,
    createdAt: new Date().toISOString(),
  };
  memoryIdentity = identity;
  if (hasIndexedDb()) {
    try {
      const db = await openDb();
      const tx = db.transaction(STORE_IDENTITY, 'readwrite');
      await idbRequest(tx.objectStore(STORE_IDENTITY).put(identity));
    } catch {
      // Non-fatal: keep identity in memory for current tab.
    }
  }
  return identity;
}

export async function getWebClientPublicKeyEd25519(): Promise<string> {
  const identity = await getOrCreateEd25519Identity();
  return identity.publicKeyB64;
}

export function extractHostGrantJti(grantToken: string): string {
  const parts = grantToken.trim().split('.');
  let payloadPart: string | undefined;
  if (parts.length === 2) {
    payloadPart = parts[0];
  } else if (parts.length === 3 && parts[0] === 'dimo-host-grant-v1') {
    payloadPart = parts[1];
  } else {
    throw new Error('Invalid HostAccessGrant token format');
  }
  const payloadBytes = base64ToBytes(payloadPart!);
  const payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as {
    jti?: unknown;
  };
  if (typeof payload.jti !== 'string' || !payload.jti.trim()) {
    throw new Error('HostAccessGrant payload missing jti');
  }
  return payload.jti.trim();
}

export async function signWebHostGrantPop(
  jti: string,
  hostId: string
): Promise<{ clientPublicKeyEd25519: string; popSignature: string }> {
  const identity = await getOrCreateEd25519Identity();
  const message = new TextEncoder().encode(
    `dimo-host-grant-pop-v1.${jti}.${hostId}`
  );
  const signature = await globalThis.crypto.subtle.sign(
    { name: 'Ed25519' } as AlgorithmIdentifier,
    identity.privateKey,
    message
  );
  return {
    clientPublicKeyEd25519: identity.publicKeyB64,
    popSignature: bytesToBase64Url(new Uint8Array(signature)),
  };
}
