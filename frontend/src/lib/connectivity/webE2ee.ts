/**
 * Browser WebCrypto E2EE v1 client matching `crates/server/src/e2ee.rs`
 * and `crates/server/src/host/connectivity/e2ee_client.rs`.
 *
 * Uses ephemeral ECDH P-256 + HKDF-SHA256 + AES-256-GCM so relays and
 * untrusted network intermediaries only observe opaque AEAD ciphertexts.
 */

export const HEADER_E2EE = 'x-dimo-e2ee';
export const HEADER_E2EE_CLIENT_PUB = 'x-dimo-e2ee-client-pub';
export const HEADER_E2EE_SERVER_PUB = 'x-dimo-e2ee-server-pub';
export const HEADER_E2EE_SESSION = 'x-dimo-e2ee-session';
export const HEADER_E2EE_AUTH = 'x-dimo-e2ee-auth';
export const E2EE_VERSION = 'v1';

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

export const HKDF_SALT = TEXT_ENCODER.encode('dimo-e2ee-v1-salt');
export const HKDF_INFO = TEXT_ENCODER.encode('dimo-e2ee-v1-aes256gcm');

export const AAD_AUTH = TEXT_ENCODER.encode('dimo-e2ee-auth-v1');
export const AAD_REQ = TEXT_ENCODER.encode('dimo-e2ee-req-v1');
export const AAD_RESP = TEXT_ENCODER.encode('dimo-e2ee-resp-v1');
export const AAD_WS = TEXT_ENCODER.encode('dimo-e2ee-ws-v1');

export interface WebE2eeSession {
  sessionId: string;
  key: CryptoKey;
  clientPubB64: string;
  serverPubB64: string;
}

export function hasSubtleCrypto(): boolean {
  if (
    typeof globalThis !== 'undefined' &&
    'isSecureContext' in globalThis &&
    globalThis.isSecureContext === false
  ) {
    return false;
  }
  return (
    typeof globalThis !== 'undefined' &&
    typeof globalThis.crypto !== 'undefined' &&
    typeof globalThis.crypto.subtle !== 'undefined'
  );
}

export function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    const host = url.hostname.toLowerCase();
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === '[::1]' ||
      host.endsWith('.localhost')
    );
  } catch {
    return false;
  }
}

export function isRelayOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.pathname.startsWith('/t/');
  } catch {
    return origin.includes('/t/');
  }
}

export function shouldUseWebE2ee(origin: string): boolean {
  if (isLoopbackOrigin(origin)) return false;
  return hasSubtleCrypto();
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const slice = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

export function base64ToBytes(encoded: string): Uint8Array {
  const normalized = encoded.trim().replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + '='.repeat(padLen);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
}

export async function deriveAesGcmKeyFromSharedSecret(
  sharedSecret: ArrayBuffer | Uint8Array
): Promise<CryptoKey> {
  const secretBuffer =
    sharedSecret instanceof Uint8Array
      ? toArrayBuffer(sharedSecret)
      : sharedSecret;
  const hkdfKey = await globalThis.crypto.subtle.importKey(
    'raw',
    secretBuffer,
    { name: 'HKDF' },
    false,
    ['deriveKey']
  );
  return globalThis.crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: toArrayBuffer(HKDF_SALT),
      info: toArrayBuffer(HKDF_INFO),
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptE2eePayload(
  key: CryptoKey,
  aad: Uint8Array,
  plaintext: Uint8Array
): Promise<string> {
  const nonce = new Uint8Array(12);
  globalThis.crypto.getRandomValues(nonce);
  const cipherBuffer = await globalThis.crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: toArrayBuffer(nonce),
      additionalData: toArrayBuffer(aad),
      tagLength: 128,
    },
    key,
    toArrayBuffer(plaintext)
  );
  const cipherBytes = new Uint8Array(cipherBuffer);
  const combined = new Uint8Array(nonce.length + cipherBytes.length);
  combined.set(nonce, 0);
  combined.set(cipherBytes, nonce.length);
  return bytesToBase64(combined);
}

export async function decryptE2eePayload(
  key: CryptoKey,
  aad: Uint8Array,
  encoded: string
): Promise<Uint8Array> {
  const raw = base64ToBytes(encoded);
  if (raw.length < 12 + 16) {
    throw new Error('E2EE payload too short');
  }
  const nonce = raw.subarray(0, 12);
  const ciphertext = raw.subarray(12);
  const plainBuffer = await globalThis.crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: toArrayBuffer(nonce),
      additionalData: toArrayBuffer(aad),
      tagLength: 128,
    },
    key,
    toArrayBuffer(ciphertext)
  );
  return new Uint8Array(plainBuffer);
}

export async function handshakeWebE2ee(
  baseUrl: string,
  options?: { fetchImpl?: typeof fetch; signal?: AbortSignal }
): Promise<WebE2eeSession> {
  if (!hasSubtleCrypto()) {
    throw new Error('WebCrypto subtle API unavailable in this browser context');
  }
  const fetchFn = options?.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const keyPair = (await globalThis.crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  )) as CryptoKeyPair;

  const clientPubRaw = new Uint8Array(
    await globalThis.crypto.subtle.exportKey('raw', keyPair.publicKey)
  );
  const clientPubB64 = bytesToBase64(clientPubRaw);

  const cleanBase = baseUrl.trim().replace(/\/+$/, '');
  const response = await fetchFn(`${cleanBase}/api/v1/e2ee/handshake`, {
    method: 'GET',
    headers: {
      [HEADER_E2EE_CLIENT_PUB]: clientPubB64,
    },
    signal: options?.signal,
  });

  if (!response.ok) {
    throw new Error(`E2EE handshake returned HTTP ${response.status}`);
  }

  const sessionId = response.headers.get(HEADER_E2EE_SESSION)?.trim() ?? '';
  const serverPubB64 =
    response.headers.get(HEADER_E2EE_SERVER_PUB)?.trim() ?? '';
  if (!sessionId || !serverPubB64) {
    throw new Error('Remote Host did not return E2EE handshake headers');
  }

  const serverPubBytes = base64ToBytes(serverPubB64);
  if (serverPubBytes.length !== 65 || serverPubBytes[0] !== 0x04) {
    throw new Error('Invalid server P-256 public key');
  }

  const serverPubKey = await globalThis.crypto.subtle.importKey(
    'raw',
    toArrayBuffer(serverPubBytes),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );
  const sharedBits = await globalThis.crypto.subtle.deriveBits(
    { name: 'ECDH', public: serverPubKey },
    keyPair.privateKey,
    256
  );
  const key = await deriveAesGcmKeyFromSharedSecret(sharedBits);

  return {
    sessionId,
    key,
    clientPubB64,
    serverPubB64,
  };
}

export async function buildEncryptedRequestHeaders(
  session: WebE2eeSession,
  bearerToken?: string
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    [HEADER_E2EE]: E2EE_VERSION,
    [HEADER_E2EE_SESSION]: session.sessionId,
    [HEADER_E2EE_CLIENT_PUB]: session.clientPubB64,
    'Content-Type': 'text/plain; charset=utf-8',
  };
  if (bearerToken) {
    headers[HEADER_E2EE_AUTH] = await encryptE2eePayload(
      session.key,
      AAD_AUTH,
      TEXT_ENCODER.encode(`Bearer ${bearerToken}`)
    );
  }
  return headers;
}

export async function encryptRequestBody(
  session: WebE2eeSession,
  plaintext: string
): Promise<string> {
  return encryptE2eePayload(
    session.key,
    AAD_REQ,
    TEXT_ENCODER.encode(plaintext)
  );
}

export async function decryptResponseBodyText(
  session: WebE2eeSession,
  response: Response
): Promise<string> {
  const raw = await response.text();
  const isEncrypted =
    response.headers.get(HEADER_E2EE)?.toLowerCase() === E2EE_VERSION;
  if (!isEncrypted || !raw.trim()) {
    return raw;
  }
  const plainBytes = await decryptE2eePayload(
    session.key,
    AAD_RESP,
    raw.trim()
  );
  return TEXT_DECODER.decode(plainBytes);
}

export async function encryptWsFrame(
  session: WebE2eeSession,
  plaintextJson: string
): Promise<string> {
  const cipher = await encryptE2eePayload(
    session.key,
    AAD_WS,
    TEXT_ENCODER.encode(plaintextJson)
  );
  return JSON.stringify({ type: 'e2ee', d: cipher });
}

export async function decryptWsFrame(
  session: WebE2eeSession,
  wireText: string
): Promise<string> {
  const parsed = JSON.parse(wireText) as { type?: unknown; d?: unknown };
  if (parsed?.type === 'e2ee' && typeof parsed.d === 'string') {
    const plainBytes = await decryptE2eePayload(session.key, AAD_WS, parsed.d);
    return TEXT_DECODER.decode(plainBytes);
  }
  throw new Error('Expected encrypted E2EE WebSocket frame');
}

export function wsE2eeSubprotocol(session: WebE2eeSession): string {
  return `dimo.e2ee.${session.sessionId}`;
}
