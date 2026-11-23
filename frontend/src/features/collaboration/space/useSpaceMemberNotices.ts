import {
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AgentElicitationResponse,
  AgentPermissionResponse,
  ConversationRowOpBatch,
  TimelineRow,
} from 'shared/types';
import { splitConversationStatusNotices } from '@/components/tasks/follow-up/ComposerTabDock';
import type {
  ConversationStatusNotice,
  PendingConversationPermission,
  PendingConversationQuestion,
  StatusNoticeActor,
} from '@/contexts/ConversationStatusContext';
import { conversationApi } from '@/features/conversation/conversationApi';
import {
  isDurableHostNote,
  type ConversationTimelineTurn,
} from '@/features/conversation/conversationStore';
import { listenToConversationEvents } from '@/features/conversation/events';
import {
  isConnectionSupersededByTurnError,
  parseReconnectProgressTitle,
} from '@/features/conversation/inlineRuntimeStatus';
import { conversationRuntimeStatus } from '@/features/conversation/runtimeStatus';
import {
  AGENT_BINDING_LOAD_FAILURE_NOTICE_ROW_ID,
  AGENT_CONNECTION_RECOVERING_NOTICE_ROW_ID,
  AGENT_SESSION_CONNECT_ERROR_NOTICE_ROW_ID,
  AUTO_PERMISSION_NOTICE_ROW_ID,
  isResendColdStartNotice,
  sessionNoticeNeedsRebind,
} from '@/features/conversation/sessionNoticeNeedsRebind';
import {
  MemberBotAvatar,
  type MemberBotAvatarConfig,
} from '../MemberBotAvatar';
import { displayName, type SpaceMember } from '../spaceModel';

export interface SpacePendingQuestionItem extends PendingConversationQuestion {
  conversationId: string;
  dismissKey: string;
}

export interface SpacePendingPermissionItem
  extends PendingConversationPermission {
  conversationId: string;
}

export interface UseSpaceMemberNoticesInput {
  spaceId: string | null;
  members: readonly SpaceMember[];
  isPrivateChatActive?: boolean;
  activeBotConversationId?: string | null;
  activeBotTimelineTurns?: readonly ConversationTimelineTurn[] | null;
  activeBotSideRows?: readonly TimelineRow[] | null;
  isBotSessionLoading?: boolean;
  getMemberAvatar: (
    conversationId?: string,
    nickname?: string,
    identityMemberId?: string | null
  ) => MemberBotAvatarConfig;
  onOpenMemberSession?: (member: SpaceMember) => void;
  excludePermissionIds?: ReadonlySet<string>;
}

export interface UseSpaceMemberNoticesResult {
  priorityNotices: ConversationStatusNotice[];
  tabNotices: ConversationStatusNotice[];
  pendingPermissions: SpacePendingPermissionItem[];
  pendingQuestions: SpacePendingQuestionItem[];
  dismissQuestion: (dismissKey: string) => void;
}

type MemberConversationSnapshot = {
  rowsById: Map<string, TimelineRow>;
  latestSettledAssistantRevision: bigint;
};

type RankedStatusNotice = {
  sortRevision: bigint;
  notice: ConversationStatusNotice;
};

function toBigIntRevision(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return BigInt(Math.trunc(value));
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    try {
      return BigInt(value.trim());
    } catch {
      return 0n;
    }
  }
  return 0n;
}

function isSettledAssistantPhase(phase: string | undefined): boolean {
  return phase === 'settled' || phase === 'persisted';
}

function mergeRowsIntoSnapshot(
  base: MemberConversationSnapshot | undefined,
  rows: readonly TimelineRow[]
): MemberConversationSnapshot {
  const rowsById = new Map<string, TimelineRow>(base?.rowsById ?? []);
  let latestSettledAssistantRevision =
    base?.latestSettledAssistantRevision ?? 0n;

  for (const row of rows) {
    const rev = toBigIntRevision(row.revision);
    if (row.row.kind === 'message_turn') {
      if (
        row.row.turn.role === 'assistant' &&
        isSettledAssistantPhase(row.row.phase) &&
        rev > latestSettledAssistantRevision
      ) {
        latestSettledAssistantRevision = rev;
      }
      continue;
    }
    const existing = rowsById.get(row.row_id);
    if (!existing || rev >= toBigIntRevision(existing.revision)) {
      rowsById.set(row.row_id, row);
    }
  }

  return {
    rowsById,
    latestSettledAssistantRevision,
  };
}

function snapshotFromActiveTimeline(
  sideRows: readonly TimelineRow[],
  timelineTurns: readonly ConversationTimelineTurn[]
): MemberConversationSnapshot {
  const rowsById = new Map<string, TimelineRow>();
  for (const row of sideRows) {
    if (row.row.kind === 'message_turn') continue;
    const rev = toBigIntRevision(row.revision);
    const existing = rowsById.get(row.row_id);
    if (!existing || rev >= toBigIntRevision(existing.revision)) {
      rowsById.set(row.row_id, row);
    }
  }
  let latestSettledAssistantRevision = 0n;
  for (const turn of timelineTurns) {
    if (turn.turn.role === 'assistant' && isSettledAssistantPhase(turn.phase)) {
      const rev = toBigIntRevision(turn.revision);
      if (rev > latestSettledAssistantRevision) {
        latestSettledAssistantRevision = rev;
      }
    }
  }
  return {
    rowsById,
    latestSettledAssistantRevision,
  };
}

function applyBatchToSnapshot(
  current: MemberConversationSnapshot | undefined,
  batch: ConversationRowOpBatch
): MemberConversationSnapshot | undefined {
  let changed = Boolean(batch.reset);
  let rowsById: Map<string, TimelineRow> | null = batch.reset
    ? new Map<string, TimelineRow>()
    : null;
  let latestSettledAssistantRevision = batch.reset
    ? 0n
    : (current?.latestSettledAssistantRevision ?? 0n);

  const ensureRows = () => {
    if (!rowsById) {
      rowsById = new Map<string, TimelineRow>(current?.rowsById ?? []);
    }
    return rowsById;
  };

  for (const op of batch.ops ?? []) {
    if (op.op === 'upsert') {
      const row = op.row;
      const rev = toBigIntRevision(row.revision);
      if (row.row.kind === 'message_turn') {
        if (
          row.row.turn.role === 'assistant' &&
          isSettledAssistantPhase(row.row.phase) &&
          rev > latestSettledAssistantRevision
        ) {
          latestSettledAssistantRevision = rev;
          changed = true;
        }
        continue;
      }
      const existing = (rowsById ?? current?.rowsById)?.get(row.row_id);
      if (!existing || rev >= toBigIntRevision(existing.revision)) {
        ensureRows().set(row.row_id, row);
        changed = true;
      }
    } else if (op.op === 'delete') {
      const existing = (rowsById ?? current?.rowsById)?.get(op.row_id);
      if (
        existing &&
        toBigIntRevision(op.revision) >= toBigIntRevision(existing.revision)
      ) {
        ensureRows().delete(op.row_id);
        changed = true;
      }
    }
  }

  if (!changed) return current;
  return {
    rowsById: rowsById ?? new Map<string, TimelineRow>(current?.rowsById ?? []),
    latestSettledAssistantRevision,
  };
}

function compareBigIntAsc(a: bigint, b: bigint): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function compareBigIntDesc(a: bigint, b: bigint): number {
  if (a > b) return -1;
  if (a < b) return 1;
  return 0;
}

export function useSpaceMemberNotices({
  spaceId,
  members,
  isPrivateChatActive = false,
  activeBotConversationId = null,
  activeBotTimelineTurns = null,
  activeBotSideRows = null,
  isBotSessionLoading = false,
  getMemberAvatar,
  onOpenMemberSession,
  excludePermissionIds,
}: UseSpaceMemberNoticesInput): UseSpaceMemberNoticesResult {
  const { t } = useTranslation('conversation');
  const [snapshotsByConvId, setSnapshotsByConvId] = useState<
    Record<string, MemberConversationSnapshot>
  >({});
  const [respondingPermissionKey, setRespondingPermissionKey] = useState<
    string | null
  >(null);
  const [respondingQuestionKey, setRespondingQuestionKey] = useState<
    string | null
  >(null);
  const [dismissedQuestionKeys, setDismissedQuestionKeys] = useState<
    Set<string>
  >(() => new Set());

  const hydratedConvIdsRef = useRef<Set<string>>(new Set());
  const inFlightHydrationsRef = useRef<Set<string>>(new Set());

  const memberTargets = useMemo(() => {
    const targets: Array<{ conversationId: string; member: SpaceMember }> = [];
    const seen = new Set<string>();
    for (const member of members) {
      const convId = member.conversation_id?.trim() ?? '';
      if (!convId || seen.has(convId)) continue;
      seen.add(convId);
      targets.push({ conversationId: convId, member });
    }
    const activeBotConvId = activeBotConversationId?.trim() ?? '';
    if (
      isPrivateChatActive &&
      activeBotConvId &&
      !seen.has(activeBotConvId) &&
      members[0]
    ) {
      targets.unshift({
        conversationId: activeBotConvId,
        member: {
          ...members[0],
          conversation_id: activeBotConvId,
        },
      });
    }
    return targets;
  }, [activeBotConversationId, isPrivateChatActive, members]);

  const trackedConvIdsRef = useRef<Set<string>>(new Set());
  trackedConvIdsRef.current = new Set(
    memberTargets.map((target) => target.conversationId)
  );

  const memberConvIdsKey = useMemo(
    () =>
      memberTargets
        .map((target) => target.conversationId)
        .sort()
        .join('\0'),
    [memberTargets]
  );

  const hasActiveBotTimelineData = Boolean(
    activeBotConversationId &&
      ((activeBotSideRows && activeBotSideRows.length > 0) ||
        (activeBotTimelineTurns && activeBotTimelineTurns.length > 0))
  );

  const hydrateConversation = useCallback(
    (conversationId: string, force = false) => {
      if (!conversationId) return;
      if (!force && hydratedConvIdsRef.current.has(conversationId)) return;
      if (inFlightHydrationsRef.current.has(conversationId)) return;
      inFlightHydrationsRef.current.add(conversationId);
      void conversationApi
        .detail(conversationId)
        .then((detail) => {
          hydratedConvIdsRef.current.add(conversationId);
          const rows = detail?.timeline?.rows ?? [];
          if (rows.length === 0 && !force) return;
          setSnapshotsByConvId((prev) => ({
            ...prev,
            [conversationId]: mergeRowsIntoSnapshot(
              force ? undefined : prev[conversationId],
              rows
            ),
          }));
        })
        .catch(() => {
          // Best-effort passive hydration; live global events still stream in.
        })
        .finally(() => {
          inFlightHydrationsRef.current.delete(conversationId);
        });
    },
    []
  );

  useEffect(() => {
    if (!memberConvIdsKey) return;
    const convIds = memberConvIdsKey.split('\0').filter(Boolean);
    for (const convId of convIds) {
      if (
        hasActiveBotTimelineData &&
        activeBotConversationId &&
        convId === activeBotConversationId
      ) {
        continue;
      }
      hydrateConversation(convId);
    }
  }, [
    activeBotConversationId,
    hasActiveBotTimelineData,
    hydrateConversation,
    memberConvIdsKey,
  ]);

  useEffect(() => {
    if (!memberConvIdsKey) return undefined;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listenToConversationEvents((batch) => {
      const convId = batch?.conversation_id?.trim();
      if (!convId || !trackedConvIdsRef.current.has(convId)) return;
      if (batch.reset) {
        setSnapshotsByConvId((prev) => ({
          ...prev,
          [convId]: {
            rowsById: new Map<string, TimelineRow>(),
            latestSettledAssistantRevision: 0n,
          },
        }));
        hydrateConversation(convId, true);
        return;
      }
      setSnapshotsByConvId((prev) => {
        const current = prev[convId];
        const next = applyBatchToSnapshot(current, batch);
        if (next === current || !next) return prev;
        return {
          ...prev,
          [convId]: next,
        };
      });
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [hydrateConversation, memberConvIdsKey]);

  const activeBotSnapshot = useMemo(() => {
    if (!activeBotConversationId || !hasActiveBotTimelineData) return null;
    return snapshotFromActiveTimeline(
      activeBotSideRows ?? [],
      activeBotTimelineTurns ?? []
    );
  }, [
    activeBotConversationId,
    activeBotSideRows,
    activeBotTimelineTurns,
    hasActiveBotTimelineData,
  ]);

  const handleReloadMember = useCallback((conversationId: string) => {
    void conversationApi
      .ensureSessionControls(conversationId, { reload: true })
      .catch(() => undefined);
  }, []);

  const handleRebindMember = useCallback((conversationId: string) => {
    void conversationApi.rebindSession(conversationId).catch(() => undefined);
  }, []);

  const handleRespondPermission = useCallback(
    (
      conversationId: string,
      permissionId: string,
      response: AgentPermissionResponse
    ) => {
      const key = `${conversationId}:${permissionId}`;
      setRespondingPermissionKey(key);
      void conversationApi
        .respondPermission({
          conversationId,
          permissionId,
          response,
        })
        .catch(() => undefined)
        .finally(() => {
          setRespondingPermissionKey((current) =>
            current === key ? null : current
          );
        });
    },
    []
  );

  const handleRespondQuestion = useCallback(
    (
      conversationId: string,
      questionId: string,
      response: AgentElicitationResponse
    ) => {
      const key = `${conversationId}:${questionId}`;
      setRespondingQuestionKey(key);
      return conversationApi
        .respondQuestion({
          conversationId,
          questionId,
          response,
        })
        .finally(() => {
          setRespondingQuestionKey((current) =>
            current === key ? null : current
          );
        });
    },
    []
  );

  const dismissQuestion = useCallback((dismissKey: string) => {
    setDismissedQuestionKeys((prev) => {
      if (prev.has(dismissKey)) return prev;
      const next = new Set(prev);
      next.add(dismissKey);
      return next;
    });
  }, []);

  const { priorityNotices, tabNotices, pendingPermissions, pendingQuestions } =
    useMemo(() => {
      const rankedNotices: RankedStatusNotice[] = [];
      const permissions: SpacePendingPermissionItem[] = [];
      const questions: SpacePendingQuestionItem[] = [];

      const buildActor = (
        member: SpaceMember,
        actorId: string
      ): StatusNoticeActor => {
        const memberName = displayName(member);
        return {
          id: actorId,
          name: memberName,
          avatar: createElement(MemberBotAvatar, {
            config: getMemberAvatar(
              member.conversation_id ?? undefined,
              memberName,
              member.member_id
            ),
            className: 'h-4 w-4',
            animated: false,
          }),
          onOpenSession: onOpenMemberSession
            ? () => onOpenMemberSession(member)
            : undefined,
        };
      };

      for (const { conversationId, member } of memberTargets) {
        const snapshot =
          activeBotSnapshot && activeBotConversationId === conversationId
            ? activeBotSnapshot
            : snapshotsByConvId[conversationId];
        if (!snapshot || snapshot.rowsById.size === 0) continue;

        const actor = buildActor(member, conversationId);
        const sideRows = Array.from(snapshot.rowsById.values()).sort((a, b) =>
          compareBigIntAsc(
            toBigIntRevision(a.revision),
            toBigIntRevision(b.revision)
          )
        );
        const runtimeStatus = conversationRuntimeStatus(sideRows);

        // 1. Latest turn_error not superseded by a newer settled assistant turn.
        let latestTurnErrorRow: TimelineRow | undefined;
        for (let i = sideRows.length - 1; i >= 0; i -= 1) {
          const entry = sideRows[i]!;
          if (entry.row.kind !== 'turn_error') continue;
          const rowRev = toBigIntRevision(entry.revision);
          if (rowRev < snapshot.latestSettledAssistantRevision) continue;
          if (
            runtimeStatus.request &&
            runtimeStatus.request.activity.phase === 'completed' &&
            entry.row.error.turn_id &&
            runtimeStatus.request.turn_id !== entry.row.error.turn_id
          ) {
            continue;
          }
          latestTurnErrorRow = entry;
          break;
        }

        const latestTurnError =
          latestTurnErrorRow?.row.kind === 'turn_error'
            ? latestTurnErrorRow.row.error.error
            : null;

        if (latestTurnError && latestTurnErrorRow) {
          rankedNotices.push({
            sortRevision: toBigIntRevision(latestTurnErrorRow.revision),
            notice: {
              id: `${conversationId}:${latestTurnErrorRow.row_id}`,
              kind: 'turn-error',
              error: latestTurnError,
              actor,
              onReload: () => handleReloadMember(conversationId),
              onRebind: () => handleRebindMember(conversationId),
            },
          });
        }

        // 2. Non-telemetry session_notice rows.
        const sessionNoticeRows = sideRows.filter(
          (entry) =>
            entry.row.kind === 'session_notice' &&
            !entry.row.notice.connection_status &&
            !entry.row.notice.request_status
        );
        const connectErrorNoticeRow = sessionNoticeRows.find(
          (entry) => entry.row_id === AGENT_SESSION_CONNECT_ERROR_NOTICE_ROW_ID
        );
        const reconnectNoticeRow = sessionNoticeRows.find(
          (entry) => entry.row_id === AGENT_CONNECTION_RECOVERING_NOTICE_ROW_ID
        );
        const autoPermissionNoticeRow = sessionNoticeRows.find(
          (entry) => entry.row_id === AUTO_PERMISSION_NOTICE_ROW_ID
        );
        let latestSessionNoticeRow: TimelineRow | undefined;
        for (let i = sessionNoticeRows.length - 1; i >= 0; i -= 1) {
          const entry = sessionNoticeRows[i]!;
          if (
            !isDurableHostNote(entry) &&
            entry.row_id !== AGENT_CONNECTION_RECOVERING_NOTICE_ROW_ID &&
            entry.row_id !== AGENT_SESSION_CONNECT_ERROR_NOTICE_ROW_ID &&
            entry.row_id !== AUTO_PERMISSION_NOTICE_ROW_ID
          ) {
            latestSessionNoticeRow = entry;
            break;
          }
        }

        const pushedNoticeIds = new Set<string>();
        const pushSessionNoticeRow = (row: TimelineRow | undefined) => {
          if (!row || row.row.kind !== 'session_notice' || !row.row.notice) {
            return;
          }
          if (isResendColdStartNotice(row.row_id, row.row.notice)) return;
          const noticeId = `${conversationId}:${row.row_id}`;
          if (pushedNoticeIds.has(noticeId)) return;
          pushedNoticeIds.add(noticeId);
          const notice = row.row.notice;
          rankedNotices.push({
            sortRevision: toBigIntRevision(row.revision),
            notice: {
              id: noticeId,
              kind: 'session-notice',
              notice,
              actor,
              onRebind: sessionNoticeNeedsRebind(notice, row.row_id)
                ? () => handleRebindMember(conversationId)
                : undefined,
              onReload:
                row.row_id === AGENT_BINDING_LOAD_FAILURE_NOTICE_ROW_ID
                  ? () => handleReloadMember(conversationId)
                  : undefined,
            },
          });
        };

        const connectionSuperseded = isConnectionSupersededByTurnError(
          latestTurnError,
          Boolean(latestTurnErrorRow)
        );

        if (
          reconnectNoticeRow?.row.kind === 'session_notice' &&
          !connectionSuperseded
        ) {
          const reconnectNotice = reconnectNoticeRow.row.notice;
          const progress = parseReconnectProgressTitle(reconnectNotice.title);
          rankedNotices.push({
            sortRevision: toBigIntRevision(reconnectNoticeRow.revision),
            notice: {
              id: `${conversationId}:runtime:recovering`,
              kind: 'session-notice',
              notice: {
                ...reconnectNotice,
                connection_status: {
                  status: 'recovering',
                  bound: false,
                  connection_id:
                    runtimeStatus.connection?.connection_id ?? null,
                  message: reconnectNotice.message ?? null,
                  since: runtimeStatus.connection?.since ?? '',
                },
              },
              titleOverride: progress
                ? t('runtimeStatus.recoveringProgress', {
                    attempt: progress.attempt,
                    max: progress.maxAttempts,
                  })
                : null,
              actor,
              onReload: () => handleReloadMember(conversationId),
            },
          });
        } else if (
          connectErrorNoticeRow?.row.kind === 'session_notice' &&
          !connectionSuperseded
        ) {
          const connectNotice = connectErrorNoticeRow.row.notice;
          rankedNotices.push({
            sortRevision: toBigIntRevision(connectErrorNoticeRow.revision),
            notice: {
              id: `${conversationId}:${connectErrorNoticeRow.row_id}`,
              kind: 'session-notice',
              notice: {
                ...connectNotice,
                severity: 'error',
                connection_status: runtimeStatus.connection ?? {
                  status: 'error',
                  bound: false,
                  connection_id: null,
                  message: connectNotice.message ?? null,
                  since: '',
                },
              },
              actor,
              onReload: () => handleReloadMember(conversationId),
            },
          });
        } else if (
          !connectionSuperseded &&
          (runtimeStatus.connection?.status === 'error' ||
            runtimeStatus.connection?.status === 'closed')
        ) {
          const connRow = [...sideRows]
            .reverse()
            .find(
              (entry) =>
                entry.row.kind === 'session_notice' &&
                Boolean(entry.row.notice.connection_status)
            );
          rankedNotices.push({
            sortRevision: toBigIntRevision(connRow?.revision ?? 0n),
            notice: {
              id: `${conversationId}:runtime:connection-error`,
              kind: 'session-notice',
              notice: {
                severity: 'error',
                title: '',
                message: runtimeStatus.connection.message ?? null,
                connection_status: runtimeStatus.connection,
              },
              actor,
              onReload: () => handleReloadMember(conversationId),
            },
          });
        }

        pushSessionNoticeRow(autoPermissionNoticeRow);
        if (
          latestSessionNoticeRow?.row_id !== autoPermissionNoticeRow?.row_id
        ) {
          pushSessionNoticeRow(latestSessionNoticeRow);
        }

        // 3. Pending permissions & questions across all members.
        for (const entry of sideRows) {
          if (
            entry.row.kind === 'permission_request' &&
            entry.row.request.status === 'pending' &&
            !excludePermissionIds?.has(entry.row.request.permission_id)
          ) {
            const request = entry.row.request;
            const permKey = `${conversationId}:${request.permission_id}`;
            permissions.push({
              conversationId,
              request,
              actor,
              responding: respondingPermissionKey === permKey,
              onRespond: (permissionId, response) =>
                handleRespondPermission(conversationId, permissionId, response),
            });
          } else if (
            entry.row.kind === 'question_request' &&
            entry.row.response == null
          ) {
            const request = entry.row.request;
            const dismissKey = `${conversationId}:${request.question_id}`;
            if (dismissedQuestionKeys.has(dismissKey)) continue;
            questions.push({
              conversationId,
              dismissKey,
              request,
              actor,
              responding: respondingQuestionKey === dismissKey,
              onRespond: (questionId, response) =>
                handleRespondQuestion(conversationId, questionId, response),
            });
          }
        }
      }

      rankedNotices.sort((a, b) =>
        compareBigIntDesc(a.sortRevision, b.sortRevision)
      );

      const { priorityNotices: splitPriority, tabNotices: splitTabs } =
        splitConversationStatusNotices(
          rankedNotices.map((item) => item.notice)
        );

      if (isPrivateChatActive && isBotSessionLoading) {
        const botMember = memberTargets[0]?.member ?? members[0];
        const loadingActor = botMember
          ? buildActor(
              botMember,
              activeBotConversationId ??
                botMember.conversation_id ??
                botMember.member_id ??
                'bot'
            )
          : undefined;
        splitPriority.unshift({
          id: `bot-session-loading:${activeBotConversationId ?? spaceId ?? 'bot'}`,
          kind: 'session-notice',
          notice: {
            severity: 'info',
            title: t('statusDock.loadingBotSession'),
            message: null,
          },
          actor: loadingActor,
        });
      }

      return {
        priorityNotices: splitPriority,
        tabNotices: splitTabs,
        pendingPermissions: permissions,
        pendingQuestions: questions,
      };
    }, [
      activeBotConversationId,
      activeBotSnapshot,
      dismissedQuestionKeys,
      excludePermissionIds,
      getMemberAvatar,
      handleRebindMember,
      handleReloadMember,
      handleRespondPermission,
      handleRespondQuestion,
      isBotSessionLoading,
      isPrivateChatActive,
      memberTargets,
      members,
      onOpenMemberSession,
      respondingPermissionKey,
      respondingQuestionKey,
      snapshotsByConvId,
      spaceId,
      t,
    ]);

  return {
    priorityNotices,
    tabNotices,
    pendingPermissions,
    pendingQuestions,
    dismissQuestion,
  };
}
