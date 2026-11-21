import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ConversationPermissionView,
  ConversationQuestionRequest,
  ConversationRowOpBatch,
  DbConversationDetail,
  TimelineRow,
} from 'shared/types';
import { ConversationStatusDock } from '@/components/tasks/follow-up/ConversationStatusDock';
import { PermissionRequestCard } from '@/components/NormalizedConversation/conversation/PermissionRequestCard';
import { AgentQuestionCard } from '@/components/tasks/follow-up/AgentQuestionCard';
import type { MemberBotAvatarConfig } from '../MemberBotAvatar';
import type { SpaceMember } from '../spaceModel';
import {
  useSpaceMemberNotices,
  type UseSpaceMemberNoticesInput,
} from './useSpaceMemberNotices';

const mockDetail = vi.hoisted(() => vi.fn());
const mockEnsureSessionControls = vi.hoisted(() =>
  vi.fn(async () => undefined)
);
const mockRebindSession = vi.hoisted(() => vi.fn(async () => undefined));
const mockRespondPermission = vi.hoisted(() => vi.fn(async () => undefined));
const mockRespondQuestion = vi.hoisted(() => vi.fn(async () => undefined));
const listenHandlers = vi.hoisted(
  () => new Set<(batch: ConversationRowOpBatch) => void>()
);
const mockListenToConversationEvents = vi.hoisted(() =>
  vi.fn(async (handler: (batch: ConversationRowOpBatch) => void) => {
    listenHandlers.add(handler);
    return () => {
      listenHandlers.delete(handler);
    };
  })
);

vi.mock('@/features/conversation/conversationApi', () => ({
  conversationApi: {
    detail: mockDetail,
    ensureSessionControls: mockEnsureSessionControls,
    rebindSession: mockRebindSession,
    respondPermission: mockRespondPermission,
    respondQuestion: mockRespondQuestion,
  },
}));

vi.mock('@/features/conversation/events', () => ({
  listenToConversationEvents: mockListenToConversationEvents,
}));

function emitConversationBatch(batch: ConversationRowOpBatch) {
  act(() => {
    for (const handler of listenHandlers) {
      handler(batch);
    }
  });
}

function makeMember(
  conversationId: string,
  nickname: string,
  memberId = `member-${conversationId}`
): SpaceMember {
  return {
    member_id: memberId,
    conversation_id: conversationId,
    nickname,
    kind: 'agent',
  } as SpaceMember;
}

function makeAvatar(): MemberBotAvatarConfig {
  return {
    color: '#6366f1',
    shape: 'circle',
    expression: 'neutral',
  };
}

function makeTurnErrorRow(
  rowId: string,
  revision: bigint,
  message: string,
  code = '403'
): TimelineRow {
  return {
    row_id: rowId,
    revision,
    row: {
      kind: 'turn_error',
      error: {
        turn_id: `turn-${rowId}`,
        error: {
          message,
          code,
          raw: message,
          kind: 'auth_required',
        },
      },
    },
  };
}

function makeAssistantMessageRow(
  rowId: string,
  revision: bigint,
  phase = 'settled'
): TimelineRow {
  return {
    row_id: rowId,
    revision,
    row: {
      kind: 'message_turn',
      phase,
      turn: {
        id: rowId,
        role: 'assistant',
        created_at: '2026-11-19T10:00:00Z',
        blocks: [{ type: 'text', text: 'Done!' }],
      },
    },
  } as unknown as TimelineRow;
}

function makePermissionRow(
  permissionId: string,
  revision: bigint,
  title: string
): TimelineRow {
  const request: ConversationPermissionView = {
    permission_id: permissionId,
    title,
    status: 'pending',
    details: { fields: { kind: 'edit' } },
    options: [
      { id: 'allow', label: 'Allow', kind: 'allow_once' },
      { id: 'deny', label: 'Deny', kind: 'reject_once' },
    ],
  };
  return {
    row_id: `permission:${permissionId}`,
    revision,
    row: {
      kind: 'permission_request',
      request,
    },
  };
}

function makeQuestionRow(
  questionId: string,
  revision: bigint,
  prompt: string
): TimelineRow {
  const request: ConversationQuestionRequest = {
    question_id: questionId,
    prompt,
    options: ['Option A', 'Option B'],
  };
  return {
    row_id: `question:${questionId}`,
    revision,
    row: {
      kind: 'question_request',
      request,
      response: null,
    },
  };
}

function makeDetail(rows: TimelineRow[]): DbConversationDetail {
  return {
    timeline: { rows },
  } as unknown as DbConversationDetail;
}

function Harness(props: Omit<UseSpaceMemberNoticesInput, 'getMemberAvatar'>) {
  const {
    priorityNotices,
    tabNotices,
    pendingPermissions,
    pendingQuestions,
    dismissQuestion,
  } = useSpaceMemberNotices({
    ...props,
    getMemberAvatar: () => makeAvatar(),
  });

  return (
    <div>
      <ConversationStatusDock
        dismissalScope={props.spaceId}
        notices={priorityNotices}
        maxVisibleCount={2}
      />
      <div data-testid="tab-notice-count">{tabNotices.length}</div>
      <div data-testid="tab-notices">
        {tabNotices.map((item) => (
          <div key={item.id} data-testid={`tab-notice-${item.id}`}>
            {item.actor?.name}:{item.kind === 'session-notice' ? item.notice.title : ''}
          </div>
        ))}
      </div>
      <div data-testid="overlay-area">
        {pendingPermissions.map((permission) => (
          <PermissionRequestCard
            key={`${permission.conversationId}:${permission.request.permission_id}`}
            request={permission.request}
            actor={permission.actor}
            responding={permission.responding}
            onRespond={permission.onRespond}
          />
        ))}
        {pendingQuestions.map((question) => (
          <AgentQuestionCard
            key={question.dismissKey}
            request={question.request}
            actor={question.actor}
            responding={question.responding}
            onRespond={question.onRespond}
            onDismiss={() => dismissQuestion(question.dismissKey)}
          />
        ))}
      </div>
    </div>
  );
}

describe('useSpaceMemberNotices', () => {
  beforeEach(() => {
    listenHandlers.clear();
    mockDetail.mockReset();
    mockDetail.mockResolvedValue(makeDetail([]));
    mockEnsureSessionControls.mockReset();
    mockEnsureSessionControls.mockResolvedValue(undefined);
    mockRebindSession.mockReset();
    mockRebindSession.mockResolvedValue(undefined);
    mockRespondPermission.mockReset();
    mockRespondPermission.mockResolvedValue(undefined);
    mockRespondQuestion.mockReset();
    mockRespondQuestion.mockResolvedValue(undefined);
    mockListenToConversationEvents.mockClear();
  });

  it('passively hydrates a member 403 turn_error in GroupSpace with bot identity and session navigation without waking ACP', async () => {
    const memberA = makeMember('conv-a', 'Architect');
    const memberB = makeMember('conv-b', 'Reviewer');
    const onOpenMemberSession = vi.fn();

    mockDetail.mockImplementation(async (convId: string) => {
      if (convId === 'conv-a') {
        return makeDetail([
          makeTurnErrorRow('err-a', 10n, 'HTTP 403 Forbidden: invalid key'),
        ]);
      }
      return makeDetail([]);
    });

    render(
      <Harness
        spaceId="space-group-1"
        members={[memberA, memberB]}
        onOpenMemberSession={onOpenMemberSession}
      />
    );

    const chip = await screen.findByTestId('status-notice-actor-conv-a');
    expect(chip).toHaveTextContent('Architect');
    expect(mockEnsureSessionControls).not.toHaveBeenCalled();

    fireEvent.click(chip);
    expect(onOpenMemberSession).toHaveBeenCalledWith(memberA);
  });

  it('shows bot identity chip in BotSpace (1:1 DM) for both loading status and turn errors', async () => {
    const bot = makeMember('conv-dm', 'SoloBot');
    const onOpenMemberSession = vi.fn();

    render(
      <Harness
        spaceId="space-dm-1"
        members={[bot]}
        isPrivateChatActive
        activeBotConversationId="conv-dm"
        activeBotSideRows={[
          makeTurnErrorRow('err-dm', 12n, 'HTTP 403 Forbidden'),
        ]}
        activeBotTimelineTurns={[]}
        isBotSessionLoading
        onOpenMemberSession={onOpenMemberSession}
      />
    );

    const chips = await screen.findAllByTestId('status-notice-actor-conv-dm');
    expect(chips.length).toBe(2);
    expect(chips[0]).toHaveTextContent('SoloBot');
    expect(chips[1]).toHaveTextContent('SoloBot');
    expect(screen.getByText('正在加载Bot会话...')).toBeInTheDocument();
  });

  it('streams live 403 errors, sorts newest-first with maxVisibleCount=2 overflow, and auto-clears after a later settled assistant turn', async () => {
    const botA = makeMember('conv-1', 'Alpha');
    const botB = makeMember('conv-2', 'Beta');
    const botC = makeMember('conv-3', 'Gamma');

    render(<Harness spaceId="space-multi" members={[botA, botB, botC]} />);

    await waitFor(() =>
      expect(mockListenToConversationEvents).toHaveBeenCalledTimes(1)
    );

    emitConversationBatch({
      conversation_id: 'conv-1',
      last_sequence: 10n,
      ops: [{ op: 'upsert', row: makeTurnErrorRow('err-1', 10n, '403 Alpha') }],
    });
    emitConversationBatch({
      conversation_id: 'conv-2',
      last_sequence: 20n,
      ops: [{ op: 'upsert', row: makeTurnErrorRow('err-2', 20n, '403 Beta') }],
    });
    emitConversationBatch({
      conversation_id: 'conv-3',
      last_sequence: 30n,
      ops: [{ op: 'upsert', row: makeTurnErrorRow('err-3', 30n, '403 Gamma') }],
    });

    // Latest 2 (Gamma rev 30, Beta rev 20) visible; Alpha (rev 10) collapsed.
    await waitFor(() => {
      const chips = screen.getAllByTestId(/^status-notice-actor-/);
      expect(chips.map((el) => el.textContent)).toEqual(['Gamma', 'Beta']);
    });
    expect(
      screen.getByTestId('conversation-status-overflow-toggle')
    ).toBeInTheDocument();

    // Gamma finishes a newer assistant turn -> Gamma's stale 403 clears, leaving Beta & Alpha visible with no overflow!
    emitConversationBatch({
      conversation_id: 'conv-3',
      last_sequence: 35n,
      ops: [
        {
          op: 'upsert',
          row: makeAssistantMessageRow('turn-gamma-ok', 35n, 'settled'),
        },
      ],
    });

    await waitFor(() => {
      const chips = screen.getAllByTestId(/^status-notice-actor-/);
      expect(chips.map((el) => el.textContent)).toEqual(['Beta', 'Alpha']);
    });
    expect(
      screen.queryByTestId('conversation-status-overflow-toggle')
    ).not.toBeInTheDocument();
  });

  it('aggregates member pending permissions (respecting excludePermissionIds) and questions with bot identity and routes non-blocking notices to tabs', async () => {
    const botA = makeMember('conv-perm', 'OpsBot');
    const botB = makeMember('conv-ask', 'DesignBot');

    mockDetail.mockImplementation(async (convId: string) => {
      if (convId === 'conv-perm') {
        return makeDetail([
          makePermissionRow('perm-1', 5n, 'Edit deploy.yml'),
          makePermissionRow('perm-excluded', 6n, 'Excluded Approval Card'),
          {
            row_id: 'host-note:persona',
            revision: 7n,
            row: {
              kind: 'session_notice',
              notice: {
                severity: 'info',
                title: 'Standing Persona',
                message: 'Should stay on timeline',
              },
            },
          },
          {
            row_id: 'notice-info-1',
            revision: 8n,
            row: {
              kind: 'session_notice',
              notice: {
                severity: 'info',
                title: 'Context compacted',
                message: null,
              },
            },
          },
        ]);
      }
      if (convId === 'conv-ask') {
        return makeDetail([
          makeQuestionRow('q-1', 9n, 'Which layout should we pick?'),
        ]);
      }
      return makeDetail([]);
    });

    render(
      <Harness
        spaceId="space-overlay"
        members={[botA, botB]}
        excludePermissionIds={new Set(['perm-excluded'])}
      />
    );

    expect(await screen.findByText('Edit deploy.yml')).toBeInTheDocument();
    expect(screen.queryByText('Excluded Approval Card')).not.toBeInTheDocument();
    expect(
      screen.getByText('Which layout should we pick?')
    ).toBeInTheDocument();

    // Non-blocking notice routed to tabNotices (durable persona note excluded).
    expect(screen.getByTestId('tab-notice-count')).toHaveTextContent('1');
    expect(
      screen.getByTestId('tab-notice-conv-perm:notice-info-1')
    ).toHaveTextContent('OpsBot:Context compacted');

    // Responding to permission forwards conversationId + permissionId + response.
    fireEvent.click(screen.getByRole('button', { name: '允许' }));
    await waitFor(() =>
      expect(mockRespondPermission).toHaveBeenCalledWith({
        conversationId: 'conv-perm',
        permissionId: 'perm-1',
        response: expect.objectContaining({
          kind: 'selected',
          option_id: 'allow',
        }),
      })
    );
  });
});
