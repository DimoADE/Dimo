import { describe, expect, it } from 'vitest';
import type {
  ConversationConnectionStatus,
  ConversationError,
  ConversationRequestStatus,
  ConversationSessionNotice,
} from 'shared/types';
import {
  deriveInlineStreamRuntimeStatus,
  parseReconnectProgressTitle,
} from './inlineRuntimeStatus';

const readyConnection = (
  overrides: Partial<ConversationConnectionStatus> = {}
): ConversationConnectionStatus => ({
  status: 'ready',
  bound: true,
  connection_id: 'conn-1',
  message: null,
  since: '2026-11-15T00:00:00Z',
  ...overrides,
});

const requestStatus = (
  phase: ConversationRequestStatus['activity']['phase'],
  overrides: Partial<ConversationRequestStatus> = {}
): ConversationRequestStatus => ({
  turn_id: 'turn-1',
  prompt_id: 'prompt-1',
  connection_id: 'conn-1',
  since: '2026-11-15T00:00:00Z',
  activity: { phase, retry: null },
  ...overrides,
});

const turnError = (
  kind: ConversationError['kind'],
  code: string | null = null
): ConversationError => ({
  message: 'error detail',
  code,
  raw: null,
  kind,
});

describe('deriveInlineStreamRuntimeStatus', () => {
  it('stays silent when connection is ready and bound with no active request', () => {
    expect(
      deriveInlineStreamRuntimeStatus({
        connecting: false,
        connection: readyConnection(),
        request: null,
        isTurnInFlight: false,
        hasStreamingAssistantRow: false,
      })
    ).toEqual({
      status: null,
      placement: null,
      suppressLiveTurnStatsStatus: false,
      suppressAssistantStreamingStatus: false,
      isConnectionRecovering: false,
    });
  });

  it('suppresses failed request status when TurnErrorCard already covers the failure', () => {
    expect(
      deriveInlineStreamRuntimeStatus({
        connecting: false,
        connection: readyConnection(),
        request: requestStatus('failed'),
        latestTurnError: turnError('service_error', 'internal_error'),
        hasLatestTurnErrorRow: true,
        isTurnInFlight: false,
        hasStreamingAssistantRow: false,
      })
    ).toEqual({
      status: null,
      placement: null,
      suppressLiveTurnStatsStatus: false,
      suppressAssistantStreamingStatus: false,
      isConnectionRecovering: false,
    });
  });

  it('suppresses interrupted request status when interrupted-turn notice exists', () => {
    expect(
      deriveInlineStreamRuntimeStatus({
        connecting: false,
        connection: readyConnection(),
        request: requestStatus('interrupted'),
        hasLatestInterruptedRow: true,
        isTurnInFlight: false,
        hasStreamingAssistantRow: false,
      })
    ).toEqual({
      status: null,
      placement: null,
      suppressLiveTurnStatsStatus: false,
      suppressAssistantStreamingStatus: false,
      isConnectionRecovering: false,
    });
  });

  it('collapses connecting flag, reconnect notice, and connection status into one stream entry during an active user turn', () => {
    const genericReconnect: ConversationSessionNotice = {
      title: '正在连接 Agent…',
      message: null,
      severity: 'info',
    };
    const res = deriveInlineStreamRuntimeStatus({
      connecting: true,
      connection: readyConnection({ status: 'recovering', bound: false }),
      request: requestStatus('waiting_agent'),
      reconnectNotice: genericReconnect,
      hasUserMessage: true,
      isTurnInFlight: true,
      hasStreamingAssistantRow: true,
      hasStreamingAssistantContent: false,
    });

    expect(res.placement).toBe('stream');
    expect(res.status?.kind).toBe('connection');
    expect(res.status?.notice.connection_status?.status).toBe('recovering');
    expect(res.status?.titleOverride).toBeNull();
    expect(res.status?.canCancel).toBe(true);
    expect(res.isConnectionRecovering).toBe(true);
    expect(res.suppressLiveTurnStatsStatus).toBe(true);
    expect(res.suppressAssistantStreamingStatus).toBe(true);
  });

  it('routes pre-send connection status to composer placement instead of the message stream', () => {
    const res = deriveInlineStreamRuntimeStatus({
      connecting: false,
      connection: readyConnection({ status: 'recovering', bound: false }),
      request: null,
      reconnectNotice: {
        title: '会话加载异常，正在重连 3/10 次…',
        message: null,
        severity: 'warning',
      },
      hasUserMessage: false,
      isTurnInFlight: false,
      hasStreamingAssistantRow: false,
    });

    expect(res.placement).toBe('composer');
    expect(res.status?.kind).toBe('connection');
    expect(res.status?.titleOverride).toBe('会话加载异常，正在重连 3/10 次…');
    expect(res.suppressAssistantStreamingStatus).toBe(false);
  });

  it('routes pre-send initial connecting state to composer even if no reconnectNotice exists yet', () => {
    const res = deriveInlineStreamRuntimeStatus({
      connecting: true,
      connection: readyConnection({ status: 'connecting', bound: false }),
      request: null,
      hasUserMessage: false,
      isTurnInFlight: false,
      hasStreamingAssistantRow: false,
    });

    expect(res.placement).toBe('composer');
    expect(res.status?.kind).toBe('connection');
    expect(res.status?.notice.connection_status?.status).toBe('connecting');
  });

  it('suppresses connection error when TurnErrorCard already reports a connection failure', () => {
    expect(
      deriveInlineStreamRuntimeStatus({
        connecting: false,
        connection: readyConnection({
          status: 'closed',
          bound: false,
          message: 'socket closed',
        }),
        request: requestStatus('failed'),
        connectErrorNotice: {
          title: '会话出错',
          message: 'socket closed',
          severity: 'error',
        },
        latestTurnError: turnError(
          'connection_closed',
          'agent_connection_lost'
        ),
        hasLatestTurnErrorRow: true,
        isTurnInFlight: false,
        hasStreamingAssistantRow: false,
      }).status
    ).toBeNull();
  });

  it('shows connection error in composer placement when no turn is in flight', () => {
    const res = deriveInlineStreamRuntimeStatus({
      connecting: false,
      connection: readyConnection({
        status: 'closed',
        bound: false,
        message: null,
      }),
      request: null,
      connectErrorNotice: {
        title: 'Agent session recovery failed',
        message: 'transport closed unexpectedly',
        severity: 'error',
      },
      hasUserMessage: false,
      isTurnInFlight: false,
      hasStreamingAssistantRow: false,
    });

    expect(res.placement).toBe('composer');
    expect(res.status?.kind).toBe('connection');
    expect(res.status?.canReconnect).toBe(true);
    expect(res.status?.notice.connection_status?.message).toBe(
      'transport closed unexpectedly'
    );
  });

  it('keeps connecting status in stream while assistant row has no content yet, then hands off once blocks arrive', () => {
    const beforeAssistantBlocks = deriveInlineStreamRuntimeStatus({
      connecting: false,
      connection: readyConnection(),
      request: requestStatus('waiting_agent'),
      hasUserMessage: true,
      isTurnInFlight: true,
      hasStreamingAssistantRow: true,
      hasStreamingAssistantContent: false,
    });
    expect(beforeAssistantBlocks.placement).toBe('stream');
    expect(beforeAssistantBlocks.status?.kind).toBe('request');
    expect(beforeAssistantBlocks.suppressAssistantStreamingStatus).toBe(true);
    expect(beforeAssistantBlocks.suppressLiveTurnStatsStatus).toBe(true);

    const whileResponding = deriveInlineStreamRuntimeStatus({
      connecting: false,
      connection: readyConnection(),
      request: requestStatus('responding'),
      hasUserMessage: true,
      isTurnInFlight: true,
      hasStreamingAssistantRow: true,
      hasStreamingAssistantContent: true,
    });
    expect(whileResponding.status).toBeNull();
    expect(whileResponding.placement).toBeNull();
    expect(whileResponding.suppressAssistantStreamingStatus).toBe(false);
    expect(whileResponding.suppressLiveTurnStatsStatus).toBe(false);
  });

  it('surfaces inline retry/cancel status even when an assistant row has content and suppresses duplicate indicators', () => {
    const res = deriveInlineStreamRuntimeStatus({
      connecting: false,
      connection: readyConnection(),
      request: requestStatus('retrying', {
        activity: {
          phase: 'retrying',
          retry: {
            attempt: 2,
            max_attempts: 5,
            delay_ms: 3000n,
            reason: 'rate limited',
            code: null,
          },
        },
      }),
      hasUserMessage: true,
      isTurnInFlight: true,
      hasStreamingAssistantRow: true,
      hasStreamingAssistantContent: true,
    });

    expect(res.placement).toBe('stream');
    expect(res.status?.kind).toBe('request');
    expect(res.status?.notice.request_status?.activity.phase).toBe('retrying');
    expect(res.status?.canCancel).toBe(true);
    expect(res.suppressLiveTurnStatsStatus).toBe(true);
    expect(res.suppressAssistantStreamingStatus).toBe(true);
  });

  it('ignores leftover non-terminal request state when no turn is in flight', () => {
    expect(
      deriveInlineStreamRuntimeStatus({
        connecting: false,
        connection: readyConnection(),
        request: requestStatus('thinking'),
        isTurnInFlight: false,
        hasStreamingAssistantRow: false,
      }).status
    ).toBeNull();
  });

  it('keeps inline retry available if request failed without a TurnErrorCard row', () => {
    const res = deriveInlineStreamRuntimeStatus({
      connecting: false,
      connection: readyConnection(),
      request: requestStatus('failed'),
      latestTurnError: null,
      hasLatestTurnErrorRow: false,
      isTurnInFlight: false,
      hasStreamingAssistantRow: false,
    });

    expect(res.placement).toBe('stream');
    expect(res.status?.kind).toBe('request');
    expect(res.status?.canRetry).toBe(true);
  });

  it('keeps post-send cold-start connecting in stream before assistant blocks arrive and hands off once content streams', () => {
    const coldStart = deriveInlineStreamRuntimeStatus({
      connecting: true,
      connection: readyConnection({ status: 'connecting', bound: false }),
      request: requestStatus('waiting_agent'),
      reconnectNotice: null,
      hasUserMessage: true,
      isTurnInFlight: true,
      hasStreamingAssistantRow: true,
      hasStreamingAssistantContent: false,
    });

    expect(coldStart.placement).toBe('stream');
    expect(coldStart.status?.kind).toBe('connection');
    expect(coldStart.suppressAssistantStreamingStatus).toBe(true);
    expect(coldStart.isConnectionRecovering).toBe(false);

    const streamingContent = deriveInlineStreamRuntimeStatus({
      connecting: true,
      connection: readyConnection({ status: 'connecting', bound: false }),
      request: requestStatus('responding'),
      reconnectNotice: null,
      hasUserMessage: true,
      isTurnInFlight: true,
      hasStreamingAssistantRow: true,
      hasStreamingAssistantContent: true,
    });

    expect(streamingContent).toEqual({
      status: null,
      placement: null,
      suppressLiveTurnStatsStatus: false,
      suppressAssistantStreamingStatus: false,
      isConnectionRecovering: false,
    });
  });

  it('does not paint a stream connecting spinner over a cancelled in-flight turn', () => {
    const res = deriveInlineStreamRuntimeStatus({
      connecting: true,
      connection: readyConnection({ status: 'recovering', bound: false }),
      request: requestStatus('cancelled'),
      reconnectNotice: {
        title: '正在连接 Agent…',
        message: null,
        severity: 'info',
      },
      hasUserMessage: true,
      isTurnInFlight: true,
      hasStreamingAssistantRow: true,
      hasStreamingAssistantContent: true,
    });

    expect(res.status).toBeNull();
    expect(res.placement).toBeNull();
  });

  it('keeps reconnect after a settled cancel on the composer', () => {
    const res = deriveInlineStreamRuntimeStatus({
      connecting: true,
      connection: readyConnection({ status: 'connecting', bound: false }),
      request: requestStatus('cancelled'),
      hasUserMessage: true,
      isTurnInFlight: false,
      hasStreamingAssistantRow: false,
    });

    expect(res.placement).toBe('composer');
    expect(res.status?.kind).toBe('connection');
    expect(res.status?.notice.connection_status?.status).toBe('connecting');
  });

  it('parses retry counts from reconnect progress titles', () => {
    expect(
      parseReconnectProgressTitle('会话加载异常，正在重连 3/10 次…')
    ).toEqual({
      attempt: 3,
      maxAttempts: 10,
    });
    expect(parseReconnectProgressTitle('Reconnecting 2 / 5...')).toEqual({
      attempt: 2,
      maxAttempts: 5,
    });
    expect(parseReconnectProgressTitle('正在连接 Agent…')).toBeNull();
  });

  it('does not inherit stale closed/bound connection timestamps or error messages while connecting', () => {
    const connectingSince = '2026-11-15T00:16:17Z';
    const fromClosed = deriveInlineStreamRuntimeStatus({
      connecting: true,
      connectingSince,
      connection: readyConnection({
        status: 'closed',
        bound: false,
        message: 'previous idle disconnect',
        since: '2026-11-15T00:00:00Z',
      }),
      request: null,
      hasUserMessage: false,
      isTurnInFlight: false,
      hasStreamingAssistantRow: false,
    });

    expect(fromClosed.status?.kind).toBe('connection');
    expect(fromClosed.status?.notice.connection_status?.status).toBe(
      'connecting'
    );
    expect(fromClosed.status?.notice.connection_status?.since).toBe(
      connectingSince
    );
    expect(fromClosed.status?.notice.connection_status?.message).toBeNull();

    const fromBound = deriveInlineStreamRuntimeStatus({
      connecting: true,
      connectingSince,
      connection: readyConnection({
        status: 'ready',
        bound: true,
        since: '2026-11-15T00:00:00Z',
      }),
      request: null,
      hasUserMessage: false,
      isTurnInFlight: false,
      hasStreamingAssistantRow: false,
    });

    expect(fromBound.status?.notice.connection_status?.since).toBe(
      connectingSince
    );

    const withoutConnectingSince = deriveInlineStreamRuntimeStatus({
      connecting: true,
      connection: readyConnection({
        status: 'closed',
        bound: false,
        since: '2026-11-15T00:00:00Z',
      }),
      request: null,
      hasUserMessage: false,
      isTurnInFlight: false,
      hasStreamingAssistantRow: false,
    });
    expect(withoutConnectingSince.status?.notice.connection_status?.since).toBe(
      ''
    );
  });

  it('stays silent when sessionBindReady is already true despite a stale unbound connection row', () => {
    const res = deriveInlineStreamRuntimeStatus({
      connecting: false,
      sessionBindReady: true,
      connection: readyConnection({
        status: 'connecting',
        bound: false,
        since: '2026-11-15T00:00:00Z',
      }),
      request: null,
      hasUserMessage: false,
      isTurnInFlight: false,
      hasStreamingAssistantRow: false,
    });

    expect(res.status).toBeNull();
    expect(res.placement).toBeNull();
  });

  it('stays silent when an idle connection is closed without an explicit error notice', () => {
    const res = deriveInlineStreamRuntimeStatus({
      connecting: false,
      sessionBindReady: false,
      connection: readyConnection({
        status: 'closed',
        bound: false,
        message: null,
      }),
      request: null,
      connectErrorNotice: null,
      hasUserMessage: true,
      isTurnInFlight: false,
      hasStreamingAssistantRow: false,
    });

    expect(res).toEqual({
      status: null,
      placement: null,
      suppressLiveTurnStatsStatus: false,
      suppressAssistantStreamingStatus: false,
      isConnectionRecovering: false,
    });
  });

  it('surfaces a stream reconnect error when the connection closes during an in-flight turn', () => {
    const res = deriveInlineStreamRuntimeStatus({
      connecting: false,
      sessionBindReady: false,
      connection: readyConnection({
        status: 'closed',
        bound: false,
        message: 'process exited',
      }),
      request: requestStatus('waiting_agent'),
      hasUserMessage: true,
      isTurnInFlight: true,
      hasStreamingAssistantRow: false,
    });

    expect(res.placement).toBe('stream');
    expect(res.status?.kind).toBe('connection');
    expect(res.status?.canReconnect).toBe(true);
    expect(res.status?.notice.connection_status?.message).toBe(
      'process exited'
    );
  });

  it('treats idle-reaped or post-restart closed state as lazy connecting when a new turn starts', () => {
    const withSubmittingRequest = deriveInlineStreamRuntimeStatus({
      connecting: false,
      sessionBindReady: false,
      connection: readyConnection({
        status: 'closed',
        bound: false,
        connection_id: 'old-conn',
        message: null,
        since: '2026-11-25T02:13:42Z',
      }),
      request: requestStatus('submitting', {
        turn_id: 'turn-2',
        prompt_id: null,
        connection_id: null,
        since: '2026-11-25T02:15:57Z',
      }),
      connectErrorNotice: null,
      hasUserMessage: true,
      isTurnInFlight: true,
      hasStreamingAssistantRow: false,
      currentTurnId: 'turn-2',
    });

    expect(withSubmittingRequest.placement).toBe('stream');
    expect(withSubmittingRequest.status?.kind).toBe('connection');
    expect(withSubmittingRequest.status?.notice.severity).toBe('info');
    expect(withSubmittingRequest.status?.notice.connection_status?.status).toBe(
      'connecting'
    );
    expect(withSubmittingRequest.status?.canCancel).toBe(true);
    expect(withSubmittingRequest.status?.canReconnect).toBe(false);

    const optimisticBeforeRequestRow = deriveInlineStreamRuntimeStatus({
      connecting: false,
      sessionBindReady: false,
      connection: readyConnection({
        status: 'closed',
        bound: false,
        connection_id: null,
        message: null,
        since: '2026-11-25T02:13:42Z',
      }),
      request: null,
      connectErrorNotice: null,
      hasUserMessage: true,
      isTurnInFlight: true,
      hasStreamingAssistantRow: false,
    });

    expect(optimisticBeforeRequestRow.placement).toBe('stream');
    expect(optimisticBeforeRequestRow.status?.kind).toBe('connection');
    expect(
      optimisticBeforeRequestRow.status?.notice.connection_status?.status
    ).toBe('connecting');
    expect(optimisticBeforeRequestRow.status?.canReconnect).toBe(false);
  });

  it('does not treat a previous turn closed error timestamped before the new turn as a current-turn failure', () => {
    const res = deriveInlineStreamRuntimeStatus({
      connecting: false,
      sessionBindReady: false,
      connection: readyConnection({
        status: 'closed',
        bound: false,
        connection_id: 'old-conn',
        message: 'previous error',
        since: '2026-11-25T01:00:00Z',
      }),
      request: requestStatus('submitting', {
        turn_id: 'turn-2',
        prompt_id: null,
        connection_id: null,
        since: '2026-11-25T02:15:57Z',
      }),
      connectErrorNotice: null,
      hasUserMessage: true,
      isTurnInFlight: true,
      hasStreamingAssistantRow: false,
      currentTurnId: 'turn-2',
    });

    expect(res.placement).toBe('stream');
    expect(res.status?.kind).toBe('connection');
    expect(res.status?.notice.connection_status?.status).toBe('connecting');
    expect(res.status?.notice.connection_status?.message).toBeNull();
    expect(res.status?.canReconnect).toBe(false);
  });

  it('treats historical closed status with a close message as cold-start connecting before the new prompt dispatches', () => {
    const res = deriveInlineStreamRuntimeStatus({
      connecting: false,
      sessionBindReady: false,
      connection: readyConnection({
        status: 'closed',
        bound: false,
        connection_id: null,
        message: 'Idle timeout closed the connection',
        since: '2026-11-25T01:00:00Z',
      }),
      request: null,
      connectErrorNotice: null,
      hasUserMessage: true,
      isTurnInFlight: true,
      hasStreamingAssistantRow: false,
      currentTurnId: undefined,
    });

    expect(res.placement).toBe('stream');
    expect(res.status?.kind).toBe('connection');
    expect(res.status?.notice.severity).toBe('info');
    expect(res.status?.notice.connection_status?.status).toBe('connecting');
    expect(res.status?.notice.connection_status?.message).toBeNull();
    expect(res.status?.canReconnect).toBe(false);
  });

  it('surfaces mid-turn waiting_model inline after assistant content has started streaming, unless a tool or interaction is active', () => {
    const stalled = deriveInlineStreamRuntimeStatus({
      connecting: false,
      connection: readyConnection(),
      request: requestStatus('waiting_model'),
      hasUserMessage: true,
      isTurnInFlight: true,
      hasStreamingAssistantRow: true,
      hasStreamingAssistantContent: true,
      hasRunningTool: false,
      hasInteraction: false,
    });

    expect(stalled.placement).toBe('stream');
    expect(stalled.status?.kind).toBe('request');
    expect(stalled.status?.notice.request_status?.activity.phase).toBe(
      'waiting_model'
    );
    expect(stalled.suppressAssistantStreamingStatus).toBe(true);
    expect(stalled.suppressLiveTurnStatsStatus).toBe(true);

    const runningTool = deriveInlineStreamRuntimeStatus({
      connecting: false,
      connection: readyConnection(),
      request: requestStatus('waiting_model'),
      hasUserMessage: true,
      isTurnInFlight: true,
      hasStreamingAssistantRow: true,
      hasStreamingAssistantContent: true,
      hasRunningTool: true,
      hasInteraction: false,
    });
    expect(runningTool.status).toBeNull();
    expect(runningTool.placement).toBeNull();

    const waitingUser = deriveInlineStreamRuntimeStatus({
      connecting: false,
      connection: readyConnection(),
      request: requestStatus('waiting_model'),
      hasUserMessage: true,
      isTurnInFlight: true,
      hasStreamingAssistantRow: true,
      hasStreamingAssistantContent: true,
      hasRunningTool: false,
      hasInteraction: true,
    });
    expect(waitingUser.status).toBeNull();
    expect(waitingUser.placement).toBeNull();
  });
});
