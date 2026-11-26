import { afterEach, describe, expect, it, vi } from 'vitest';

import { invokeAsResult } from '@/lib/api/base';
import { mountBackendTransport } from './transportRegistry';
import {
  MAX_CONCURRENT_PLUGIN_CALLS,
  WEB_SOCKET_KEEPALIVE_MS,
  WebTransport,
  WebTransportError,
} from './webTransport';

class MockWebSocket {
  static readonly OPEN = 1;
  static instances: MockWebSocket[] = [];

  readonly sent: string[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(
    readonly url: string,
    readonly protocols?: string | string[]
  ) {
    MockWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    if (this.readyState === 3) {
      return;
    }
    this.readyState = 3;
    this.onclose?.();
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  message(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  drop() {
    this.readyState = 3;
    this.onclose?.();
  }
}

describe('WebTransport', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    MockWebSocket.instances = [];
  });

  it('performs an authenticated application call', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        operation_id: '0195d6f4-8c37-7b28-a982-6a9e60142f55',
        data: [{ title: 'Remote conversation' }],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const transport = new WebTransport({
      baseUrl: 'http://127.0.0.1:17891',
      token: 'remote-secret',
    });

    await expect(
      transport.call('conversation_list', { workspaceId: 'workspace-1' })
    ).resolves.toEqual([{ title: 'Remote conversation' }]);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:17891/api/v1/call/conversation_list',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer remote-secret',
          'Content-Type': 'application/json',
          'X-Dimo-Protocol-Version': '1.0',
        }),
      })
    );
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body.operation_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(body.args).toEqual({ workspaceId: 'workspace-1' });
  });

  it('preserves the stable remote error envelope including structured details', async () => {
    const details = { type: 'force_push_required', branch: 'main' };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => ({
          code: 'conflict',
          message: 'Automation Engine is owned by another host',
          retryable: true,
          operation_id: '0195d6f4-8c37-7b28-a982-6a9e60142f55',
          details,
        }),
      })
    );
    const transport = new WebTransport({
      baseUrl: 'http://127.0.0.1:17891',
      token: 'remote-secret',
    });

    await expect(transport.call('automation_run_now')).rejects.toMatchObject({
      name: 'WebTransportError',
      code: 'conflict',
      message: 'Automation Engine is owned by another host',
      retryable: true,
      operationId: '0195d6f4-8c37-7b28-a982-6a9e60142f55',
      status: 409,
      details,
    });
  });

  it('preserves structured details on WebTransportError when constructed directly', () => {
    const details = { type: 'cli_not_logged_in' };
    const error = new WebTransportError(
      'GitHub CLI not logged in',
      'pr_error',
      false,
      'op-1',
      422,
      details
    );
    expect(error.details).toEqual(details);
    expect('details' in error).toBe(true);
  });

  it('populates typed Result.error in invokeAsResult from WebTransportError.details', async () => {
    const details = { type: 'force_push_required' };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => ({
          code: 'push_error',
          message: 'Remote branch has diverged',
          retryable: false,
          operation_id: '0195d6f4-8c37-7b28-a982-6a9e60142f55',
          details,
        }),
      })
    );
    const transport = new WebTransport({
      baseUrl: 'http://127.0.0.1:17891',
      token: 'remote-secret',
    });
    const unmount = mountBackendTransport(transport);
    try {
      const result = await invokeAsResult<void, { type: string }>(
        'push_workspace_branch',
        { workspaceId: 'ws-1' }
      );
      expect(result).toEqual({
        success: false,
        error: { type: 'force_push_required' },
        message: 'Remote branch has diverged',
      });
    } finally {
      unmount();
    }
  });

  it('creates a device pairing challenge without putting either token in the URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({
        pairing_id: '0195d6f4-8c37-7b28-a982-6a9e60142f55',
        pairing_token: 'pair-once-secret',
        expires_at: '2026-07-31T05:05:00Z',
        requested_scopes: ['conversation.read', 'conversation.question'],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const transport = new WebTransport({
      baseUrl: 'http://127.0.0.1:17891',
      token: 'remote-secret',
    });

    await expect(
      transport.createDevicePairing({
        requested_scopes: ['conversation.read', 'conversation.question'],
      })
    ).resolves.toMatchObject({ pairing_token: 'pair-once-secret' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:17891/api/v1/auth/pairings');
    expect(url).not.toContain('remote-secret');
    expect(url).not.toContain('pair-once-secret');
    expect(init.headers).toEqual(
      expect.objectContaining({ Authorization: 'Bearer remote-secret' })
    );
    expect(JSON.parse(init.body as string)).toEqual({
      requested_scopes: ['conversation.read', 'conversation.question'],
    });
  });

  it('multiplexes subscriptions and reconnects from each durable cursor', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', MockWebSocket);
    const transport = new WebTransport({
      baseUrl: 'http://127.0.0.1:17891',
      token: 'remote-secret',
    });
    const first = transport
      .subscribe({
        subscription_id: '0195d6f4-8c37-7b28-a982-6a9e60142f51',
        resource: 'conversation',
        conversation_id: '0195d6f4-8c37-7b28-a982-6a9e60142f52',
        after_sequence: 0n,
      })
      [Symbol.asyncIterator]();
    const second = transport
      .subscribe({
        subscription_id: '0195d6f4-8c37-7b28-a982-6a9e60142f53',
        resource: 'conversation',
        conversation_id: '0195d6f4-8c37-7b28-a982-6a9e60142f54',
        after_sequence: 5n,
      })
      [Symbol.asyncIterator]();
    const firstEvent = first.next();
    const secondEvent = second.next();

    expect(MockWebSocket.instances).toHaveLength(1);
    const socket = MockWebSocket.instances[0]!;
    expect(socket.url).toBe('ws://127.0.0.1:17891/api/v1/ws');
    expect(socket.url).not.toContain('remote-secret');
    expect(socket.protocols).toEqual([
      'dimo.v1',
      expect.stringMatching(/^dimo\.token\./),
    ]);
    socket.open();
    const attaches = socket.sent.map((frame) => JSON.parse(frame));
    expect(attaches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'attach',
          request: expect.objectContaining({
            subscription_id: '0195d6f4-8c37-7b28-a982-6a9e60142f51',
            after_sequence: 0,
          }),
        }),
        expect.objectContaining({
          type: 'attach',
          request: expect.objectContaining({
            subscription_id: '0195d6f4-8c37-7b28-a982-6a9e60142f53',
            after_sequence: 5,
          }),
        }),
      ])
    );

    socket.message({
      type: 'event',
      subscription_id: '0195d6f4-8c37-7b28-a982-6a9e60142f53',
      event: { sequence: 6, kind: 'second', payload: {} },
    });
    socket.message({
      type: 'event',
      subscription_id: '0195d6f4-8c37-7b28-a982-6a9e60142f51',
      event: { sequence: 1, kind: 'first', payload: {} },
    });
    await expect(firstEvent).resolves.toEqual({
      done: false,
      value: { sequence: 1n, kind: 'first', payload: {} },
    });
    await expect(secondEvent).resolves.toEqual({
      done: false,
      value: { sequence: 6n, kind: 'second', payload: {} },
    });

    socket.drop();
    await vi.advanceTimersByTimeAsync(350);
    expect(MockWebSocket.instances).toHaveLength(2);
    const reconnected = MockWebSocket.instances[1]!;
    reconnected.open();
    const reattaches = reconnected.sent.map((frame) => JSON.parse(frame));
    expect(reattaches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          request: expect.objectContaining({ after_sequence: 1 }),
        }),
        expect.objectContaining({
          request: expect.objectContaining({ after_sequence: 6 }),
        }),
      ])
    );

    await first.return?.();
    await second.return?.();
    transport.destroy();
  });

  it('receives Host invalidations and notifications after the Host restarts', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', MockWebSocket);
    const transport = new WebTransport({
      baseUrl: 'http://127.0.0.1:17891',
      token: 'remote-secret',
    });
    const changed = vi.fn();
    const available = vi.fn();
    const stopChanged = await transport.listen(
      'plugin-updates-changed',
      changed
    );
    const stopAvailable = await transport.listen(
      'plugin-updates-available',
      available
    );
    const socket = MockWebSocket.instances[0]!;
    socket.open();
    const attachments = socket.sent.map((frame) => JSON.parse(frame));
    for (const { request } of attachments) {
      socket.message({
        type: 'event',
        subscription_id: request.subscription_id,
        event: { sequence: 99, kind: request.channel, payload: 'before' },
      });
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(changed).toHaveBeenCalledWith('before');
    expect(available).toHaveBeenCalledWith('before');
    socket.drop();
    await vi.advanceTimersByTimeAsync(350);
    const reconnected = MockWebSocket.instances[1]!;
    reconnected.open();
    reconnected.message({
      type: 'snapshot',
      subscription_id: attachments[0].request.subscription_id,
      snapshot: { through_sequence: 1, payload: 'after' },
    });
    reconnected.message({
      type: 'event',
      subscription_id: attachments[1].request.subscription_id,
      event: {
        sequence: 2,
        kind: 'plugin-updates-available',
        payload: 'after',
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(changed).toHaveBeenLastCalledWith('after');
    expect(available).toHaveBeenLastCalledWith('after');
    stopChanged();
    stopAvailable();
    transport.destroy();
  });

  it('resets patch_stream cursor on reconnect so post-restart patches are not dropped', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', MockWebSocket);
    const transport = new WebTransport({
      baseUrl: 'http://127.0.0.1:17891',
      token: 'remote-secret',
    });
    const stream = transport
      .subscribe({
        subscription_id: '0195d6f4-8c37-7b28-a982-6a9e60142f59',
        resource: 'patch_stream',
        stream: 'projects',
        args: {},
      })
      [Symbol.asyncIterator]();

    const firstEvent = stream.next();
    const socket = MockWebSocket.instances[0]!;
    socket.open();
    const attach = JSON.parse(socket.sent[0]!);
    socket.message({
      type: 'event',
      subscription_id: attach.request.subscription_id,
      event: {
        sequence: 42,
        kind: 'patch',
        payload: [{ op: 'add', path: '/projects/1', value: {} }],
      },
    });
    await expect(firstEvent).resolves.toEqual({
      done: false,
      value: {
        sequence: 42n,
        kind: 'patch',
        payload: [{ op: 'add', path: '/projects/1', value: {} }],
      },
    });

    socket.drop();
    await vi.advanceTimersByTimeAsync(350);
    const reconnected = MockWebSocket.instances[1]!;
    reconnected.open();
    const reattach = JSON.parse(reconnected.sent[0]!);
    expect(reattach.request.after_sequence).toBe(0);

    await stream.return?.();
    transport.destroy();
  });

  it('keeps an idle socket alive and reconnects after a missed pong', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', MockWebSocket);
    const transport = new WebTransport({
      baseUrl: 'http://127.0.0.1:17891',
      token: 'remote-secret',
    });
    const iterator = transport
      .subscribe({
        subscription_id: '0195d6f4-8c37-7b28-a982-6a9e60142f51',
        resource: 'conversation',
        conversation_id: '0195d6f4-8c37-7b28-a982-6a9e60142f52',
        after_sequence: 0n,
      })
      [Symbol.asyncIterator]();
    const pending = iterator.next();
    const socket = MockWebSocket.instances[0]!;
    socket.open();

    vi.advanceTimersByTime(WEB_SOCKET_KEEPALIVE_MS);
    expect(JSON.parse(socket.sent.at(-1) ?? '{}')).toEqual({ type: 'ping' });
    socket.message({ type: 'pong' });

    vi.advanceTimersByTime(WEB_SOCKET_KEEPALIVE_MS);
    expect(JSON.parse(socket.sent.at(-1) ?? '{}')).toEqual({ type: 'ping' });
    vi.advanceTimersByTime(WEB_SOCKET_KEEPALIVE_MS);
    expect(socket.readyState).toBe(3);
    await vi.advanceTimersByTimeAsync(350);
    expect(MockWebSocket.instances).toHaveLength(2);
    MockWebSocket.instances[1]!.open();

    transport.destroy();
    await pending;
  });

  it('generates RFC 4122 v4 operation_id and subscription_id in HTTP insecure contexts where crypto.randomUUID is undefined', async () => {
    const originalRandomUUID = globalThis.crypto.randomUUID;
    const originalSecureContext = Object.getOwnPropertyDescriptor(
      globalThis,
      'isSecureContext'
    );
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'isSecureContext', {
      value: false,
      configurable: true,
      writable: true,
    });

    try {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          operation_id: '0195d6f4-8c37-7b28-a982-6a9e60142f55',
          data: [{ id: 'proj-1', name: 'Demo' }],
        }),
      });
      vi.stubGlobal('fetch', fetchMock);
      vi.stubGlobal('WebSocket', MockWebSocket);

      const transport = new WebTransport({
        baseUrl: 'http://192.168.1.10:17891',
        token: 'lan-token',
      });

      await expect(transport.call('get_projects', {})).resolves.toEqual([
        { id: 'proj-1', name: 'Demo' },
      ]);
      const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
      expect(body.operation_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      );

      const unlisten = await transport.listen(
        'browser-screenshot-request',
        () => {}
      );
      const socket = MockWebSocket.instances[0]!;
      socket.open();
      const subFrame = JSON.parse(socket.sent[0] ?? '{}');
      expect(subFrame.type).toBe('attach');
      expect(subFrame.request?.subscription_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      );

      unlisten();
      transport.destroy();
    } finally {
      Object.defineProperty(globalThis.crypto, 'randomUUID', {
        value: originalRandomUUID,
        configurable: true,
        writable: true,
      });
      if (originalSecureContext) {
        Object.defineProperty(
          globalThis,
          'isSecureContext',
          originalSecureContext
        );
      } else {
        delete (globalThis as { isSecureContext?: boolean }).isSecureContext;
      }
    }
  });

  it('rejects awaiting subscription next() when server sends error or detached', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket);
    const transport = new WebTransport({
      baseUrl: 'http://127.0.0.1:17891',
      token: 'remote-secret',
    });

    const errIter = transport
      .subscribe({
        subscription_id: 'sub-error-1',
        resource: 'conversation',
        conversation_id: 'conv-1',
        after_sequence: 0n,
      })
      [Symbol.asyncIterator]();
    const detachIter = transport
      .subscribe({
        subscription_id: 'sub-detach-1',
        resource: 'patch_stream',
        stream: 'diff',
        args: {},
      })
      [Symbol.asyncIterator]();

    const pendingErr = errIter.next();
    const pendingDetach = detachIter.next();
    const socket = MockWebSocket.instances[0]!;
    socket.open();

    socket.message({
      type: 'error',
      subscription_id: 'sub-error-1',
      error: { code: 'internal', message: 'Stream crashed', retryable: true },
    });
    socket.message({
      type: 'detached',
      subscription_id: 'sub-detach-1',
      reason: 'upstream_closed',
    });

    await expect(pendingErr).rejects.toBeInstanceOf(WebTransportError);
    await expect(pendingErr).rejects.toMatchObject({
      code: 'internal',
      message: 'Stream crashed',
      retryable: true,
    });
    await expect(pendingDetach).rejects.toBeInstanceOf(WebTransportError);
    await expect(pendingDetach).rejects.toMatchObject({
      code: 'subscription_detached',
      retryable: true,
    });

    transport.destroy();
  });

  it('surfaces and reconnects listenHostEvent when the subscription errors', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', MockWebSocket);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const transport = new WebTransport({
      baseUrl: 'http://127.0.0.1:17891',
      token: 'remote-secret',
    });
    const received: unknown[] = [];

    const stop = await transport.listen('projects-changed', (payload) => {
      received.push(payload);
    });
    const socket = MockWebSocket.instances[0]!;
    socket.open();
    const firstSubId = JSON.parse(socket.sent[0]!).request.subscription_id;

    socket.message({
      type: 'error',
      subscription_id: firstSubId,
      error: { code: 'internal', message: 'Temporary error', retryable: true },
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(warnSpy).toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(650);
    const secondAttach = socket.sent
      .map((raw) => JSON.parse(raw))
      .find(
        (frame) =>
          frame.type === 'attach' &&
          frame.request.subscription_id !== firstSubId
      );
    expect(secondAttach).toBeDefined();

    socket.message({
      type: 'event',
      subscription_id: secondAttach.request.subscription_id,
      event: { sequence: 1, kind: 'projects-changed', payload: 'recovered' },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(received).toEqual(['recovered']);

    stop();
    warnSpy.mockRestore();
    transport.destroy();
  });

  it('invokes onAuthError on HTTP 401 responses', async () => {
    const onAuthError = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({
          code: 'unauthorized',
          message: 'Invalid token',
          retryable: false,
        }),
      })
    );
    const transport = new WebTransport({
      baseUrl: 'http://127.0.0.1:17891',
      token: 'bad-token',
      onAuthError,
    });

    await expect(transport.capabilities()).rejects.toMatchObject({
      name: 'WebTransportError',
      status: 401,
      code: 'unauthorized',
    });
    expect(onAuthError).toHaveBeenCalledTimes(1);
  });

  it('rotates baseUrl and token on reconfigure() and immediately reconnects active subscriptions', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', MockWebSocket);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ operation_id: 'op-1', data: { ok: true } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const transport = new WebTransport({
      baseUrl: 'http://127.0.0.1:4100/',
      token: 'old-token',
    });
    const received: unknown[] = [];
    const stop = await transport.listen('projects-changed', (payload) => {
      received.push(payload);
    });

    expect(MockWebSocket.instances).toHaveLength(1);
    const initialSocket = MockWebSocket.instances[0]!;
    expect(initialSocket.url).toBe('ws://127.0.0.1:4100/api/v1/ws');
    initialSocket.open();

    // Rotate to a newly restarted sidecar port and token.
    transport.reconfigure({
      baseUrl: 'http://127.0.0.1:4200/',
      token: 'new-token',
    });

    expect(transport.origin).toBe('http://127.0.0.1:4200');
    expect(initialSocket.readyState).toBe(3);
    expect(MockWebSocket.instances).toHaveLength(2);
    const nextSocket = MockWebSocket.instances[1]!;
    expect(nextSocket.url).toBe('ws://127.0.0.1:4200/api/v1/ws');
    expect(nextSocket.protocols).not.toEqual(initialSocket.protocols);

    nextSocket.open();
    const reattach = JSON.parse(nextSocket.sent[0] ?? '{}');
    expect(reattach.type).toBe('attach');
    expect(reattach.request.channel).toBe('projects-changed');
    expect(reattach.request.after_sequence).toBe(0);

    nextSocket.message({
      type: 'event',
      subscription_id: reattach.request.subscription_id,
      event: {
        sequence: 1,
        kind: 'projects-changed',
        payload: 'after-restart',
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(received).toEqual(['after-restart']);

    await transport.call('get_projects', {});
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4200/api/v1/call/get_projects',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer new-token',
        }),
      })
    );

    stop();
    transport.destroy();
  });

  it('resets pingTimer in probeOrReconnect() so an imminent keepalive tick does not false-disconnect a healthy socket', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', MockWebSocket);
    const transport = new WebTransport({
      baseUrl: 'http://127.0.0.1:17891',
      token: 'remote-secret',
    });
    const iterator = transport
      .subscribe({
        subscription_id: '0195d6f4-8c37-7b28-a982-6a9e60142f77',
        resource: 'conversation',
        conversation_id: '0195d6f4-8c37-7b28-a982-6a9e60142f78',
        after_sequence: 0n,
      })
      [Symbol.asyncIterator]();
    const pending = iterator.next();
    const socket = MockWebSocket.instances[0]!;
    socket.open();

    // Advance to 1ms before the scheduled keepalive interval tick.
    vi.advanceTimersByTime(WEB_SOCKET_KEEPALIVE_MS - 1);
    const pingsBeforeProbe = socket.sent.filter(
      (frame) => JSON.parse(frame).type === 'ping'
    ).length;
    expect(pingsBeforeProbe).toBe(0);

    // Trigger probeOrReconnect() via the browser 'online' event.
    window.dispatchEvent(new Event('online'));
    expect(JSON.parse(socket.sent.at(-1) ?? '{}')).toEqual({ type: 'ping' });

    // Advance past when the OLD keepalive timer would have fired; the healthy
    // socket must remain OPEN because pingTimer was reset for a full interval.
    vi.advanceTimersByTime(10);
    expect(socket.readyState).toBe(MockWebSocket.OPEN);
    expect(MockWebSocket.instances).toHaveLength(1);

    // Delivering pong before the new full interval expires keeps the socket alive.
    socket.message({ type: 'pong' });
    vi.advanceTimersByTime(WEB_SOCKET_KEEPALIVE_MS);
    expect(socket.readyState).toBe(MockWebSocket.OPEN);
    expect(JSON.parse(socket.sent.at(-1) ?? '{}')).toEqual({ type: 'ping' });

    transport.destroy();
    await pending;
  });

  it('recovers cleanly when socket.send() throws InvalidStateError', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', MockWebSocket);
    const transport = new WebTransport({
      baseUrl: 'http://127.0.0.1:17891',
      token: 'remote-secret',
    });
    const iterator = transport
      .subscribe({
        subscription_id: 'sub-send-err',
        resource: 'conversation',
        conversation_id: 'conv-send-err',
        after_sequence: 0n,
      })
      [Symbol.asyncIterator]();
    const pending = iterator.next();
    const socket = MockWebSocket.instances[0]!;
    socket.open();

    socket.send = () => {
      throw new DOMException('Socket is closing', 'InvalidStateError');
    };

    expect(() => {
      vi.advanceTimersByTime(WEB_SOCKET_KEEPALIVE_MS);
    }).not.toThrow();
    expect(socket.readyState).toBe(3);

    await vi.advanceTimersByTimeAsync(350);
    expect(MockWebSocket.instances).toHaveLength(2);

    transport.destroy();
    await pending;
  });

  it('aborts stalled HTTP requests after requestTimeoutMs with a retryable timeout error', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(
              new DOMException('The operation was aborted.', 'AbortError')
            );
          });
        })
    );
    vi.stubGlobal('fetch', fetchMock);

    const transport = new WebTransport({
      baseUrl: 'http://127.0.0.1:17891',
      token: 'remote-secret',
      requestTimeoutMs: 2_000,
    });

    const callPromise = transport.call('slow_command', {});
    const expectation = expect(callPromise).rejects.toMatchObject({
      name: 'WebTransportError',
      code: 'request_timeout',
      retryable: true,
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await expectation;
  });

  it('deduplicates and caches capabilities() until reconfigure() and does not cache failures', async () => {
    let resolveFirst!: (value: unknown) => void;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          protocol_version: '1.0',
          capabilities: ['desktop.electron'],
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const transport = new WebTransport({
      baseUrl: 'http://127.0.0.1:17891',
      token: 'secret-1',
    });

    const p1 = transport.capabilities();
    const p2 = transport.capabilities();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFirst({
      ok: true,
      status: 200,
      json: async () => ({
        protocol_version: '1.0',
        capabilities: ['desktop.electron'],
      }),
    });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual(r2);

    // Cached subsequent call does not refetch
    await transport.capabilities();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // reconfigure() invalidates the cache
    transport.reconfigure({
      baseUrl: 'http://127.0.0.1:17892',
      token: 'secret-2',
    });
    await transport.capabilities();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('caps concurrent plugin RPC calls without blocking capabilities or core commands', async () => {
    const pluginResolvers: Array<(value: unknown) => void> = [];
    const fetchMock = vi.fn((url: string) => {
      if (url.endsWith('/api/v1/capabilities')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            protocol_version: '1.0',
            capabilities: ['desktop.electron'],
          }),
        });
      }
      if (url.endsWith('/api/v1/call/conversation_list')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            operation_id: 'op-core',
            data: [{ id: 'conv-1' }],
          }),
        });
      }
      return new Promise((resolve) => {
        pluginResolvers.push(resolve);
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const transport = new WebTransport({
      baseUrl: 'http://127.0.0.1:17891',
      token: 'secret-1',
    });

    // Fire 6 hanging plugin calls simultaneously (Chromium HTTP/1.1 per-origin limit).
    const pluginPromises = Array.from({ length: 6 }, (_, idx) =>
      transport.call('plugin_invoke_contribution', {
        pluginId: 'dimo.browser',
        idx,
      })
    );
    await Promise.resolve();

    // Only MAX_CONCURRENT_PLUGIN_CALLS sockets are consumed by plugin RPCs.
    expect(pluginResolvers).toHaveLength(MAX_CONCURRENT_PLUGIN_CALLS);

    // Core capabilities and conversation_list execute immediately without waiting.
    await expect(transport.capabilities()).resolves.toMatchObject({
      capabilities: ['desktop.electron'],
    });
    await expect(
      transport.call('conversation_list', { workspaceId: 'ws-1' })
    ).resolves.toEqual([{ id: 'conv-1' }]);

    // Resolve each active plugin RPC and verify the queued calls drain cleanly.
    for (let idx = 0; idx < 6; idx += 1) {
      while (pluginResolvers.length <= idx) {
        await Promise.resolve();
      }
      pluginResolvers[idx]!({
        ok: true,
        status: 200,
        json: async () => ({
          operation_id: `op-plugin-${idx}`,
          data: { idx },
        }),
      });
      await Promise.resolve();
      await Promise.resolve();
    }

    await expect(Promise.all(pluginPromises)).resolves.toEqual([
      { idx: 0 },
      { idx: 1 },
      { idx: 2 },
      { idx: 3 },
      { idx: 4 },
      { idx: 5 },
    ]);
  });

  it('rejects queued plugin RPC calls when transport is destroyed', async () => {
    const fetchMock = vi.fn(() => new Promise(() => {}));
    vi.stubGlobal('fetch', fetchMock);

    const transport = new WebTransport({
      baseUrl: 'http://127.0.0.1:17891',
      token: 'secret-1',
    });

    // Saturate the plugin bulkhead slots.
    for (let idx = 0; idx < MAX_CONCURRENT_PLUGIN_CALLS; idx += 1) {
      void transport.call('plugin_command_invoke', { idx });
    }
    const queued = transport.call('plugin_invoke_contribution', {
      queued: true,
    });
    await Promise.resolve();

    transport.destroy();

    await expect(queued).rejects.toMatchObject({
      name: 'WebTransportError',
      code: 'transport_closed',
      retryable: true,
    });
  });

  it('isolates slow conversation_ensure_session_controls and conversation_rebind_session calls so capabilities never starve', async () => {
    const slowResolvers: Array<(value: unknown) => void> = [];
    const fetchMock = vi.fn((url: string) => {
      if (url.endsWith('/api/v1/capabilities')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            protocol_version: '1.0',
            server_version: '0.5.4',
            minimum_client_version: '0.5.0',
            capabilities: ['application.call', 'plugin.read'],
          }),
        });
      }
      return new Promise((resolve) => {
        slowResolvers.push(resolve);
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const transport = new WebTransport({
      baseUrl: 'http://127.0.0.1:17891',
      token: 'secret-1',
    });

    expect(transport.getCachedCapabilities()).toBeNull();

    // Fire 6 hanging session bind / rebind calls simultaneously.
    const slowPromises = [
      transport.call('conversation_ensure_session_controls', { id: 'c1' }),
      transport.call('conversation_ensure_session_controls', { id: 'c2' }),
      transport.call('conversation_ensure_session_controls', { id: 'c3' }),
      transport.call('conversation_ensure_session_controls', { id: 'c4' }),
      transport.call('conversation_rebind_session', { id: 'c5' }),
      transport.call('conversation_rebind_session', { id: 'c6' }),
    ];
    await Promise.resolve();

    // Bulkhead caps active slow requests to MAX_CONCURRENT_PLUGIN_CALLS (2).
    expect(slowResolvers).toHaveLength(MAX_CONCURRENT_PLUGIN_CALLS);

    // /api/v1/capabilities bypasses the slow bulkhead and resolves immediately.
    const caps = await transport.capabilities();
    expect(caps.capabilities).toEqual(['application.call', 'plugin.read']);
    expect(transport.getCachedCapabilities()).toEqual(caps);

    // Reconfigure clears cached capabilities.
    transport.reconfigure({
      baseUrl: 'http://127.0.0.1:17892',
      token: 'secret-2',
    });
    expect(transport.getCachedCapabilities()).toBeNull();

    // Clean up queued calls cleanly on destroy (queued items 2..5 reject with transport_closed).
    transport.destroy();
    await Promise.all(
      slowPromises.slice(MAX_CONCURRENT_PLUGIN_CALLS).map((p) =>
        expect(p).rejects.toMatchObject({
          name: 'WebTransportError',
          code: 'transport_closed',
          retryable: true,
        })
      )
    );
  });
});
