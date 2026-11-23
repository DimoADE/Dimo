import type {
  AgentAvailableCommand,
  AgentConnectionSnapshot,
  AgentEventEnvelope,
  AgentPermissionRequest,
  AgentPromptSnapshot,
  AgentRuntimeSnapshot,
  AgentSessionConfigOption,
  AgentSessionMode,
  AgentSessionSnapshot,
  AgentTerminalSnapshot,
} from './types';

export type AgentSessionModesState = {
  modes: AgentSessionMode[];
  current?: string | null;
};

export type AgentWorkbenchState = {
  connections: Record<string, AgentConnectionSnapshot>;
  sessions: Record<string, AgentSessionSnapshot>;
  prompts: Record<string, AgentPromptSnapshot>;
  permissions: Record<string, AgentPermissionRequest>;
  terminals: Record<string, AgentTerminalSnapshot>;
  sessionModesByScope: Record<string, AgentSessionModesState>;
  sessionConfigOptionsByScope: Record<string, AgentSessionConfigOption[]>;
  availableCommandsByScope: Record<string, AgentAvailableCommand[]>;
  usageByScope: Record<string, { used: number; limit?: number | null }>;
  errorsByScope: Record<string, string[]>;
  /**
   * Kept on the state shape so callers can read a scope key, but never filled.
   * The durable conversation log is the transcript. Retaining every ACP
   * envelope here duplicated tool output in the WebView for the process lifetime.
   */
  eventsByScope: Record<string, AgentEventEnvelope[]>;
  lastSequence: number;
};

export function emptyAgentWorkbenchState(): AgentWorkbenchState {
  return {
    connections: {},
    sessions: {},
    prompts: {},
    permissions: {},
    terminals: {},
    sessionModesByScope: {},
    sessionConfigOptionsByScope: {},
    availableCommandsByScope: {},
    usageByScope: {},
    errorsByScope: {},
    eventsByScope: {},
    lastSequence: 0,
  };
}

export function stateFromAgentSnapshot(
  snapshot: AgentRuntimeSnapshot
): AgentWorkbenchState {
  const snapshotEntities = {
    connections: Object.fromEntries(
      snapshot.connections.map((connection) => [connection.id, connection])
    ),
    sessions: Object.fromEntries(
      snapshot.sessions.map((session) => [session.id, session])
    ),
    prompts: Object.fromEntries(
      snapshot.prompts.map((prompt) => [prompt.id, prompt])
    ),
  };
  const snapshotPermissions = Object.fromEntries(
    (snapshot.permissions ?? []).map((permission) => [
      permission.id,
      permission,
    ])
  );
  const state = snapshot.events.reduce(reduceAgentEvent, {
    ...emptyAgentWorkbenchState(),
    ...snapshotEntities,
  });

  return {
    ...state,
    ...snapshotEntities,
    permissions: {
      ...state.permissions,
      ...snapshotPermissions,
    },
    terminals: {},
    usageByScope: {},
    errorsByScope: {},
    lastSequence: snapshot.sequence,
  };
}

export function hydrateAgentSnapshot(
  state: AgentWorkbenchState,
  snapshot: AgentRuntimeSnapshot
): AgentWorkbenchState {
  if (snapshot.sequence < state.lastSequence) {
    return state;
  }

  return stateFromAgentSnapshot(snapshot);
}

const MAX_RETAINED_WORKBENCH_ERRORS = 8;
const MAX_RETAINED_WORKBENCH_ENTITIES = 128;
const MAX_RETAINED_WORKBENCH_SCOPES = 128;

const WORKBENCH_STATE_EVENT_KINDS = new Set<
  AgentEventEnvelope['event']['kind']
>([
  'connection_status_changed',
  'session_created',
  'prompt_started',
  'prompt_finished',
  'permission_requested',
  'permission_responded',
  'terminal_created',
  'session_modes',
  'mode_changed',
  'session_config_options',
  'config_changed',
  'available_commands',
  'usage',
  'error',
]);

/**
 * High-frequency transcript streaming envelopes (`message_chunk`, `thought_chunk`,
 * `tool_call_update`, etc.) are persisted into the durable conversation log and
 * do not affect AgentWorkbench state.
 */
export function isWorkbenchStateEvent(
  kind: AgentEventEnvelope['event']['kind']
): boolean {
  return WORKBENCH_STATE_EVENT_KINDS.has(kind);
}

function capRecord<T>(
  record: Record<string, T>,
  maxEntries: number,
  isProtected?: (value: T) => boolean
): Record<string, T> {
  const keys = Object.keys(record);
  if (keys.length <= maxEntries) {
    return record;
  }
  let toDrop = keys.length - maxEntries;
  const next: Record<string, T> = {};
  for (const key of keys) {
    const value = record[key];
    if (toDrop > 0 && (!isProtected || !isProtected(value))) {
      toDrop -= 1;
      continue;
    }
    next[key] = value;
  }
  return next;
}

export function reduceAgentEvent(
  state: AgentWorkbenchState,
  envelope: AgentEventEnvelope
): AgentWorkbenchState {
  if (envelope.sequence <= state.lastSequence) {
    return state;
  }

  const next: AgentWorkbenchState = {
    connections: state.connections,
    sessions: state.sessions,
    prompts: state.prompts,
    permissions: state.permissions,
    terminals: state.terminals,
    sessionModesByScope: state.sessionModesByScope,
    sessionConfigOptionsByScope: state.sessionConfigOptionsByScope,
    availableCommandsByScope: state.availableCommandsByScope,
    usageByScope: state.usageByScope,
    errorsByScope: state.errorsByScope,
    eventsByScope: state.eventsByScope,
    lastSequence: envelope.sequence,
  };

  switch (envelope.event.kind) {
    case 'connection_status_changed':
      next.connections = capRecord(
        {
          ...state.connections,
          [envelope.event.snapshot.id]: envelope.event.snapshot,
        },
        MAX_RETAINED_WORKBENCH_ENTITIES,
        (conn) => conn.status === 'connecting' || conn.status === 'ready'
      );
      return next;
    case 'session_created':
      next.sessions = capRecord(
        {
          ...state.sessions,
          [envelope.event.snapshot.id]: envelope.event.snapshot,
        },
        MAX_RETAINED_WORKBENCH_ENTITIES,
        (session) =>
          session.status === 'running' || Boolean(session.active_prompt_id)
      );
      return next;
    case 'prompt_started':
      next.prompts = capRecord(
        {
          ...state.prompts,
          [envelope.event.snapshot.id]: envelope.event.snapshot,
        },
        MAX_RETAINED_WORKBENCH_ENTITIES,
        (prompt) => prompt.status.kind === 'running'
      );
      next.sessions = withSessionPrompt(
        state.sessions,
        envelope.session_id,
        envelope.event.snapshot.id
      );
      return next;
    case 'prompt_finished': {
      const prompt = state.prompts[envelope.event.finished.prompt_id];
      if (prompt) {
        next.prompts = {
          ...state.prompts,
          [prompt.id]: {
            ...prompt,
            status: {
              kind: 'completed',
              stop_reason: envelope.event.finished.stop_reason ?? null,
            },
          },
        };
      }
      next.sessions = clearSessionPrompt(
        next.sessions,
        envelope.session_id,
        envelope.event.finished.prompt_id
      );
      return next;
    }
    case 'permission_requested':
      next.permissions = {
        ...state.permissions,
        [envelope.event.request.id]: envelope.event.request,
      };
      return next;
    case 'permission_responded': {
      const { [envelope.event.permission_id]: _removed, ...permissions } =
        state.permissions;
      next.permissions = permissions;
      return next;
    }
    case 'terminal_created':
      next.terminals = capRecord(
        {
          ...state.terminals,
          [envelope.event.terminal.id]: envelope.event.terminal,
        },
        MAX_RETAINED_WORKBENCH_ENTITIES
      );
      return next;
    case 'session_modes':
      next.sessionModesByScope = capRecord(
        {
          ...state.sessionModesByScope,
          [scopeId(envelope)]: {
            modes: envelope.event.modes,
            current: envelope.event.current ?? null,
          },
        },
        MAX_RETAINED_WORKBENCH_SCOPES
      );
      return next;
    case 'mode_changed': {
      const scope = scopeId(envelope);
      next.sessionModesByScope = capRecord(
        {
          ...state.sessionModesByScope,
          [scope]: {
            modes: state.sessionModesByScope[scope]?.modes ?? [],
            current: envelope.event.mode_id,
          },
        },
        MAX_RETAINED_WORKBENCH_SCOPES
      );
      return next;
    }
    case 'session_config_options':
      next.sessionConfigOptionsByScope = capRecord(
        {
          ...state.sessionConfigOptionsByScope,
          [scopeId(envelope)]: envelope.event.options,
        },
        MAX_RETAINED_WORKBENCH_SCOPES
      );
      return next;
    case 'config_changed': {
      const scope = scopeId(envelope);
      const { key, value } = envelope.event;
      const options = state.sessionConfigOptionsByScope[scope] ?? [];
      next.sessionConfigOptionsByScope = {
        ...state.sessionConfigOptionsByScope,
        [scope]: options.map((option) =>
          option.key === key ? { ...option, value } : option
        ),
      };
      return next;
    }
    case 'config_option_rejected':
      return next;
    case 'available_commands':
      next.availableCommandsByScope = capRecord(
        {
          ...state.availableCommandsByScope,
          [scopeId(envelope)]: envelope.event.commands,
        },
        MAX_RETAINED_WORKBENCH_SCOPES
      );
      return next;
    case 'usage':
      next.usageByScope = capRecord(
        {
          ...state.usageByScope,
          [scopeId(envelope)]: envelope.event.usage,
        },
        MAX_RETAINED_WORKBENCH_SCOPES
      );
      return next;
    case 'error': {
      const scope = scopeId(envelope);
      const prior = state.errorsByScope[scope] ?? [];
      next.errorsByScope = capRecord(
        {
          ...state.errorsByScope,
          [scope]: [...prior, envelope.event.error.message].slice(
            -MAX_RETAINED_WORKBENCH_ERRORS
          ),
        },
        MAX_RETAINED_WORKBENCH_SCOPES
      );
      next.sessions = clearSessionPrompt(state.sessions, envelope.session_id);
      return next;
    }
    default:
      return next;
  }
}

function withSessionPrompt(
  sessions: AgentWorkbenchState['sessions'],
  sessionId: string | null | undefined,
  promptId: string
): AgentWorkbenchState['sessions'] {
  if (!sessionId) return sessions;
  const session = sessions[sessionId];
  if (!session) return sessions;
  return {
    ...sessions,
    [sessionId]: {
      ...session,
      active_prompt_id: promptId,
      status: 'running',
    },
  };
}

function clearSessionPrompt(
  sessions: AgentWorkbenchState['sessions'],
  sessionId: string | null | undefined,
  promptId?: string
): AgentWorkbenchState['sessions'] {
  if (!sessionId) return sessions;
  const session = sessions[sessionId];
  if (!session) return sessions;
  if (
    promptId &&
    session.active_prompt_id &&
    session.active_prompt_id !== promptId
  ) {
    return sessions;
  }
  return {
    ...sessions,
    [sessionId]: {
      ...session,
      active_prompt_id: null,
      status: session.status === 'running' ? 'ready' : session.status,
    },
  };
}

function scopeId(envelope: AgentEventEnvelope): string {
  return envelope.session_id ?? envelope.connection_id;
}
