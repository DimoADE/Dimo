import { BrowserRpcError, type ElectronBrowserController } from './controller';

export const BROWSER_BRIDGE_SUBPROTOCOL = 'dimo-browser-bridge';

export interface NativeTabsRpcClientOptions {
  getConnection: () => { baseUrl: string; token: string };
  controller: ElectronBrowserController;
  getDownloadsDir?: () => string | undefined;
  maxConcurrentRpcs?: number;
  maxQueuedRpcs?: number;
}

export interface NavigationPolicyResult {
  allowed: boolean;
  preferSystem: boolean;
}

interface InboundRpcRequest {
  type: 'rpc_request';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface InboundPolicyResponse {
  type: 'policy_response';
  id: number;
  allowed?: boolean;
  preferSystem?: boolean;
}

const POLICY_CHECK_TIMEOUT_MS = 1_500;
const DEFAULT_MAX_CONCURRENT_RPCS = 16;
const DEFAULT_MAX_QUEUED_RPCS = 256;
const DEFAULT_POLICY_ALLOW: NavigationPolicyResult = {
  allowed: true,
  preferSystem: false,
};

export class NativeTabsRpcClient {
  private readonly getConnection: () => { baseUrl: string; token: string };
  private readonly controller: ElectronBrowserController;
  private readonly getDownloadsDir: () => string | undefined;
  private readonly maxConcurrentRpcs: number;
  private readonly maxQueuedRpcs: number;

  private socket: WebSocket | null = null;
  private running = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = 250;
  private readyResolvers: Array<(connected: boolean) => void> = [];
  private activeRpcs = 0;
  private rpcQueue: Array<{ req: InboundRpcRequest; socket: WebSocket | null }> = [];
  private nextPolicyId = 1;
  private pendingPolicies = new Map<
    number,
    {
      resolve: (policy: NavigationPolicyResult) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(options: NativeTabsRpcClientOptions) {
    this.getConnection = options.getConnection;
    this.controller = options.controller;
    this.getDownloadsDir = options.getDownloadsDir ?? (() => undefined);
    this.maxConcurrentRpcs = Math.max(
      1,
      Math.floor(options.maxConcurrentRpcs ?? DEFAULT_MAX_CONCURRENT_RPCS)
    );
    this.maxQueuedRpcs = Math.max(
      0,
      Math.floor(options.maxQueuedRpcs ?? DEFAULT_MAX_QUEUED_RPCS)
    );
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.backoffMs = 250;
    this.connect();
  }

  stop(): void {
    this.running = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.resolveAllReadyWaiters(false);
    this.resolveAllPendingPolicies(DEFAULT_POLICY_ALLOW);
    this.rpcQueue.length = 0;
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // Ignore close errors during teardown.
      }
      this.socket = null;
    }
  }

  isConnected(): boolean {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
  }

  waitUntilConnected(timeoutMs = 3_000): Promise<boolean> {
    if (this.isConnected()) {
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          const idx = this.readyResolvers.indexOf(onReady);
          if (idx >= 0) this.readyResolvers.splice(idx, 1);
          resolve(false);
        }
      }, timeoutMs);
      const onReady = (connected: boolean) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(connected);
        }
      };
      this.readyResolvers.push(onReady);
    });
  }

  sendEvent(payload: Record<string, unknown>): void {
    this.sendJson({
      type: 'event',
      payload,
    });
  }

  checkNavigation(url: string): Promise<NavigationPolicyResult> {
    const ws = this.socket;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.resolve(DEFAULT_POLICY_ALLOW);
    }
    const id = this.nextPolicyId++;
    return new Promise<NavigationPolicyResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingPolicies.delete(id);
        resolve(DEFAULT_POLICY_ALLOW);
      }, POLICY_CHECK_TIMEOUT_MS);
      this.pendingPolicies.set(id, { resolve, timer });
      try {
        ws.send(
          JSON.stringify({
            type: 'check_navigation',
            id,
            url,
          })
        );
      } catch {
        clearTimeout(timer);
        this.pendingPolicies.delete(id);
        resolve(DEFAULT_POLICY_ALLOW);
      }
    });
  }

  private resolveAllReadyWaiters(connected: boolean): void {
    const waiters = this.readyResolvers.splice(0, this.readyResolvers.length);
    for (const resolve of waiters) {
      resolve(connected);
    }
  }

  private resolveAllPendingPolicies(fallback: NavigationPolicyResult): void {
    for (const entry of this.pendingPolicies.values()) {
      clearTimeout(entry.timer);
      entry.resolve(fallback);
    }
    this.pendingPolicies.clear();
  }

  private connect(): void {
    if (!this.running) {
      return;
    }
    let baseUrl: string;
    let token: string;
    try {
      const conn = this.getConnection();
      baseUrl = conn.baseUrl;
      token = conn.token;
    } catch {
      this.scheduleReconnect();
      return;
    }

    const wsUrl = `${baseUrl.replace(/^http/i, 'ws')}/api/v1/desktop/browser-bridge`;
    const protocols = [BROWSER_BRIDGE_SUBPROTOCOL, `dimo-token.${token}`];

    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl, protocols);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.socket = ws;

    ws.addEventListener('open', () => {
      if (this.socket !== ws) return;
      this.backoffMs = 250;
      this.sendJson({
        type: 'hello',
        downloadsDir: this.getDownloadsDir() ?? null,
        proxyCapability: {
          supported: true,
          active: null,
          source: 'system',
        },
      });
      this.resolveAllReadyWaiters(true);
    });

    ws.addEventListener('message', (event) => {
      const text = typeof event.data === 'string' ? event.data : String(event.data ?? '');
      this.handleMessage(text, ws);
    });

    ws.addEventListener('close', () => {
      if (this.socket === ws) {
        this.socket = null;
        this.rpcQueue.length = 0;
      }
      this.resolveAllPendingPolicies(DEFAULT_POLICY_ALLOW);
      this.scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      // `close` event follows and triggers reconnect.
    });
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer) {
      return;
    }
    const delay = this.backoffMs;
    this.backoffMs = Math.min(5_000, this.backoffMs * 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private sendJson(payload: Record<string, unknown>, targetSocket?: WebSocket | null): void {
    const ws = targetSocket === undefined ? this.socket : targetSocket;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      // Ignore transient send errors; socket close handles reconnect.
    }
  }

  private handleMessage(raw: string, sourceSocket: WebSocket | null): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return;
    }
    const msgType = (parsed as { type?: unknown }).type;
    if (msgType === 'policy_response') {
      const resp = parsed as InboundPolicyResponse;
      if (typeof resp.id === 'number') {
        const waiter = this.pendingPolicies.get(resp.id);
        if (waiter) {
          clearTimeout(waiter.timer);
          this.pendingPolicies.delete(resp.id);
          waiter.resolve({
            allowed: resp.allowed !== false,
            preferSystem: Boolean(resp.preferSystem),
          });
        }
      }
      return;
    }
    if (msgType !== 'rpc_request') {
      return;
    }
    const req = parsed as InboundRpcRequest;
    if (typeof req.id !== 'number' || typeof req.method !== 'string') {
      return;
    }

    if (this.activeRpcs >= this.maxConcurrentRpcs) {
      if (this.rpcQueue.length >= this.maxQueuedRpcs) {
        this.sendJson(
          {
            type: 'rpc_response',
            id: req.id,
            ok: false,
            code: 'browser_busy',
            message: 'Too many concurrent browser RPC requests',
          },
          sourceSocket
        );
        return;
      }
      this.rpcQueue.push({ req, socket: sourceSocket });
      return;
    }

    void this.runRpcRequest(req, sourceSocket);
  }

  private async runRpcRequest(
    req: InboundRpcRequest,
    sourceSocket: WebSocket | null
  ): Promise<void> {
    this.activeRpcs += 1;
    try {
      const result = await this.controller.handleRpc(
        req.method,
        req.params && typeof req.params === 'object' ? req.params : {}
      );
      if (this.socket === sourceSocket) {
        this.sendJson(
          {
            type: 'rpc_response',
            id: req.id,
            ok: true,
            result: result ?? null,
          },
          sourceSocket
        );
      }
    } catch (error) {
      if (this.socket === sourceSocket) {
        const code =
          error instanceof BrowserRpcError ? error.code : 'browser_native_error';
        const message =
          error instanceof Error ? error.message : String(error ?? 'unknown error');
        this.sendJson(
          {
            type: 'rpc_response',
            id: req.id,
            ok: false,
            code,
            message,
          },
          sourceSocket
        );
      }
    } finally {
      this.activeRpcs -= 1;
      this.drainRpcQueue();
    }
  }

  private drainRpcQueue(): void {
    while (
      this.running &&
      this.activeRpcs < this.maxConcurrentRpcs &&
      this.rpcQueue.length > 0
    ) {
      const next = this.rpcQueue.shift()!;
      if (next.socket !== this.socket) {
        continue;
      }
      void this.runRpcRequest(next.req, next.socket);
    }
  }
}
