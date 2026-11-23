import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SupervisorProvisionCard } from './SupervisorProvisionCard';
import {
  extractProvisionActivity,
  formatSpaceSystemEventCopy,
  isCollaborationLimitNotice,
  isSpaceSystemNotice,
  parseSpaceSystemEvent,
  resolveMemberAgentModelDisplay,
  sidebarMemberToSpaceMember,
} from './spaceModel';
import type { SpaceTurnProvisionActivity } from './space/types';

describe('SupervisorProvisionCard', () => {
  const sampleActivity: SpaceTurnProvisionActivity = {
    bots: [
      {
        identityMemberId: 'mem-arch',
        nickname: 'Architect',
        agentId: 'claude-code',
        model: 'claude-opus-5-5',
        modelLabel: 'Opus 5.5',
        avatar: JSON.stringify({
          color: '#1584ff',
          shape: 'clover',
          expression: 'neutral',
        }),
        status: 'ready',
      },
      {
        identityMemberId: 'mem-be',
        nickname: 'Backend',
        agentId: 'codex',
        model: 'gpt-6.2-sol',
        modelLabel: 'GPT 6.2 Sol',
        avatar: { color: '#ff6b0a', shape: 'star', expression: 'neutral' },
        status: 'ready',
      },
      {
        identityMemberId: 'mem-fe',
        nickname: 'Frontend',
        agentId: 'antigravity',
        model: 'gemini-4-carbon',
        modelLabel: 'Gemini 4 Carbon',
        avatar: { color: '#ff3b7c', shape: 'capsule', expression: 'neutral' },
        status: 'ready',
      },
      {
        identityMemberId: 'mem-qa',
        nickname: 'QA Lead',
        agentId: 'claude-code',
        model: 'claude-opus-5-5',
        modelLabel: 'Opus 5.5',
        avatar: { color: '#7b8089', shape: 'triangle', expression: 'neutral' },
        status: 'ready',
      },
    ],
    groups: [
      {
        spaceId: 'space-dev-team',
        name: 'Dimo Dev Team',
        memberCount: 4,
        members: [
          {
            identityMemberId: 'mem-arch',
            nickname: 'Architect',
            color: '#1584ff',
          },
          { identityMemberId: 'mem-be', nickname: 'Backend', color: '#ff6b0a' },
          {
            identityMemberId: 'mem-fe',
            nickname: 'Frontend',
            color: '#ff3b7c',
          },
          { identityMemberId: 'mem-qa', nickname: 'QA Lead', color: '#7b8089' },
        ],
        status: 'ready',
      },
    ],
  };

  it('renders created bot cards, assembled group banner, and collapses on toggle', () => {
    const onOpenSpace = vi.fn();
    render(
      <SupervisorProvisionCard
        activity={sampleActivity}
        onOpenSpace={onOpenSpace}
      />
    );

    const card = screen.getByTestId('collaboration-provision-card');
    expect(card).toHaveAttribute('data-expanded', 'true');
    expect(
      screen.getByTestId('collaboration-provision-bot-mem-arch')
    ).toHaveTextContent('Architect');
    expect(
      screen.getByTestId('collaboration-provision-bot-mem-arch')
    ).toHaveTextContent('Opus 5.5');
    expect(
      screen.getByTestId('collaboration-provision-bot-mem-be')
    ).toHaveTextContent('GPT 6.2 Sol');
    expect(
      screen.getByTestId('collaboration-provision-bot-mem-fe')
    ).toHaveTextContent('Gemini 4 Carbon');
    expect(
      screen.getByTestId('collaboration-provision-bot-mem-qa')
    ).toHaveTextContent('QA Lead');

    const groupBanner = screen.getByTestId(
      'collaboration-provision-group-card'
    );
    expect(groupBanner).toHaveTextContent('Dimo Dev Team');
    expect(groupBanner).toHaveTextContent('4');
    fireEvent.click(groupBanner);
    expect(onOpenSpace).toHaveBeenCalledWith('space-dev-team');

    const toggle = screen.getByTestId('collaboration-provision-toggle');
    fireEvent.click(toggle);
    expect(card).toHaveAttribute('data-expanded', 'false');
    expect(
      screen.queryByTestId('collaboration-provision-bot-grid')
    ).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(card).toHaveAttribute('data-expanded', 'true');
    expect(
      screen.getByTestId('collaboration-provision-bot-grid')
    ).toBeInTheDocument();
  });

  it('renders nothing when both bots and groups are empty', () => {
    const { container } = render(
      <SupervisorProvisionCard activity={{ bots: [], groups: [] }} />
    );
    expect(container.firstChild).toBeNull();
  });
});

describe('space system event, provision activity, and agent/model helpers', () => {
  it('distinguishes spaceEvent notices from collaboration_limit notices', () => {
    const groupCreatedMsg = {
      origin: 'system',
      envelope: {
        sender: 'system',
        summary: 'space_event',
        spaceEvent: {
          kind: 'group_created' as const,
          actorName: 'Master',
          actorIsUser: false,
          groupName: 'Dimo Dev Team',
          members: ['Architect', 'Backend', 'Frontend', 'QA Lead'],
        },
      },
    };
    const parsed = parseSpaceSystemEvent(groupCreatedMsg);
    expect(parsed).toEqual({
      kind: 'group_created',
      actorName: 'Master',
      actorIsUser: false,
      groupName: 'Dimo Dev Team',
      members: ['Architect', 'Backend', 'Frontend', 'QA Lead'],
    });
    expect(isCollaborationLimitNotice(groupCreatedMsg)).toBe(false);
    expect(isSpaceSystemNotice(groupCreatedMsg)).toBe(true);
    const copy = formatSpaceSystemEventCopy(parsed!);
    expect(copy).toContain('Master');
    expect(copy).toContain('Dimo Dev Team');
    expect(copy).toContain('Architect, Backend, Frontend, QA Lead');

    const limitMsg = {
      origin: 'system',
      envelope: {
        sender: 'system',
        summary: 'collaboration_limit',
      },
    };
    expect(parseSpaceSystemEvent(limitMsg)).toBeNull();
    expect(isCollaborationLimitNotice(limitMsg)).toBe(true);
    expect(isSpaceSystemNotice(limitMsg)).toBe(true);
  });

  it('formats member_invited and member_joined system events', () => {
    const invitedByUser = parseSpaceSystemEvent({
      origin: 'system',
      envelope: {
        summary: 'space_event',
        spaceEvent: {
          kind: 'member_invited',
          actorIsUser: true,
          memberName: 'Tech Lead',
        },
      },
    });
    expect(invitedByUser).not.toBeNull();
    expect(formatSpaceSystemEventCopy(invitedByUser!)).toContain('Tech Lead');

    const joined = parseSpaceSystemEvent({
      origin: 'system',
      envelope: {
        summary: 'space_event',
        spaceEvent: {
          kind: 'member_joined',
          memberName: 'Tech Lead',
        },
      },
    });
    expect(joined).not.toBeNull();
    expect(formatSpaceSystemEventCopy(joined!)).toContain('Tech Lead');
  });

  it('extracts Rust-shaped provisionActivity and propagates sidebar member agent/model metadata', () => {
    expect(extractProvisionActivity(null)).toBeNull();
    expect(
      extractProvisionActivity({ provisionActivity: { bots: [], groups: [] } })
    ).toBeNull();
    const extracted = extractProvisionActivity({
      provisionActivity: {
        bots: [
          {
            identityMemberId: 'm1',
            nickname: 'Architect',
            agentId: 'claude-code',
            model: 'opus-5.5',
            modelLabel: 'Opus 5.5',
            status: 'ready',
          },
        ],
        groups: [
          {
            spaceId: 's1',
            name: 'Dev Team',
            memberCount: 1,
            members: [{ identityMemberId: 'm1', nickname: 'Architect' }],
            status: 'ready',
          },
        ],
      },
    });
    expect(extracted?.bots).toHaveLength(1);
    expect(extracted?.bots[0]?.nickname).toBe('Architect');
    expect(extracted?.groups).toHaveLength(1);
    expect(extracted?.groups[0]?.name).toBe('Dev Team');

    const spaceMember = sidebarMemberToSpaceMember({
      member_id: 'm1',
      name: 'Backend',
      conversation_id: 'c1',
      agent: 'codex',
      model: 'gpt-6.2-sol',
      model_label: 'GPT 6.2 Sol',
    });
    expect(spaceMember.agent).toBe('codex');
    expect(spaceMember.model).toBe('gpt-6.2-sol');
    expect(spaceMember.model_label).toBe('GPT 6.2 Sol');
    expect(resolveMemberAgentModelDisplay(spaceMember)).toEqual({
      agentId: 'codex',
      modelLabel: 'GPT 6.2 Sol',
    });
  });
});
