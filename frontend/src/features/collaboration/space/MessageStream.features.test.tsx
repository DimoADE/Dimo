import { createRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CollaborationSpaceRuntime } from './CollaborationSpaceRuntime';
import type { SpaceMessage } from './types';

const mockSelectSpace = vi.fn();

const mockMessages: SpaceMessage[] = [
  {
    id: 'evt-created',
    seq: 1,
    origin: 'system',
    envelope: {
      sender: 'system',
      summary: 'space_event',
      content:
        'Master created Dimo Dev Team with Architect, Backend, Frontend, QA Lead',
      spaceEvent: {
        kind: 'group_created',
        actorName: 'Master',
        actorIsUser: false,
        groupName: 'Dimo Dev Team',
        members: ['Architect', 'Backend', 'Frontend', 'QA Lead'],
      },
    },
  },
  {
    id: 'evt-joined',
    seq: 2,
    origin: 'system',
    envelope: {
      sender: 'system',
      summary: 'space_event',
      content: 'Tech Lead joined the group',
      spaceEvent: {
        kind: 'member_joined',
        memberName: 'Tech Lead',
      },
    },
  },
  {
    id: 'msg-lead',
    seq: 3,
    origin: 'agent',
    envelope: {
      sender: 'Tech Lead',
      conversation_id: 'conv-lead',
      content: 'On it. Splitting OAuth PKCE into 3 parallel tasks.',
    },
  },
  {
    id: 'msg-backend',
    seq: 4,
    origin: 'agent',
    envelope: {
      sender: 'Backend',
      conversation_id: 'conv-backend',
      content: 'Implemented S256 verifier derivation.',
    },
  },
  {
    id: 'msg-supervisor-card-only',
    seq: 5,
    origin: 'agent',
    envelope: {
      sender: 'Master',
      conversation_id: 'conv-master',
      content: '',
      provisionActivity: {
        bots: [
          {
            identityMemberId: 'mem-arch',
            nickname: 'Architect',
            agentId: 'claude-code',
            model: 'claude-opus-5-5',
            modelLabel: 'Opus 5.5',
            status: 'ready',
          },
          {
            identityMemberId: 'mem-be',
            nickname: 'Backend',
            agentId: 'codex',
            model: 'gpt-6.2-sol',
            modelLabel: 'GPT 6.2 Sol',
            status: 'ready',
          },
        ],
        groups: [
          {
            spaceId: 'space-dev-team',
            name: 'Dimo Dev Team',
            memberCount: 2,
            members: [
              { identityMemberId: 'mem-arch', nickname: 'Architect' },
              { identityMemberId: 'mem-be', nickname: 'Backend' },
            ],
            status: 'ready',
          },
        ],
      },
    },
  },
];

vi.mock('./CollaborationSpaceRuntime', () => ({
  useCollaborationSpaceRuntime: () =>
    ({
      activeNavIndex: null,
      filteredMessages: mockMessages,
      followThreadBottomRef: { current: true },
      getMemberAvatar: () => ({
        color: '#1584ff',
        shape: 'circle',
        expression: 'neutral',
      }),
      handleAddSelectionToCollection: vi.fn(),
      handleQuoteSelection: vi.fn(),
      handleResolveApprovalCard: vi.fn(),
      hasMoreEarlierServerMessages: false,
      ignoreThreadScrollRef: { current: false },
      isDefaultVirtualSpaceSelected: false,
      isPrivateChatActive: false,
      leadConversationIds: new Set(['conv-lead']),
      loadEarlierThreadMessages: vi.fn(),
      loadingEarlierMessages: false,
      markSpaceInReviewMembersViewed: vi.fn(),
      memberAvatars: {},
      members: [
        {
          kind: 'agent',
          member_id: 'seat-lead',
          nickname: 'Tech Lead',
          conversation_id: 'conv-lead',
          agent: 'claude-code',
          model: 'claude-opus-5-5',
          model_label: 'Opus 5.5',
        },
        {
          kind: 'agent',
          member_id: 'seat-backend',
          nickname: 'Backend',
          conversation_id: 'conv-backend',
          agent: 'codex',
          model: 'gpt-6.2-sol',
          model_label: 'GPT 6.2 Sol',
        },
        {
          kind: 'agent',
          member_id: 'seat-master',
          nickname: 'Master',
          conversation_id: 'conv-master',
          agent: 'claude-code',
          model: 'claude-opus-5-5',
          model_label: 'Opus 5.5',
          is_supervisor: true,
        },
      ],
      membersBySpace: {},
      messageClusters: [null, null, 'solo', 'solo', 'solo'],
      messageItemRefs: { current: new Map() },
      navEntries: [],
      openCreateMemberDialog: vi.fn(),
      openCreateSpaceDialog: vi.fn(),
      openMemberAvatarMenu: vi.fn(),
      openMessageBubbleMenu: vi.fn(),
      pendingApprovalCards: [],
      receiptLabels: {},
      receiptsBySeq: {},
      respondingApprovalCardId: null,
      selectMemberForPreview: vi.fn(),
      selectSpace: mockSelectSpace,
      selected: { space_id: 'space-1', name: 'Dimo Dev Team' },
      setActiveNavIndex: vi.fn(),
      setIsAtThreadBottom: vi.fn(),
      spaces: [{ space_id: 'space-1', name: 'Dimo Dev Team' }],
      t: (key: string, opts?: { defaultValue?: string }) =>
        opts?.defaultValue ?? key,
      threadCards: [],
      threadLogRef: createRef<HTMLDivElement>(),
      threadQueryId: 'space-1',
      visibleRoster: [
        {
          kind: 'agent',
          member_id: 'seat-lead',
          nickname: 'Tech Lead',
          conversation_id: 'conv-lead',
          agent: 'claude-code',
          model: 'claude-opus-5-5',
          model_label: 'Opus 5.5',
        },
        {
          kind: 'agent',
          member_id: 'seat-backend',
          nickname: 'Backend',
          conversation_id: 'conv-backend',
          agent: 'codex',
          model: 'gpt-6.2-sol',
          model_label: 'GPT 6.2 Sol',
        },
        {
          kind: 'agent',
          member_id: 'seat-master',
          nickname: 'Master',
          conversation_id: 'conv-master',
          agent: 'claude-code',
          model: 'claude-opus-5-5',
          model_label: 'Opus 5.5',
          is_supervisor: true,
        },
      ],
      workingMembers: [],
      workspace: 'ws-1',
      workspacePath: '/repo',
      scrollToMessage: vi.fn(),
      dmStatusNotice: null,
      directMessages: [],
      pendingDirectMessages: [],
      dmThreadId: null,
      dmMember: null,
    }) as unknown as CollaborationSpaceRuntime,
}));

vi.mock('./DirectMessages', () => ({
  DirectMessages: () => null,
}));

import { CollaborationSpaceProvider } from './SpaceContext';
import { MessageStream } from './MessageStream';

describe('MessageStream collaboration space enhancements', () => {
  it('renders system event pills, bot lead+agent+model header metadata, and card-only supervisor provision cards', () => {
    mockSelectSpace.mockClear();
    render(
      <CollaborationSpaceProvider workspaceId="ws-1">
        <MessageStream />
      </CollaborationSpaceProvider>
    );

    // Feature 3: Group creation & member join/invite event pills
    const createdPill = screen.getByTestId('collaboration-system-event-1');
    expect(createdPill).toHaveTextContent('Master');
    expect(createdPill).toHaveTextContent('Dimo Dev Team');
    expect(createdPill).toHaveTextContent(
      'Architect, Backend, Frontend, QA Lead'
    );

    const joinedPill = screen.getByTestId('collaboration-system-event-2');
    expect(joinedPill).toHaveTextContent('Tech Lead');

    // Feature 2: Lead badge + Agent icon & Model name next to Bot name
    expect(
      screen.getByTestId('collaboration-message-lead-3')
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('collaboration-message-agent-meta-3')
    ).toHaveTextContent('Opus 5.5');
    expect(
      screen.queryByTestId('collaboration-message-lead-4')
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId('collaboration-message-agent-meta-4')
    ).toHaveTextContent('GPT 6.2 Sol');

    // Feature 1: Supervisor provision card inside card-only assistant message bubble
    const provisionCard = screen.getByTestId('collaboration-provision-card');
    expect(provisionCard).toBeInTheDocument();
    expect(
      screen.getByTestId('collaboration-provision-bot-mem-arch')
    ).toHaveTextContent('Opus 5.5');
    expect(
      screen.getByTestId('collaboration-provision-bot-mem-be')
    ).toHaveTextContent('GPT 6.2 Sol');

    fireEvent.click(screen.getByTestId('collaboration-provision-group-card'));
    expect(mockSelectSpace).toHaveBeenCalledWith('space-dev-team');
  });
});
