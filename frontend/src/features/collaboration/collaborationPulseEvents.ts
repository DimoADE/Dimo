import type {
  EventEnvelope,
  EventSourceKind,
  GroupDispatchMode,
  PulseEvalMode,
  PulseRuleSpec,
  PulseRuleView,
  PulseTemporalSpec,
} from '@/lib/api/pulse';

export function detectLocalTimezone(): string {
  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (typeof resolved === 'string' && resolved.trim()) {
      return resolved.trim();
    }
  } catch {
    // Fall back to UTC in environments without full Intl timezone support.
  }
  return 'UTC';
}

export const COLLABORATION_PULSE_PROPOSAL_EVENT =
  'vibex:collaboration-pulse-proposal';

export type CollaborationPulseProposalDetail =
  | {
      kind: 'spec';
      spec: PulseRuleSpec;
      contextLabel?: string;
    }
  | {
      kind: 'bot';
      memberId: string;
      botName: string;
      mode?: 'event' | 'schedule';
      workspaceId?: string | null;
      projectId?: string | null;
    }
  | {
      kind: 'group-seat';
      spaceId?: string | null;
      spaceName?: string | null;
      memberId?: string | null;
      nickname: string;
      workspaceId?: string | null;
      projectId?: string | null;
    };

export function requestCollaborationPulseProposal(
  detail: CollaborationPulseProposalDetail
) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<CollaborationPulseProposalDetail>(
      COLLABORATION_PULSE_PROPOSAL_EVENT,
      { detail }
    )
  );
}

export function defaultTemporalSpecForSource(
  sourceKind: EventSourceKind
): PulseTemporalSpec | null {
  switch (sourceKind) {
    case 'time_cron':
      return {
        kind: 'cron',
        expression: '0 9 * * 1-5',
        timezone: detectLocalTimezone(),
        weekdaysOnly: true,
        catchUpOnce: true,
      };
    case 'time_once':
      return {
        kind: 'once',
        fireAt: new Date(Date.now() + 3_600_000).toISOString(),
      };
    case 'time_interval':
      return {
        kind: 'interval',
        everySeconds: 900,
        skipIfBusy: true,
      };
    case 'time_sla':
      return {
        kind: 'inactivity_sla',
        threadKeyPrefix: 'group:',
        timeoutSeconds: 1800,
        expectedEventTypes: ['message.replied'],
      };
    default:
      return null;
  }
}

export function isTemporalSourceKind(sourceKind: EventSourceKind): boolean {
  return (
    sourceKind === 'time_cron' ||
    sourceKind === 'time_once' ||
    sourceKind === 'time_interval' ||
    sourceKind === 'time_sla'
  );
}

export function defaultEventTypeForSource(sourceKind: EventSourceKind): string {
  switch (sourceKind) {
    case 'feishu':
      return 'feishu.im.message.receive_v1';
    case 'jira':
      return 'jira.issue.updated';
    case 'github':
      return 'github.pull_request.opened';
    case 'webhook_standard':
    case 'webhook_custom':
      return 'webhook.event';
    case 'time_cron':
      return 'pulse.cron.tick';
    case 'time_once':
      return 'pulse.once.fire';
    case 'time_interval':
      return 'pulse.interval.tick';
    case 'time_sla':
      return 'pulse.sla.expired';
    default:
      return 'custom.event';
  }
}

export function buildBotPulseProposalSpec({
  memberId,
  botName,
  sourceKind = 'webhook_standard',
  evalMode = 'observe',
  description = '',
  workspaceId = null,
  projectId = null,
}: {
  memberId: string;
  botName: string;
  sourceKind?: EventSourceKind;
  evalMode?: PulseEvalMode;
  description?: string;
  workspaceId?: string | null;
  projectId?: string | null;
}): PulseRuleSpec {
  const trimmed = description.trim();
  const temporal = defaultTemporalSpecForSource(sourceKind);
  const eventType = defaultEventTypeForSource(sourceKind);
  return {
    name: trimmed ? trimmed.slice(0, 64) : `${botName} Event Trigger`,
    description: trimmed || null,
    projectId,
    workspaceId,
    evalMode,
    orchestrator: 'direct_reflex',
    filter: {
      sourceKinds: [sourceKind],
      sourceInstanceIds: [],
      eventTypes: eventType ? [eventType] : [],
      allowedActors: [],
      conditions: isTemporalSourceKind(sourceKind)
        ? []
        : [{ op: 'not_bot_actor' }],
    },
    temporal,
    targets: [
      {
        kind: 'bot',
        memberId,
        conversationScope: 'fixed_primary',
        mailboxPolicy: 'fifo_serial',
        subscribeThread: true,
        promptTemplate: trimmed
          ? `${trimmed}\n\nEvent {{event.type}} ({{threadKey}}):\n{{summary}}`
          : `Handle {{event.type}} from {{actor.displayName}} on {{threadKey}}:\n{{summary}}`,
      },
    ],
  };
}

export function buildGroupPulseProposalSpec({
  spaceId,
  spaceName,
  dispatchMode,
  sourceKind = 'webhook_standard',
  evalMode = 'observe',
  description = '',
  workspaceId = null,
  projectId = null,
}: {
  spaceId: string;
  spaceName: string;
  dispatchMode: GroupDispatchMode;
  sourceKind?: EventSourceKind;
  evalMode?: PulseEvalMode;
  description?: string;
  workspaceId?: string | null;
  projectId?: string | null;
}): PulseRuleSpec {
  const trimmed = description.trim();
  const temporal = defaultTemporalSpecForSource(sourceKind);
  const eventType = defaultEventTypeForSource(sourceKind);
  return {
    name: trimmed ? trimmed.slice(0, 64) : `${spaceName} Group Trigger`,
    description: trimmed || null,
    projectId,
    workspaceId,
    evalMode,
    orchestrator: 'direct_reflex',
    filter: {
      sourceKinds: [sourceKind],
      sourceInstanceIds: [],
      eventTypes: eventType ? [eventType] : [],
      allowedActors: [],
      conditions: isTemporalSourceKind(sourceKind)
        ? []
        : [{ op: 'not_bot_actor' }],
    },
    temporal,
    targets: [
      {
        kind: 'group',
        spaceId,
        dispatchMode,
        messageTemplate: trimmed
          ? `${trimmed}\n\n[{{event.type}}] {{summary}}`
          : `[{{event.type}}] {{actor.displayName}}: {{summary}}`,
      },
    ],
  };
}

export function buildSampleEnvelopeForSource(
  sourceKind: EventSourceKind,
  eventType?: string,
  payloadOverride?: unknown
): EventEnvelope {
  const resolvedType =
    eventType?.trim() || defaultEventTypeForSource(sourceKind);
  const defaultPayload =
    payloadOverride !== undefined
      ? payloadOverride
      : {
          summary: 'High-priority P0 regression reported on checkout service',
          issue: { key: 'PROJ-128', priority: 'High', status: 'Open' },
          pr: { number: 42, branch: 'feat/pulse-engine' },
          message: { text: 'Please triage this incident' },
        };

  return {
    eventId: 'evt-sample-01',
    deliveryId: 'dlv-sample-01',
    source: {
      kind: sourceKind,
      instanceId: `${sourceKind}-primary`,
      trustLevel: isTemporalSourceKind(sourceKind)
        ? 'trusted_internal'
        : 'verified_external',
    },
    eventType: resolvedType,
    occurredAt: new Date().toISOString(),
    actor: {
      id: 'user-alex',
      displayName: 'Alex Chen',
      roles: ['maintainer'],
      isBot: false,
      isSelf: false,
    },
    threadKey:
      sourceKind === 'jira'
        ? 'jira:PROJ-128'
        : sourceKind === 'github'
          ? 'github:vibex/core#42'
          : sourceKind === 'feishu'
            ? 'feishu:oc_chat_01'
            : 'webhook:inc-01',
    correlations: [],
    replyChannels: [],
    trace: {
      rootEventId: 'evt-sample-01',
      parentRunId: null,
      hopCount: 0,
    },
    payload: defaultPayload,
  };
}

function setJsonPointerValue(
  target: Record<string, unknown>,
  pointer: string,
  value: unknown
) {
  const segments = pointer
    .split('/')
    .slice(1)
    .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (segments.length === 0) return;
  let cursor: Record<string, unknown> = target;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const key = segments[i];
    if (!key) return;
    const existing = cursor[key];
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }
  const leaf = segments[segments.length - 1];
  if (leaf) {
    cursor[leaf] = value;
  }
}

export function buildManualTestEnvelopeForRule(
  rule: PulseRuleView
): EventEnvelope {
  const uniqueId =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const temporal = rule.spec.temporal;
  let sourceKind: EventSourceKind;
  let instanceId: string;
  if (temporal) {
    switch (temporal.kind) {
      case 'cron':
        sourceKind = 'time_cron';
        instanceId = `temporal:${rule.id}`;
        break;
      case 'once':
        sourceKind = 'time_once';
        instanceId = `temporal:${rule.id}`;
        break;
      case 'interval':
        sourceKind = 'time_interval';
        instanceId = `temporal:${rule.id}`;
        break;
      case 'inactivity_sla':
        sourceKind = 'time_sla';
        instanceId = `sla:${rule.id}`;
        break;
    }
  } else {
    sourceKind = rule.spec.filter.sourceKinds[0] ?? 'webhook_standard';
    instanceId = rule.spec.filter.sourceInstanceIds[0] ?? 'manual-test';
  }

  const eventType =
    rule.spec.filter.eventTypes[0] || defaultEventTypeForSource(sourceKind);

  const payload: Record<string, unknown> = {
    summary: `Manual test trigger for ${rule.spec.name}`,
    manualTest: true,
    ruleId: rule.id,
  };

  for (const cond of rule.spec.filter.conditions) {
    if (cond.op === 'contains') {
      setJsonPointerValue(payload, cond.pointer, cond.needle);
    } else if (cond.op === 'eq') {
      setJsonPointerValue(payload, cond.pointer, cond.value);
    } else if (cond.op === 'in_set' && cond.values.length > 0) {
      setJsonPointerValue(payload, cond.pointer, cond.values[0]);
    } else if (cond.op === 'exists') {
      setJsonPointerValue(payload, cond.pointer, true);
    } else if (cond.op === 'gt') {
      setJsonPointerValue(payload, cond.pointer, cond.value + 1);
    } else if (cond.op === 'gte') {
      setJsonPointerValue(payload, cond.pointer, cond.value);
    } else if (cond.op === 'lt') {
      setJsonPointerValue(payload, cond.pointer, cond.value - 1);
    } else if (cond.op === 'lte') {
      setJsonPointerValue(payload, cond.pointer, cond.value);
    }
  }

  const allowedActor = rule.spec.filter.allowedActors[0];
  const eventId = `evt-manual-${uniqueId}`;
  const threadKey =
    temporal?.kind === 'inactivity_sla'
      ? `${temporal.threadKeyPrefix}manual-test`
      : `manual-test:${rule.id}`;

  return {
    eventId,
    deliveryId: `dlv-manual-${uniqueId}`,
    source: {
      kind: sourceKind,
      instanceId,
      trustLevel: 'trusted_human',
    },
    eventType,
    occurredAt: new Date().toISOString(),
    actor: {
      id: allowedActor || 'user:local-desktop',
      displayName: 'Manual Test',
      roles: ['owner'],
      isBot: false,
      isSelf: false,
    },
    threadKey,
    correlations: [],
    replyChannels: [],
    trace: {
      rootEventId: eventId,
      parentRunId: null,
      hopCount: 0,
    },
    payload,
  };
}
