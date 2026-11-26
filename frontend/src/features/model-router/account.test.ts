import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ACCOUNT_TOKEN_STORAGE_KEY,
  accountApi,
  modelMarketplacePath,
  openModelMarketplace,
} from './account';

const openExternal = vi.hoisted(() => vi.fn());

vi.mock('./openExternal', () => ({ openExternal }));

describe('accountApi & Model Marketplace helpers', () => {
  it('keeps the deadline active while reading a stalled response body', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        async (_url, init) =>
          ({
            status: 200,
            ok: true,
            json: () =>
              new Promise((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () =>
                  reject(new DOMException('Aborted', 'AbortError'))
                );
              }),
          }) as Response
      );
      const result = accountApi.startLogin();
      const assertion = expect(result).rejects.toMatchObject({
        code: 'network',
      });
      await vi.advanceTimersByTimeAsync(15_001);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
  it('does not store an approved token after the login was canceled', async () => {
    const controller = new AbortController();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      controller.abort();
      return new Response(
        JSON.stringify({ status: 'approved', token: 'late-token' }),
        { status: 200 }
      );
    });
    expect(
      await accountApi.pollLogin(
        {
          requestId: 'request',
          verifier: 'secret',
          userCode: '',
          verifyUrl: '',
          expiresIn: 60,
          interval: 1,
        },
        controller.signal
      )
    ).toBe(false);
    expect(localStorage.getItem(ACCOUNT_TOKEN_STORAGE_KEY)).toBeNull();
  });
  beforeEach(() => {
    localStorage.clear();
    openExternal.mockReset();
    vi.restoreAllMocks();
  });

  it('passes nextPath (/account by default or custom target) when starting desktop login', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            requestId: 'req-1',
            verifier: 'ver-1',
            userCode: 'ABCD-1234',
            verifyUrl: 'https://dimo.test/desktop/authorize?request=req-1',
            expiresIn: 600,
            interval: 2,
          }),
          { status: 200 }
        )
    );

    await accountApi.startLogin();
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      deviceName: 'Dimo Desktop',
      hostId: '',
      nextPath: '/account',
    });

    await accountApi.startLogin(modelMarketplacePath('claude_code'));
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      deviceName: 'Dimo Desktop',
      hostId: '',
      nextPath: '/account/models?agent=claude_code',
    });
  });

  it('uses web-handoff when signed in and falls back to direct URL on failure', async () => {
    localStorage.setItem(ACCOUNT_TOKEN_STORAGE_KEY, 'tok_123');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          handoffUrl:
            'https://dimo.test/api/auth/desktop/web-handoff?ticket=h_1',
          expiresIn: 60,
        }),
        { status: 200 }
      )
    );

    const url = await openModelMarketplace('codex');
    expect(url).toBe(
      'https://dimo.test/api/auth/desktop/web-handoff?ticket=h_1'
    );
    expect(openExternal).toHaveBeenCalledWith(
      'https://dimo.test/api/auth/desktop/web-handoff?ticket=h_1'
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      targetPath: '/account/models?agent=codex',
    });

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'failed' }), { status: 500 })
    );
    const fallback = await openModelMarketplace('codex');
    expect(fallback).toContain('/account/models?agent=codex');
    expect(openExternal).toHaveBeenLastCalledWith(fallback);
  });

  it('redeems a desktop import ticket without clearing stored token on 401 and retries without token', async () => {
    localStorage.setItem(ACCOUNT_TOKEN_STORAGE_KEY, 'stale_tok');
    const provision = {
      apiKey: 'sk-vxr-1',
      agentId: 'claude_code',
      protocol: 'anthropic' as const,
      baseUrl: 'https://dimo.test/api/router',
      model: { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
      models: [{ id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' }],
    };

    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(provision), { status: 200 })
      );

    const result = await accountApi.redeemImportTicket('tkt_999');
    expect(result).toEqual(provision);
    expect(localStorage.getItem(ACCOUNT_TOKEN_STORAGE_KEY)).toBe('stale_tok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('sends hostId on web-handoff and uses desktop bridge hostname for startLogin fallback', async () => {
    localStorage.setItem(ACCOUNT_TOKEN_STORAGE_KEY, 'tok_abc');
    const prevBridge = window.dimoDesktop;
    Object.defineProperty(window, 'dimoDesktop', {
      configurable: true,
      value: { hostname: 'STUDIO-WORKSTATION' },
    });
    try {
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              handoffUrl:
                'https://dimo.test/api/auth/desktop/web-handoff?ticket=h_2',
              expiresIn: 60,
            }),
            { status: 200 }
          )
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              requestId: 'req-2',
              verifier: 'ver-2',
              userCode: 'EFGH-5678',
              verifyUrl: 'https://dimo.test/desktop/authorize?request=req-2',
              expiresIn: 600,
              interval: 2,
            }),
            { status: 200 }
          )
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              apiKey: 'sk-vxr-2',
              agentId: 'codex',
              protocol: 'openai',
              baseUrl: 'https://dimo.test/api/router',
              model: { id: 'gpt-5', name: 'GPT-5' },
              models: [{ id: 'gpt-5', name: 'GPT-5' }],
              targetHostId: 'host-target-123',
              targetHostName: 'GPU-Box',
            }),
            { status: 200 }
          )
        );

      await accountApi.webHandoff('/account/market', 'host:uuid-local-1');
      expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
        targetPath: '/account/market',
        hostId: 'host:uuid-local-1',
      });

      await accountApi.startLogin({
        hostId: 'host:uuid-local-1',
        nextPath: '/account/models',
      });
      expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
        deviceName: 'STUDIO-WORKSTATION',
        hostId: 'host:uuid-local-1',
        nextPath: '/account/models',
      });

      const provision = await accountApi.redeemImportTicket('tkt_target');
      expect(provision.targetHostId).toBe('host-target-123');
      expect(provision.targetHostName).toBe('GPU-Box');
    } finally {
      Object.defineProperty(window, 'dimoDesktop', {
        configurable: true,
        value: prevBridge,
      });
    }
  });

  it('preserves structured JSON error codes on 404 responses while keeping HTML 404 as unsupported', async () => {
    localStorage.setItem(ACCOUNT_TOKEN_STORAGE_KEY, 'tok_abc');
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'host_not_found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response('<html>Not Found</html>', {
          status: 404,
          headers: { 'Content-Type': 'text/html' },
        })
      );

    await expect(
      accountApi.issueHostAccessGrant({
        hostId: 'missing-host',
        clientPublicKeyEd25519: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        clientKind: 'desktop',
      })
    ).rejects.toMatchObject({ code: 'host_not_found' });

    await expect(
      accountApi.issueHostAccessGrant({
        hostId: 'legacy-site',
        clientPublicKeyEd25519: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        clientKind: 'desktop',
      })
    ).rejects.toMatchObject({ code: 'unsupported' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
