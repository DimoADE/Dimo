import type { ConversationSessionNotice } from 'shared/types';
import { parseReconnectProgressTitle } from './inlineRuntimeStatus';

const NEWER_EVENT_TITLE = '此会话包含较新版本的记录';
const UNREADABLE_EVENT_TITLE = '部分会话记录无法显示';
const AUTO_PERMISSION_TITLE = '已自动批准权限';

const SESSION_LOAD_OTHER_SUFFIX =
  '确认重新绑定后将冷启动，不会保留 Agent 侧上下文。';

const INTERNAL_ERROR_PREFIXES: RegExp[] = [
  /^internal error:\s*/i,
  /^bad request:\s*/i,
  /^conflict:\s*/i,
  /^agent runtime error:\s*/i,
  /^runtime error:\s*/i,
  /^agent connection closed:\s*/i,
  /^agent authentication required:\s*/i,
  /^acp session preparation failed:\s*/i,
  /^agent execution error:\s*/i,
  /^agent connection was lost and could not be re-established:\s*/i,
  /^session\/load failed:\s*/i,
  /^rpc error:\s*/i,
  /^error:\s*/i,
];

export type Translate = {
  (key: string, options?: Record<string, unknown>): string;
};

export type ConversationSessionNoticeView = {
  title: string;
  summary: string | null;
  technicalDetail: string | null;
};

/**
 * Strip noisy internal transport/protocol prefixes from a raw error message so
 * user-facing summaries read like plain language. The untouched raw text should
 * still be placed in collapsible technical details for support/debugging.
 */
export function stripInternalErrorPrefixes(raw: string): string {
  let current = raw.trim();
  for (let pass = 0; pass < 3; pass += 1) {
    let changed = false;
    for (const pattern of INTERNAL_ERROR_PREFIXES) {
      const next = current.replace(pattern, '').trim();
      if (next !== current && next.length > 0) {
        current = next;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return current;
}

/**
 * Backend (crates/conversations/src/projection/rows.rs & crates/agents/src/session_notice.rs)
 * emits fixed notice titles in a single language. Map them to i18n keys so
 * every card follows the UI language and separates user-friendly summaries
 * from raw technical diagnostics.
 */
const BACKEND_NOTICES: Record<
  string,
  {
    title: string;
    summaryKey?: string;
    message?: { source: string; key: string };
  }
> = {
  '正在连接 Agent…': { title: 'connectingAgent' },
  代理会话已过期: {
    title: 'sessionExpired',
    summaryKey: 'sessionExpiredDescription',
    message: {
      source:
        '代理侧已不存在该会话。可见历史仍在，但 Agent 隐藏上下文已丢失。确认重新绑定后才能继续。',
      key: 'sessionExpiredDescription',
    },
  },
  需要重新认证: {
    title: 'reauthRequired',
    summaryKey: 'reauthRequiredDescription',
  },
  代理不支持会话恢复: {
    title: 'resumeUnsupported',
    summaryKey: 'resumeUnsupportedDescription',
    message: {
      source:
        '该代理无法恢复原会话。确认重新绑定后将冷启动，不会保留 Agent 侧上下文。',
      key: 'resumeUnsupportedDescription',
    },
  },
  代理会话已归档: {
    title: 'sessionArchived',
    summaryKey: 'sessionArchivedDescription',
    message: {
      source: '会话已归档。重新加载或新建对话。',
      key: 'sessionArchivedDescription',
    },
  },
  代理会话正被占用: {
    title: 'sessionBusy',
    summaryKey: 'sessionBusyDescription',
    message: {
      source:
        '关闭占用该会话的窗口后重新加载。不要新建会话，否则会丢掉唯一指针。',
      key: 'sessionBusyDescription',
    },
  },
  代理会话不可用: {
    title: 'sessionUnavailable',
    summaryKey: 'sessionUnavailableDescription',
    message: {
      source:
        '代理侧会话已结束或不存在。可见历史仍在，但 Agent 隐藏上下文已丢失。',
      key: 'sessionUnavailableDescription',
    },
  },
  加载代理会话失败: {
    title: 'sessionLoadFailed',
    summaryKey: 'sessionLoadFailedDescription',
  },
  'Agent 会话已重新绑定': {
    title: 'sessionRebound',
    summaryKey: 'sessionReboundDescription',
  },
  'Agent session recovery failed': {
    title: 'sessionRecoveryFailed',
    summaryKey: 'sessionRecoveryFailedDescription',
  },
  'Agent configuration changed': {
    title: 'agentConfigChanged',
    summaryKey: 'agentConfigChangedDescription',
  },
  会话出错: {
    title: 'sessionError',
    summaryKey: 'sessionErrorDescription',
  },
  会话配置未应用: {
    title: 'configOverrideSkipped',
    summaryKey: 'configOverrideSkippedDescription',
  },
  未识别的会话更新: { title: 'unrecognizedUpdate' },
  'Context compacted': {
    title: 'contextCompacted',
    summaryKey: 'contextCompactedDescription',
    message: {
      source: "Context compacted to fit the model's context window.",
      key: 'contextCompactedDescription',
    },
  },
  'Context nearing limit, running automatic compaction...': {
    title: 'contextCompacting',
    summaryKey: 'contextCompactingDescription',
  },
  'Retry finished, resuming.': { title: 'retryResuming' },
  'Cleared queued prompts.': { title: 'queuedCleared' },
  'Starting queued message.': { title: 'queuedStarting' },
  'Config warning': { title: 'configWarning' },
  Warning: { title: 'agentWarning' },
};

/** Localize a fixed backend notice title; unknown titles pass through. */
export function localizeBackendNoticeTitle(
  title: string,
  t: Translate
): string {
  const entry = BACKEND_NOTICES[title];
  if (entry) {
    return t(`conversation:backendNotice.${entry.title}`);
  }
  const reconnectProgress = parseReconnectProgressTitle(title);
  if (reconnectProgress) {
    return t('conversation:backendNotice.reconnectingProgress', {
      attempt: reconnectProgress.attempt,
      max: reconnectProgress.maxAttempts,
    });
  }
  if (title.startsWith('Automatic compaction finished')) {
    return t('conversation:backendNotice.contextCompacted');
  }
  const queuedMatch = title.match(/^Queued message \(position (\d+)\)/);
  if (queuedMatch) {
    return t('conversation:backendNotice.queuedPosition', {
      position: Number(queuedMatch[1]),
    });
  }
  return title;
}

/**
 * Translate raw internal connection/runtime messages emitted by Rust into a
 * plain-language summary while keeping the original text for collapsible
 * technical details.
 */
export function formatRuntimeConnectionMessage(
  raw: string | null | undefined,
  t: Translate
): { summary: string | null; technicalDetail: string | null } {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return { summary: null, technicalDetail: null };
  }
  const lower = trimmed.toLowerCase();
  if (
    lower.includes('retired after cancel was not acknowledged') ||
    lower.includes('cancel was not acknowledged')
  ) {
    return {
      summary: t('conversation:runtime.cancelRetiredSummary'),
      technicalDetail: trimmed,
    };
  }
  if (
    lower.includes('retired after prompt idle timeout') ||
    lower.includes('idle timeout')
  ) {
    return {
      summary: t('conversation:runtime.idleRetiredSummary'),
      technicalDetail: trimmed,
    };
  }
  if (
    lower.includes('connection closed before the turn completed') ||
    lower.includes('agent connection closed') ||
    lower.includes('agent connection was lost') ||
    lower === 'connection closed'
  ) {
    return {
      summary: t('conversation:runtime.connectionClosedSummary'),
      technicalDetail: trimmed,
    };
  }
  const cleaned = stripInternalErrorPrefixes(trimmed);
  if (!cleaned.includes('\n') && cleaned.length <= 160) {
    return {
      summary: cleaned,
      technicalDetail: cleaned !== trimmed ? trimmed : null,
    };
  }
  return {
    summary: null,
    technicalDetail: trimmed,
  };
}

/**
 * Resolve a backend `ConversationSessionNotice` into a 3-tier presentation:
 * localized title, plain-language summary, and optional raw technical details.
 */
export function getConversationSessionNoticeView(
  notice: ConversationSessionNotice,
  t: Translate
): ConversationSessionNoticeView {
  if (notice.title === NEWER_EVENT_TITLE) {
    return {
      title: t('conversation:statusDock.newerEventTitle'),
      summary: t('conversation:statusDock.newerEventDescription'),
      technicalDetail: null,
    };
  }

  if (notice.title === UNREADABLE_EVENT_TITLE) {
    return {
      title: t('conversation:statusDock.unreadableEventTitle'),
      summary: t('conversation:statusDock.unreadableEventDescription'),
      technicalDetail: null,
    };
  }

  if (notice.title === AUTO_PERMISSION_TITLE) {
    const count = Number(notice.message?.match(/\d+/)?.[0] ?? '0');
    return {
      title: t('conversation:statusDock.autoPermissionTitle'),
      summary: t('conversation:statusDock.autoPermissionDescription', {
        count,
      }),
      technicalDetail: null,
    };
  }

  const rawMessage = notice.message?.trim() || null;

  if (notice.title === '代理会话已归档') {
    const title = t('conversation:backendNotice.sessionArchived');
    if (notice.action?.kind === 'copy_command') {
      return {
        title,
        summary: t('conversation:backendNotice.sessionArchivedWithCommand'),
        technicalDetail: notice.action.command,
      };
    }
    return {
      title,
      summary: t('conversation:backendNotice.sessionArchivedDescription'),
      technicalDetail:
        rawMessage && rawMessage !== '会话已归档。重新加载或新建对话。'
          ? rawMessage
          : null,
    };
  }

  if (notice.title === '加载代理会话失败') {
    const strippedCause = rawMessage
      ? rawMessage.replace(SESSION_LOAD_OTHER_SUFFIX, '').trim()
      : null;
    return {
      title: t('conversation:backendNotice.sessionLoadFailed'),
      summary: t('conversation:backendNotice.sessionLoadFailedDescription'),
      technicalDetail: strippedCause || null,
    };
  }

  const entry = BACKEND_NOTICES[notice.title];
  if (entry) {
    const title = t(`conversation:backendNotice.${entry.title}`);
    if (entry.message && rawMessage === entry.message.source) {
      return {
        title,
        summary: t(`conversation:backendNotice.${entry.message.key}`),
        technicalDetail: null,
      };
    }
    if (entry.summaryKey) {
      const summary = t(`conversation:backendNotice.${entry.summaryKey}`);
      // Keep dynamic backend diagnostics in collapsible details without
      // duplicating the exact same localized sentence.
      const technicalDetail =
        rawMessage && rawMessage !== summary ? rawMessage : null;
      return { title, summary, technicalDetail };
    }
    return {
      title,
      summary: null,
      technicalDetail: rawMessage,
    };
  }

  const localizedTitle = localizeBackendNoticeTitle(notice.title, t);
  if (localizedTitle !== notice.title) {
    return {
      title: localizedTitle,
      summary: null,
      technicalDetail: rawMessage,
    };
  }

  // Unknown/adapter notice (e.g., Codex warning): keep raw message behind
  // details if it starts with or extends the title, otherwise show cleanly.
  return {
    title: notice.title,
    summary: null,
    technicalDetail: rawMessage,
  };
}

export function getConversationSessionNoticeCopy(
  notice: ConversationSessionNotice,
  t: Translate
): { title: string; message: string | null } {
  if (notice.title === NEWER_EVENT_TITLE) {
    return {
      title: t('conversation:statusDock.newerEventTitle'),
      message: t('conversation:statusDock.newerEventDescription'),
    };
  }

  if (notice.title === UNREADABLE_EVENT_TITLE) {
    return {
      title: t('conversation:statusDock.unreadableEventTitle'),
      message: t('conversation:statusDock.unreadableEventDescription'),
    };
  }

  if (notice.title === AUTO_PERMISSION_TITLE) {
    const count = Number(notice.message?.match(/\d+/)?.[0] ?? '0');
    return {
      title: t('conversation:statusDock.autoPermissionTitle'),
      message: t('conversation:statusDock.autoPermissionDescription', {
        count,
      }),
    };
  }

  const entry = BACKEND_NOTICES[notice.title];
  if (entry) {
    const message =
      entry.message && notice.message === entry.message.source
        ? t(`conversation:backendNotice.${entry.message.key}`)
        : (notice.message ?? null);
    return { title: t(`conversation:backendNotice.${entry.title}`), message };
  }

  return {
    title: localizeBackendNoticeTitle(notice.title, t),
    message: notice.message ?? null,
  };
}
