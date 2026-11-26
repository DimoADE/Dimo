import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearAccountLinkedWebHosts,
  clearAllSavedWebHosts,
  extractHostGrantJti,
  getLastActiveWebHostId,
  getWebRememberHosts,
  listSavedWebHosts,
  removeSavedWebHost,
  setLastActiveWebHostId,
  setWebRememberHosts,
  upsertSavedWebHost,
} from '../webHostStore';

describe('webHostStore', () => {
  beforeEach(async () => {
    window.localStorage.clear();
    await clearAllSavedWebHosts();
  });

  it('persists, merges endpoints, updates active host, and removes hosts cleanly', async () => {
    await upsertSavedWebHost({
      id: 'host_1',
      hostId: 'host_1',
      name: 'Office Mac',
      origin: 'http://192.168.1.10:17891',
      endpoints: [{ origin: 'http://192.168.1.10:17891', kind: 'lan' }],
      accessToken: 'tok_1',
      trustSource: 'paired',
      lastConnectedAt: '2026-11-25T10:00:00Z',
    });

    await upsertSavedWebHost({
      id: 'host_1',
      hostId: 'host_1',
      name: 'Office Mac',
      origin: 'https://office.example.com/dimo',
      endpoints: [
        { origin: 'https://office.example.com/dimo', kind: 'custom_public' },
      ],
      accessToken: 'tok_1_new',
      trustSource: 'paired',
      lastConnectedAt: '2026-11-25T11:00:00Z',
    });

    await setLastActiveWebHostId('host_1');
    expect(await getLastActiveWebHostId()).toBe('host_1');

    const hosts = await listSavedWebHosts();
    expect(hosts).toHaveLength(1);
    expect(hosts[0].accessToken).toBe('tok_1_new');
    expect(hosts[0].endpoints.map((e) => e.origin)).toEqual([
      'http://192.168.1.10:17891',
      'https://office.example.com/dimo',
    ]);

    await removeSavedWebHost('host_1');
    expect(await listSavedWebHosts()).toHaveLength(0);
    expect(await getLastActiveWebHostId()).toBeNull();
  });

  it('clears account_linked hosts on sign-out while preserving manually paired hosts', async () => {
    await upsertSavedWebHost({
      id: 'host_paired',
      hostId: 'host_paired',
      name: 'Home Box',
      origin: 'https://home.example.com',
      endpoints: [
        { origin: 'https://home.example.com', kind: 'custom_public' },
      ],
      accessToken: 'tok_paired',
      trustSource: 'paired',
      lastConnectedAt: '2026-11-25T10:00:00Z',
    });
    await upsertSavedWebHost({
      id: 'host_account',
      hostId: 'host_account',
      name: 'Cloud Dev',
      origin: 'https://relay.dimo-ai.com/t/host_account',
      endpoints: [
        {
          origin: 'https://relay.dimo-ai.com/t/host_account',
          kind: 'official_relay',
        },
      ],
      accessToken: 'tok_account',
      trustSource: 'account_linked',
      accountUserId: 'user_1',
      lastConnectedAt: '2026-11-25T11:00:00Z',
    });

    const removed = await clearAccountLinkedWebHosts();
    expect(removed).toBe(1);

    const remaining = await listSavedWebHosts();
    expect(remaining.map((h) => h.id)).toEqual(['host_paired']);
  });

  it('defaults rememberHosts to true and persists user toggle', () => {
    expect(getWebRememberHosts()).toBe(true);
    setWebRememberHosts(false);
    expect(getWebRememberHosts()).toBe(false);
    setWebRememberHosts(true);
    expect(getWebRememberHosts()).toBe(true);
  });

  it('extracts jti from Ed25519 HostAccessGrant tokens', () => {
    const payloadB64 = Buffer.from(
      JSON.stringify({
        jti: 'grant_jti_42',
        host_id: 'host_1',
      })
    )
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(extractHostGrantJti(`${payloadB64}.sig`)).toBe('grant_jti_42');
    expect(extractHostGrantJti(`dimo-host-grant-v1.${payloadB64}.sig`)).toBe(
      'grant_jti_42'
    );
  });
});
