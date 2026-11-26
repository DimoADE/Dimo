import { describe, expect, it } from 'vitest';

import {
  endpointPriorityTier,
  filterReachableEndpointsForPage,
  lookupRelayBeacon,
  parsePairingInvitation,
  selectBestEndpoint,
} from '../happyEyeballs';

describe('happyEyeballs', () => {
  it('parses full dimo-pairing invitations and standalone 8-char codes', () => {
    const inv = parsePairingInvitation(
      'dimo-pairing:' +
        JSON.stringify({
          host_id: 'host_abc',
          preset: 'workstation',
          pairing_id: 'pair_1',
          pairing_token: 'k7m2-npqx',
          reachability: [
            { origin: 'http://192.168.1.20:17891/', kind: 'lan' },
            { origin: 'https://box.example.com/dimo/', kind: 'custom_public' },
            { origin: 'https://relay.dimo-ai.com/t/host_abc', kind: 'official_relay' },
          ],
        })
    );
    expect(inv).not.toBeNull();
    expect(inv?.hostId).toBe('host_abc');
    expect(inv?.pairingToken).toBe('K7M2NPQX');
    expect(inv?.endpoints).toEqual([
      { origin: 'http://192.168.1.20:17891', kind: 'lan' },
      { origin: 'https://box.example.com/dimo', kind: 'custom_public' },
      { origin: 'https://relay.dimo-ai.com/t/host_abc', kind: 'official_relay' },
    ]);

    const shortCode = parsePairingInvitation('k7m2 npqx');
    expect(shortCode).toEqual({ pairingToken: 'K7M2NPQX', endpoints: [] });
    expect(parsePairingInvitation('not-a-code')).toBeNull();
  });

  it('filters http:// non-loopback endpoints on https:// pages to prevent Mixed Content errors', () => {
    const endpoints = [
      { origin: 'http://127.0.0.1:17891', kind: 'lan' },
      { origin: 'http://192.168.1.20:17891', kind: 'lan' },
      { origin: 'https://box.example.com/dimo', kind: 'custom_public' },
      { origin: 'https://relay.dimo-ai.com/t/h1', kind: 'official_relay' },
    ];

    const onHttps = filterReachableEndpointsForPage(endpoints, 'https:');
    expect(onHttps.map((e) => e.origin)).toEqual([
      'http://127.0.0.1:17891',
      'https://box.example.com/dimo',
      'https://relay.dimo-ai.com/t/h1',
    ]);

    const onHttp = filterReachableEndpointsForPage(endpoints, 'http:');
    expect(onHttp).toHaveLength(4);
  });

  it('orders staggered priority tiers correctly', () => {
    expect(
      endpointPriorityTier(
        { origin: 'https://relay.dimo-ai.com/t/h1', kind: 'official_relay' },
        'https://relay.dimo-ai.com/t/h1'
      )
    ).toBe(0);
    expect(
      endpointPriorityTier({ origin: 'http://192.168.1.20:17891', kind: 'lan' })
    ).toBe(0);
    expect(
      endpointPriorityTier({
        origin: 'https://box.example.com/dimo',
        kind: 'custom_public',
      })
    ).toBe(1);
    expect(
      endpointPriorityTier({
        origin: 'https://relay.dimo-ai.com/t/h1',
        kind: 'official_relay',
      })
    ).toBe(2);
  });

  it('selects the first healthy endpoint with matching host_id and rejects mismatched hosts', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.startsWith('http://192.168.1.20:17891/health')) {
        // Wrong host_id on LAN IP!
        return new Response(
          JSON.stringify({ status: 'ok', host_id: 'host_wrong', name: 'Other' }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url.startsWith('https://box.example.com/dimo/health')) {
        return new Response(
          JSON.stringify({ status: 'ok', host_id: 'host_target', name: 'My Box' }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response('unavailable', { status: 503 });
    };

    const selected = await selectBestEndpoint(
      [
        { origin: 'http://192.168.1.20:17891', kind: 'lan' },
        { origin: 'https://box.example.com/dimo', kind: 'custom_public' },
        { origin: 'https://relay.dimo-ai.com/t/host_target', kind: 'official_relay' },
      ],
      {
        expectedHostId: 'host_target',
        pageProtocol: 'http:',
        fetchImpl,
      }
    );

    expect(selected?.origin).toBe('https://box.example.com/dimo');
    expect(selected?.hostId).toBe('host_target');
    expect(selected?.name).toBe('My Box');
  });

  it('looks up relay pairing beacons using Host-compatible 32-hex vbx-p-<sha256> topic and base origin', async () => {
    let requestedUrl = '';
    const fetchImpl: typeof fetch = async (input) => {
      requestedUrl = String(input);
      return new Response(
        JSON.stringify({
          host_id: 'host_xyz',
          origin: 'https://relay.dimo-ai.com/t/host_xyz',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    };

    const resolved = await lookupRelayBeacon(
      'https://relay.dimo-ai.com/t/host_old',
      'k7m2-npqx',
      { fetchImpl }
    );
    expect(requestedUrl).toMatch(
      /^https:\/\/relay\.dimo-ai\.com\/v1\/beacon\/vbx-p-[0-9a-f]{32}$/
    );
    expect(resolved).toEqual({
      hostId: 'host_xyz',
      origin: 'https://relay.dimo-ai.com/t/host_xyz',
    });
  });
});
