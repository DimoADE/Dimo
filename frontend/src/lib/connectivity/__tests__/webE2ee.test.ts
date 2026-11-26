import { describe, expect, it } from 'vitest';

import {
  AAD_RESP,
  buildEncryptedRequestHeaders,
  decryptResponseBodyText,
  decryptWsFrame,
  encryptRequestBody,
  encryptWsFrame,
  handshakeWebE2ee,
  HEADER_E2EE,
  HEADER_E2EE_CLIENT_PUB,
  HEADER_E2EE_SERVER_PUB,
  HEADER_E2EE_SESSION,
  HKDF_INFO,
  HKDF_SALT,
  isLoopbackOrigin,
  isRelayOrigin,
  shouldUseWebE2ee,
  type WebE2eeSession,
} from '../webE2ee';

async function createTestSession(): Promise<{
  session: WebE2eeSession;
  rawAesKey: CryptoKey;
}> {
  const keyBytes = new Uint8Array(32);
  crypto.getRandomValues(keyBytes);
  const rawAesKey = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
  return {
    session: {
      sessionId: 'sess_test_1234',
      key: rawAesKey,
      clientPubB64: 'Y2xpZW50',
      serverPubB64: 'c2VydmVy',
    },
    rawAesKey,
  };
}

describe('webE2ee', () => {
  it('detects loopback and relay origins accurately', () => {
    expect(isLoopbackOrigin('http://127.0.0.1:17891')).toBe(true);
    expect(isLoopbackOrigin('http://localhost:17891')).toBe(true);
    expect(isLoopbackOrigin('http://[::1]:17891')).toBe(true);
    expect(isLoopbackOrigin('https://relay.dimo-ai.com/t/host_1')).toBe(false);
    expect(isLoopbackOrigin('https://box.example.com/dimo')).toBe(false);

    expect(isRelayOrigin('https://relay.dimo-ai.com/t/host_1')).toBe(true);
    expect(isRelayOrigin('https://vps.example.com/t/abc')).toBe(true);
    expect(isRelayOrigin('https://box.example.com/dimo')).toBe(false);

    expect(shouldUseWebE2ee('http://127.0.0.1:17891')).toBe(false);
    expect(shouldUseWebE2ee('https://relay.dimo-ai.com/t/host_1')).toBe(true);
    expect(shouldUseWebE2ee('https://box.example.com/dimo')).toBe(true);
  });

  it('encrypts auth header and request body and decrypts encrypted HTTP response', async () => {
    const { session, rawAesKey } = await createTestSession();

    const headers = await buildEncryptedRequestHeaders(
      session,
      'Bearer secret-token-123'
    );
    expect(headers[HEADER_E2EE_SESSION]).toBe('sess_test_1234');
    expect(headers['x-dimo-e2ee-auth']).toBeTruthy();
    expect(headers['Authorization']).toBeUndefined();

    const encBody = await encryptRequestBody(
      session,
      JSON.stringify({ hello: 'world' })
    );
    expect(encBody.length).toBeGreaterThan(20);

    // Simulate server encrypting response with AAD_RESP
    const nonce = new Uint8Array(12);
    crypto.getRandomValues(nonce);
    const plaintext = new TextEncoder().encode(JSON.stringify({ ok: true }));
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: nonce,
          additionalData: AAD_RESP,
        },
        rawAesKey,
        plaintext
      )
    );
    const combined = new Uint8Array(12 + ciphertext.byteLength);
    combined.set(nonce, 0);
    combined.set(ciphertext, 12);

    const mockResponse = new Response(
      Buffer.from(combined).toString('base64'),
      {
        status: 200,
        headers: { [HEADER_E2EE]: 'v1' },
      }
    );
    const decrypted = await decryptResponseBodyText(session, mockResponse);
    expect(JSON.parse(decrypted)).toEqual({ ok: true });
  });

  it('round-trips encrypted WebSocket frames', async () => {
    const { session } = await createTestSession();
    const payload = JSON.stringify({ type: 'ping', seq: 42 });
    const frame = await encryptWsFrame(session, payload);
    const decoded = await decryptWsFrame(session, frame);
    expect(decoded).toBe(payload);
  });

  it('derives matching ECDH P-256 + HKDF-SHA256 session keys with a simulated Host', async () => {
    const serverKeyPair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveBits']
    );
    const serverRawPub = new Uint8Array(
      await crypto.subtle.exportKey('raw', serverKeyPair.publicKey)
    );
    const serverPubB64 = Buffer.from(serverRawPub).toString('base64');

    let capturedClientPubB64 = '';
    const fetchImpl: typeof fetch = async (_input, init) => {
      const headers = new Headers(init?.headers);
      capturedClientPubB64 = headers.get(HEADER_E2EE_CLIENT_PUB) ?? '';
      return new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          [HEADER_E2EE]: 'v1',
          [HEADER_E2EE_SESSION]: 'srv_sess_99',
          [HEADER_E2EE_SERVER_PUB]: serverPubB64,
        },
      });
    };

    const clientSession = await handshakeWebE2ee(
      'https://relay.dimo-ai.com/t/h1',
      { fetchImpl }
    );
    expect(clientSession.sessionId).toBe('srv_sess_99');

    // Derive server-side AES key using client's public key
    const clientPubBytes = new Uint8Array(
      Buffer.from(capturedClientPubB64, 'base64')
    );
    const clientPubKey = await crypto.subtle.importKey(
      'raw',
      clientPubBytes,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      []
    );
    const sharedBits = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: clientPubKey },
      serverKeyPair.privateKey,
      256
    );
    const hkdfKey = await crypto.subtle.importKey(
      'raw',
      sharedBits,
      'HKDF',
      false,
      ['deriveKey']
    );
    const serverAesKey = await crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: HKDF_SALT,
        info: HKDF_INFO,
      },
      hkdfKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );

    const frame = await encryptWsFrame(clientSession, 'hello-from-client');
    const decodedByServer = await decryptWsFrame(
      {
        sessionId: 'srv_sess_99',
        key: serverAesKey,
        clientPubB64: capturedClientPubB64,
        serverPubB64,
      },
      frame
    );
    expect(decodedByServer).toBe('hello-from-client');
  });
});
