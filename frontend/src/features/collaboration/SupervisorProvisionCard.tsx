import { memo, useMemo, useState } from 'react';
import { Brain, Check, ChevronDown, ChevronUp } from 'lucide-react';
import { AgentIcon, getAgentName } from '@/components/agents/AgentIcon';
import i18n from '@/i18n';
import { GroupAvatar } from './GroupAvatar';
import {
  BOT_AVATAR_EXPRESSION_PRESETS,
  BOT_AVATAR_SHAPE_PRESETS,
  MemberBotAvatar,
  deriveMemberBotAvatar,
  normalizeHexColor,
  type BotAvatarExpression,
  type BotAvatarShape,
  type MemberBotAvatarConfig,
} from './MemberBotAvatar';
import type { SpaceTurnProvisionActivity } from './space/types';

const VALID_SHAPES = new Set<string>(
  BOT_AVATAR_SHAPE_PRESETS.map((preset) => preset.id)
);
const VALID_EXPRESSIONS = new Set<string>(
  BOT_AVATAR_EXPRESSION_PRESETS.map((preset) => preset.id)
);

function parseAvatarInput(rawAvatar: unknown): Record<string, unknown> | null {
  if (!rawAvatar) return null;
  if (typeof rawAvatar === 'string') {
    const trimmed = rawAvatar.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('{')) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        return null;
      }
    }
    if (VALID_SHAPES.has(trimmed)) {
      return { shape: trimmed };
    }
    return null;
  }
  if (typeof rawAvatar === 'object' && !Array.isArray(rawAvatar)) {
    return rawAvatar as Record<string, unknown>;
  }
  return null;
}

function resolveProvisionAvatar(
  rawAvatar: unknown,
  rawColor: string | null | undefined,
  seed: string,
  lookupAvatar?: (
    conversationId?: string,
    nickname?: string
  ) => MemberBotAvatarConfig
): MemberBotAvatarConfig {
  const fallback = lookupAvatar
    ? lookupAvatar(undefined, seed)
    : deriveMemberBotAvatar(seed);
  const rec = parseAvatarInput(rawAvatar);
  if (rec) {
    const shapeRaw = String(rec.shape ?? '').trim();
    const exprRaw = String(rec.expression ?? '').trim();
    const colorRaw = String(rec.color ?? rawColor ?? '').trim();
    return {
      color: colorRaw
        ? normalizeHexColor(colorRaw, fallback.color)
        : fallback.color,
      shape: VALID_SHAPES.has(shapeRaw)
        ? (shapeRaw as BotAvatarShape)
        : fallback.shape,
      expression: VALID_EXPRESSIONS.has(exprRaw)
        ? (exprRaw as BotAvatarExpression)
        : fallback.expression,
    };
  }
  if (rawColor && rawColor.trim()) {
    return {
      ...fallback,
      color: normalizeHexColor(rawColor.trim(), fallback.color),
    };
  }
  return fallback;
}

function resolveProvisionHeaderCopy(
  botCount: number,
  groupCount: number
): string {
  if (botCount > 0 && groupCount > 0) {
    return botCount === 1
      ? i18n.t('panels:collabCopy.provisionThoughtBotsAndGroupOne')
      : i18n.t('panels:collabCopy.provisionThoughtBotsAndGroup', {
          count: botCount,
        });
  }
  if (botCount > 0) {
    return botCount === 1
      ? i18n.t('panels:collabCopy.provisionThoughtBotsOne')
      : i18n.t('panels:collabCopy.provisionThoughtBots', { count: botCount });
  }
  return i18n.t('panels:collabCopy.provisionThoughtGroup');
}

export const SupervisorProvisionCard = memo(function SupervisorProvisionCard({
  activity,
  getMemberAvatar,
  onOpenSpace,
}: {
  activity: SpaceTurnProvisionActivity;
  getMemberAvatar?: (
    conversationId?: string,
    nickname?: string
  ) => MemberBotAvatarConfig;
  onOpenSpace?: (spaceId: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const { bots, groups } = activity;

  const headerCopy = resolveProvisionHeaderCopy(bots.length, groups.length);

  const botRows = useMemo(
    () =>
      bots.map((bot) => {
        const key = bot.identityMemberId || bot.conversationId || bot.nickname;
        const avatar = resolveProvisionAvatar(
          bot.avatar,
          bot.color,
          bot.nickname || key,
          getMemberAvatar
        );
        const modelText =
          (bot.modelLabel ?? bot.model ?? '').trim() ||
          (bot.agentId ? getAgentName(bot.agentId) : '');
        return { key, bot, avatar, modelText };
      }),
    [bots, getMemberAvatar]
  );

  const groupRows = useMemo(
    () =>
      groups.map((group) => {
        const source =
          group.members.length > 0
            ? group.members
            : bots.map((bot) => ({
                nickname: bot.nickname,
                identityMemberId: bot.identityMemberId,
                avatar: bot.avatar,
                color: bot.color,
              }));
        const avatars = source.map((member) =>
          resolveProvisionAvatar(
            member.avatar,
            member.color,
            member.nickname || member.identityMemberId || 'bot',
            getMemberAvatar
          )
        );
        const count = Math.max(group.memberCount, group.members.length);
        const botsReadyCopy =
          count === 1
            ? i18n.t('panels:collabCopy.provisionBotsReadyOne')
            : i18n.t('panels:collabCopy.provisionBotsReady', { count });
        return { group, avatars, count, botsReadyCopy };
      }),
    [bots, getMemberAvatar, groups]
  );

  if (bots.length === 0 && groups.length === 0) {
    return null;
  }

  return (
    <div
      className="collaboration-provision-card"
      data-testid="collaboration-provision-card"
      data-expanded={expanded ? 'true' : 'false'}
    >
      <button
        type="button"
        className="collaboration-provision-header"
        data-testid="collaboration-provision-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((prev) => !prev)}
      >
        <Brain
          className="collaboration-provision-header-icon h-4 w-4 shrink-0"
          aria-hidden="true"
        />
        <span className="collaboration-provision-header-label">
          {headerCopy}
        </span>
        {expanded ? (
          <ChevronDown
            className="collaboration-provision-chevron h-3.5 w-3.5 shrink-0"
            aria-hidden="true"
          />
        ) : (
          <ChevronUp
            className="collaboration-provision-chevron h-3.5 w-3.5 shrink-0"
            aria-hidden="true"
          />
        )}
      </button>

      {expanded ? (
        <div className="collaboration-provision-body">
          {botRows.length > 0 ? (
            <div
              className="collaboration-provision-bot-grid"
              data-testid="collaboration-provision-bot-grid"
            >
              {botRows.map(({ key, bot, avatar, modelText }) => (
                <div
                  key={key}
                  className="collaboration-provision-bot-card"
                  data-testid={`collaboration-provision-bot-${key}`}
                >
                  <div className="collaboration-provision-bot-identity">
                    <MemberBotAvatar
                      config={avatar}
                      animated={false}
                      sessionActive={false}
                      className="h-6 w-6 shrink-0"
                    />
                    <span className="collaboration-provision-bot-name">
                      {bot.nickname}
                    </span>
                  </div>
                  <div className="collaboration-provision-bot-meta">
                    {bot.agentId ? (
                      <AgentIcon
                        agent={bot.agentId}
                        className="collaboration-provision-agent-icon h-3.5 w-3.5 shrink-0"
                      />
                    ) : null}
                    {modelText ? (
                      <span className="collaboration-provision-bot-model">
                        {modelText}
                      </span>
                    ) : null}
                    <Check
                      className="collaboration-provision-check h-3.5 w-3.5 shrink-0"
                      aria-hidden="true"
                    />
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          {groupRows.map(({ group, avatars, count, botsReadyCopy }) => {
            const canOpenGroup = Boolean(onOpenSpace && group.spaceId);
            const content = (
              <>
                <span className="collaboration-provision-group-main">
                  {avatars.length > 0 ? (
                    <span className="collaboration-provision-group-avatar-wrap">
                      <GroupAvatar
                        avatars={avatars}
                        size={28}
                        data-testid="collaboration-provision-group-avatar"
                      />
                    </span>
                  ) : null}
                  <span className="collaboration-provision-group-copy">
                    <span className="collaboration-provision-group-prefix">
                      {i18n.t('panels:collabCopy.provisionAssembledGroup')}
                    </span>
                    <strong className="collaboration-provision-group-name">
                      {group.name}
                    </strong>
                    {count > 0 ? (
                      <span className="collaboration-provision-group-count">
                        {botsReadyCopy}
                      </span>
                    ) : null}
                  </span>
                </span>
                <Check
                  className="collaboration-provision-check h-4 w-4 shrink-0"
                  aria-hidden="true"
                />
              </>
            );
            const rowKey = group.spaceId || group.name;
            return canOpenGroup ? (
              <button
                key={rowKey}
                type="button"
                className="collaboration-provision-group-card is-clickable"
                data-testid="collaboration-provision-group-card"
                onClick={() => onOpenSpace?.(group.spaceId)}
              >
                {content}
              </button>
            ) : (
              <div
                key={rowKey}
                className="collaboration-provision-group-card"
                data-testid="collaboration-provision-group-card"
              >
                {content}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
});
