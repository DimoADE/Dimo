import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pulseApi, type PulseRuleView } from '@/lib/api/pulse';
import { collaborationCall } from './collaborationApi';
import {
  buildBotPulseProposalSpec,
  buildGroupPulseProposalSpec,
} from './collaborationPulseEvents';
import { AssistantDetailsTasksTab } from './AssistantDetailsTasksTab';
import { PulseRuleProposalCard } from './PulseRuleProposalCard';
import { BotAutomationsPanel } from './BotAutomationsPanel';
import { GroupPulsePanel } from './GroupPulsePanel';

vi.mock('@/lib/api/pulse', () => ({
  pulseApi: {
    deckSnapshot: vi.fn(),
    listRules: vi.fn(),
    saveRule: vi.fn(),
    setRuleMode: vi.fn(),
    setRuleEnabled: vi.fn(),
    deleteRule: vi.fn(),
    subscribeThread: vi.fn(),
    unsubscribeThread: vi.fn(),
    promoteObservedCandidate: vi.fn(),
  },
}));

vi.mock('@/lib/backendTransport', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/backendTransport')>();
  return {
    ...actual,
    backendListen: vi.fn().mockResolvedValue(() => undefined),
  };
});

vi.mock('./collaborationApi', () => ({
  collaborationCall: vi.fn().mockResolvedValue({
    config: {
      agent_id: 'claude-code',
      workspace_id: 'ws-from-config',
    },
  }),
}));

vi.mock('@/contexts/WorktreeContext', () => ({
  useOptionalWorktree: () => ({
    activeWorktreeId: 'ws-active-context',
    activeTaskId: null,
    setActiveWorktree: vi.fn(),
  }),
}));

function makeSavedRule(overrides: Partial<PulseRuleView> = {}): PulseRuleView {
  return {
    id: 'rule-1',
    revision: 2,
    enabled: true,
    draftOnly: false,
    mandateOrigin: 'explicit_human',
    spec: buildBotPulseProposalSpec({
      memberId: 'bot-1',
      botName: 'Triage Bot',
      sourceKind: 'jira',
      evalMode: 'observe',
      description: 'Triage P0 bugs',
    }),
    webhookRouteId: null,
    nextFireAt: null,
    matchedCount: 4,
    observedCount: 2,
    createdAt: '2026-11-15T00:00:00Z',
    updatedAt: '2026-11-15T00:00:00Z',
    ...overrides,
  };
}

describe('Collaboration Pulse UI (Track F5 / R4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('preserves extra filter conditions in PulseRuleProposalCard and renders semantic bg-success/[0.06] saved banner', async () => {
    const user = userEvent.setup();
    const baseSpec = buildBotPulseProposalSpec({
      memberId: 'bot-1',
      botName: 'Triage Bot',
      sourceKind: 'jira',
      evalMode: 'observe',
      description: 'Triage P0 bugs',
    });
    const specWithExtraConditions = {
      ...baseSpec,
      filter: {
        ...baseSpec.filter,
        conditions: [
          { op: 'not_bot_actor' as const },
          { op: 'contains' as const, pointer: '/summary', needle: 'P0' },
          { op: 'eq' as const, pointer: '/issue/priority', value: 'High' },
          {
            op: 'in_set' as const,
            pointer: '/issue/key',
            values: ['PROJ-128', 'PROJ-129'],
          },
        ],
      },
    };
    const saved = makeSavedRule({ spec: specWithExtraConditions });
    vi.mocked(pulseApi.saveRule).mockResolvedValue(saved);
    const onSaved = vi.fn();

    render(
      <PulseRuleProposalCard
        initialSpec={specWithExtraConditions}
        contextLabel="Bot · Triage Bot"
        onSaved={onSaved}
      />
    );

    expect(screen.getByTestId('pulse-dry-run-status')).toHaveTextContent(
      '已命中'
    );

    await user.click(screen.getByTestId('pulse-save-rule-btn'));

    await waitFor(() => {
      expect(pulseApi.saveRule).toHaveBeenCalledWith(
        expect.objectContaining({
          spec: expect.objectContaining({
            filter: expect.objectContaining({
              conditions: [
                { op: 'not_bot_actor' },
                { op: 'contains', pointer: '/summary', needle: 'P0' },
                { op: 'eq', pointer: '/issue/priority', value: 'High' },
                {
                  op: 'in_set',
                  pointer: '/issue/key',
                  values: ['PROJ-128', 'PROJ-129'],
                },
              ],
            }),
          }),
        })
      );
    });
    expect(onSaved).toHaveBeenCalledWith(saved);
    const banner = screen.getByTestId('pulse-rule-saved-banner');
    expect(banner).toBeInTheDocument();
    expect(banner.className).toContain('bg-success/[0.06]');
  });

  it('switches PulseRuleProposalCard labels cleanly between zh-CN and en', async () => {
    const { act } = await import('@testing-library/react');
    const i18n = (await import('@/i18n')).default;
    const groupSpec = buildGroupPulseProposalSpec({
      spaceId: 'space-core',
      spaceName: 'Core Team',
      dispatchMode: { type: 'specific_seat', memberId: 'seat-qa' },
      sourceKind: 'github',
      evalMode: 'observe',
      description: 'Notify QA on PR failure',
    });

    try {
      await act(async () => {
        await i18n.changeLanguage('zh-CN');
      });

      render(
        <PulseRuleProposalCard
          initialSpec={groupSpec}
          contextLabel="Group · Core Team"
          roster={[{ memberId: 'seat-qa', nickname: 'QA' }]}
        />
      );

      expect(screen.getByText('自动化规则提案')).toBeInTheDocument();
      expect(screen.getByLabelText('规则名称')).toBeInTheDocument();
      expect(
        screen.getByTestId('pulse-group-dispatch-summary')
      ).toHaveTextContent('席位：@QA');
      expect(screen.getByTestId('pulse-save-rule-btn')).toHaveTextContent(
        '保存自动化规则'
      );

      await act(async () => {
        await i18n.changeLanguage('en');
      });

      expect(screen.getByText('Automation Rule Proposal')).toBeInTheDocument();
      expect(screen.getByLabelText('Rule Name')).toBeInTheDocument();
      expect(
        screen.getByTestId('pulse-group-dispatch-summary')
      ).toHaveTextContent('Seat: @QA');
      expect(screen.getByTestId('pulse-save-rule-btn')).toHaveTextContent(
        'Save Automation Rule'
      );
    } finally {
      await act(async () => {
        await i18n.changeLanguage('zh-CN');
      });
    }
  });

  it('renders BotAutomationsPanel via usePulseDeckSnapshot, surfaces inline error alerts with retry, and propagates workspaceId from AssistantDetailsTasksTab', async () => {
    const user = userEvent.setup();
    const rule = makeSavedRule();
    vi.mocked(pulseApi.deckSnapshot).mockResolvedValue({
      engineActive: true,
      activeTicketCount: 0,
      pendingUserInteractionCount: 0,
      sources: [],
      rules: [rule],
      observedCandidates: [],
      subscriptions: [],
      pendingInteractions: [],
    });
    vi.mocked(pulseApi.setRuleEnabled).mockRejectedValueOnce(
      new Error('Engine lock timeout')
    );

    const { unmount } = render(
      <BotAutomationsPanel memberId="bot-1" botName="Triage Bot" />
    );

    expect(await screen.findByText(rule.spec.name)).toBeInTheDocument();
    expect(pulseApi.listRules).not.toHaveBeenCalled();

    const enabledSwitch = screen.getByRole('switch');
    expect(enabledSwitch).toBeChecked();
    await user.click(enabledSwitch);

    // Inline error alert surfaces failure instead of silently swallowing
    expect(
      await screen.findByTestId('bot-automations-error')
    ).toHaveTextContent('Engine lock timeout');
    expect(enabledSwitch).toBeChecked();

    await user.click(screen.getByTestId('bot-automations-retry'));
    await waitFor(() => {
      expect(
        screen.queryByTestId('bot-automations-error')
      ).not.toBeInTheDocument();
    });

    unmount();

    // Verify AssistantDetailsTasksTab wraps BotAutomationsPanel and propagates workspaceId
    vi.mocked(collaborationCall).mockResolvedValue({
      config: { agent_id: 'claude-code', workspace_id: 'ws-member-cfg' },
    });
    vi.mocked(pulseApi.saveRule).mockImplementation(async ({ spec }) =>
      makeSavedRule({ id: 'rule-ws', spec })
    );

    const testQueryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={testQueryClient}>
        <AssistantDetailsTasksTab memberId="bot-1" botName="Triage Bot" />
      </QueryClientProvider>
    );

    expect(
      screen.getByTestId('collaboration-assistant-details-tasks')
    ).toHaveClass('collaboration-assistant-details-tasks');
    await user.click(await screen.findByTestId('bot-automations-new-trigger'));
    await user.click(screen.getByTestId('pulse-save-rule-btn'));

    await waitFor(() => {
      expect(pulseApi.saveRule).toHaveBeenCalledWith(
        expect.objectContaining({
          spec: expect.objectContaining({
            workspaceId: 'ws-active-context',
          }),
        })
      );
    });
  });

  it('renders GroupPulsePanel from shared snapshot without listRules waterfall and surfaces inline error banner', async () => {
    const user = userEvent.setup();
    const groupSpec = buildGroupPulseProposalSpec({
      spaceId: 'space-core',
      spaceName: 'Core Team',
      dispatchMode: { type: 'specific_seat', memberId: 'seat-qa' },
      sourceKind: 'github',
      evalMode: 'observe',
      description: 'Notify QA on PR failure',
    });
    const groupRule = makeSavedRule({
      id: 'rule-group-1',
      spec: groupSpec,
    });

    vi.mocked(pulseApi.deckSnapshot).mockResolvedValue({
      engineActive: true,
      activeTicketCount: 0,
      pendingUserInteractionCount: 0,
      sources: [],
      rules: [groupRule],
      observedCandidates: [],
      subscriptions: [
        {
          id: 'sub-1',
          threadKey: 'github:org/repo#99',
          subscriberKind: 'group',
          subscriberId: 'space-core',
          active: true,
          createdAt: '2026-11-15T00:00:00Z',
        },
      ],
      pendingInteractions: [],
    });
    vi.mocked(pulseApi.subscribeThread)
      .mockRejectedValueOnce(new Error('Thread key rejected'))
      .mockResolvedValueOnce({
        id: 'sub-2',
        threadKey: 'jira:CORE-77',
        subscriberKind: 'group',
        subscriberId: 'space-core',
        active: true,
        createdAt: '2026-11-15T00:00:00Z',
      });

    render(
      <GroupPulsePanel
        spaceId="space-core"
        spaceName="Core Team"
        roster={[{ memberId: 'seat-qa', nickname: 'QA' }]}
      />
    );

    expect(await screen.findByText(groupSpec.name)).toBeInTheDocument();
    expect(screen.getByText('github:org/repo#99')).toBeInTheDocument();
    expect(pulseApi.listRules).not.toHaveBeenCalled();

    const input = screen.getByPlaceholderText(/jira:PROJ-123/i);
    await user.type(input, 'jira:CORE-77');
    await user.click(screen.getByTestId('group-pulse-subscribe-btn'));

    expect(await screen.findByTestId('group-pulse-error')).toHaveTextContent(
      'Thread key rejected'
    );

    await user.click(screen.getByTestId('group-pulse-subscribe-btn'));
    await waitFor(() => {
      expect(pulseApi.subscribeThread).toHaveBeenCalledWith(
        'jira:CORE-77',
        'group',
        'space-core'
      );
    });
  });

  it('switches between task creation forms and limits task card actions to enablement and deletion', async () => {
    const user = userEvent.setup();
    const baseEventSpec = buildBotPulseProposalSpec({
      memberId: 'bot-1',
      botName: 'Triage Bot',
      sourceKind: 'jira',
      evalMode: 'observe',
      description: 'Triage P0 bugs',
    });
    const eventRule = makeSavedRule({
      id: 'rule-event',
      spec: {
        ...baseEventSpec,
        targets: [
          {
            kind: 'bot',
            memberId: 'bot-1',
            conversationScope: 'per_thread_topic',
            mailboxPolicy: 'coalesce_batch',
            promptTemplate: 'Summarize the matching ticket.',
          },
        ],
        filter: {
          ...baseEventSpec.filter,
          sourceKinds: ['jira'],
          eventTypes: ['jira.issue.updated'],
          conditions: [
            { op: 'not_bot_actor' },
            { op: 'contains', pointer: '/summary', needle: 'P0' },
          ],
        },
        taskMeta: {
          lastRunStatus: 'failed',
          lastRunAt: '2026-11-23T10:15:00Z',
          lastRunSummary: 'Workspace missing',
        },
      },
    });
    const scheduleRule = makeSavedRule({
      id: 'rule-cron',
      nextFireAt: '2026-11-24T01:00:00Z',
      spec: buildBotPulseProposalSpec({
        memberId: 'bot-1',
        botName: 'Triage Bot',
        sourceKind: 'time_cron',
        evalMode: 'auto',
        description: 'Daily standup summary',
      }),
    });
    const legacyRule = makeSavedRule({
      id: 'rule-legacy',
      enabled: false,
      spec: { ...scheduleRule.spec, name: 'Paused schedule', evalMode: 'off' },
    });
    let persistedRules = [eventRule, scheduleRule, legacyRule];

    vi.mocked(pulseApi.deckSnapshot).mockImplementation(async () => ({
      engineActive: true,
      activeTicketCount: 0,
      pendingUserInteractionCount: 0,
      sources: [],
      rules: persistedRules,
      observedCandidates: [
        {
          id: 'cand-1',
          ruleId: 'rule-event',
          ruleName: eventRule.spec.name,
          eventId: 'evt-1',
          sourceKind: 'jira',
          eventType: 'jira.issue.updated',
          summary: 'P0 outage detected',
          occurredAt: '2026-11-23T11:00:00Z',
          promoted: false,
        },
      ],
      subscriptions: [],
      pendingInteractions: [],
    }));
    vi.mocked(pulseApi.setRuleEnabled).mockImplementation(
      async (id, enabled) => {
        const updated = {
          ...persistedRules.find((rule) => rule.id === id)!,
          enabled,
        };
        persistedRules = persistedRules.map((rule) =>
          rule.id === id ? updated : rule
        );
        return updated;
      }
    );
    vi.mocked(pulseApi.setRuleMode).mockImplementationOnce(
      async (id, evalMode) => {
        const updated = {
          ...legacyRule,
          enabled: true,
          spec: { ...legacyRule.spec, evalMode },
        };
        persistedRules = persistedRules.map((rule) =>
          rule.id === id ? updated : rule
        );
        return updated;
      }
    );
    vi.mocked(pulseApi.promoteObservedCandidate).mockResolvedValue(undefined);

    render(
      <BotAutomationsPanel
        memberId="bot-1"
        botName="Triage Bot"
        workspaceId="ws-1"
      />
    );

    const eventCard = await screen.findByTestId('bot-pulse-rule-rule-event');
    const eventSwitch = within(eventCard).getByRole('switch');
    expect(eventSwitch).toBeChecked();
    expect(within(eventCard).getAllByRole('button')).toEqual([
      screen.getByTestId('bot-rule-delete-rule-event'),
    ]);
    expect(eventCard).not.toHaveTextContent(/信箱策略|会话范围|观察|自动/);
    expect(
      screen.getByTestId('bot-rule-last-run-rule-event')
    ).toHaveTextContent('Workspace missing');
    expect(
      screen.getByTestId('bot-rule-next-fire-rule-cron')
    ).toBeInTheDocument();

    await user.click(screen.getByTestId('bot-automations-new-trigger'));
    expect(
      screen.getByTestId('pulse-source-webhook_standard').className
    ).toContain('bg-primary');
    await user.click(screen.getByTestId('bot-automations-new-schedule'));
    expect(screen.getByTestId('pulse-source-time_cron').className).toContain(
      'bg-primary'
    );
    expect(screen.getByLabelText('Cron 表达式')).toBeInTheDocument();
    const tzInput = screen.getByLabelText('时区') as HTMLInputElement;
    expect(tzInput.value.trim().length).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.queryByTestId('pulse-rule-proposal-card')).toBeNull();

    await user.click(eventSwitch);
    await waitFor(() => expect(eventSwitch).not.toBeChecked());
    expect(pulseApi.setRuleEnabled).toHaveBeenCalledWith('rule-event', false);

    await user.click(eventSwitch);
    await waitFor(() => expect(eventSwitch).toBeChecked());
    expect(pulseApi.setRuleEnabled).toHaveBeenCalledWith('rule-event', true);
    expect(pulseApi.setRuleMode).not.toHaveBeenCalled();
    expect(pulseApi.saveRule).not.toHaveBeenCalled();
    const legacySwitch = within(
      screen.getByTestId('bot-pulse-rule-rule-legacy')
    ).getByRole('switch');
    expect(legacySwitch).not.toBeChecked();
    await user.click(legacySwitch);
    await waitFor(() => {
      expect(legacySwitch).toBeChecked();
      expect(pulseApi.setRuleMode).toHaveBeenCalledWith('rule-legacy', 'auto');
    });

    expect(
      screen.getByTestId('bot-observed-candidate-cand-1')
    ).toBeInTheDocument();
    await user.click(screen.getByTestId('bot-promote-candidate-cand-1'));
    await waitFor(() => {
      expect(pulseApi.promoteObservedCandidate).toHaveBeenCalledWith('cand-1');
    });
  });

  it('localizes BotAutomationsPanel copy cleanly between zh-CN and en', async () => {
    const { act } = await import('@testing-library/react');
    const i18n = (await import('@/i18n')).default;
    vi.mocked(pulseApi.deckSnapshot).mockResolvedValue({
      engineActive: true,
      activeTicketCount: 0,
      pendingUserInteractionCount: 0,
      sources: [],
      rules: [],
      observedCandidates: [],
      subscriptions: [],
      pendingInteractions: [],
    });

    try {
      await act(async () => {
        await i18n.changeLanguage('zh-CN');
      });
      render(<BotAutomationsPanel memberId="bot-1" botName="Moxi" />);
      expect(await screen.findByText('Bot 任务')).toBeInTheDocument();
      expect(
        screen.getByTestId('bot-automations-new-trigger')
      ).toHaveTextContent('事件任务');
      expect(
        screen.getByTestId('bot-automations-new-schedule')
      ).toHaveTextContent('定时任务');

      await act(async () => {
        await i18n.changeLanguage('en');
      });
      expect(screen.getByText('Bot Tasks')).toBeInTheDocument();
      expect(
        screen.getByTestId('bot-automations-new-trigger')
      ).toHaveTextContent('Event Task');
      expect(
        screen.getByTestId('bot-automations-new-schedule')
      ).toHaveTextContent('Scheduled Task');
    } finally {
      await act(async () => {
        await i18n.changeLanguage('zh-CN');
      });
    }
  });
});
