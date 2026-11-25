import { describe, expect, it } from 'vitest';
import {
  formatRuntimeConnectionMessage,
  getConversationSessionNoticeCopy,
  getConversationSessionNoticeView,
  localizeBackendNoticeTitle,
  stripInternalErrorPrefixes,
} from './sessionNoticeCopy';

describe('getConversationSessionNoticeCopy', () => {
  const translations: Record<string, string> = {
    'conversation:statusDock.newerEventTitle': 'Newer record',
    'conversation:statusDock.newerEventDescription': 'Update to view it.',
    'conversation:statusDock.unreadableEventTitle': 'Unreadable record',
    'conversation:statusDock.unreadableEventDescription':
      'The rest of the conversation is unaffected.',
  };
  const t = (key: string) => translations[key] ?? key;

  it('localizes forward-version notices instead of exposing backend copy', () => {
    expect(
      getConversationSessionNoticeCopy(
        {
          title: '此会话包含较新版本的记录',
          message:
            '当前版本暂时无法显示其中一条记录，其余会话内容不受影响。更新 Dimo 后可再次查看。',
          severity: 'warning',
        },
        t
      )
    ).toEqual({ title: 'Newer record', message: 'Update to view it.' });
  });

  it('localizes auto-approved permission notices with the folded count', () => {
    const t = (key: string, options?: Record<string, unknown>) => {
      if (key === 'conversation:statusDock.autoPermissionTitle') {
        return 'Permissions auto-approved';
      }
      if (key === 'conversation:statusDock.autoPermissionDescription') {
        return `Automatically approved ${options?.count ?? 0} permission requests`;
      }
      return translations[key] ?? key;
    };
    expect(
      getConversationSessionNoticeCopy(
        {
          title: '已自动批准权限',
          message: '已自动批准 3 项权限请求',
          severity: 'info',
        },
        t
      )
    ).toEqual({
      title: 'Permissions auto-approved',
      message: 'Automatically approved 3 permission requests',
    });
  });

  it('keeps unrelated agent notices unchanged', () => {
    expect(
      getConversationSessionNoticeCopy(
        {
          title: '某个未知提示',
          message: '已自动新建会话继续。',
          severity: 'info',
        },
        t
      )
    ).toEqual({
      title: '某个未知提示',
      message: '已自动新建会话继续。',
    });
  });

  it('maps known backend notice titles to i18n keys', () => {
    expect(
      getConversationSessionNoticeCopy(
        {
          title: '代理不支持会话恢复',
          message: '已自动新建会话继续。',
          severity: 'info',
        },
        t
      ).title
    ).toBe('conversation:backendNotice.resumeUnsupported');
  });

  it('strips stacked internal transport and runtime error prefixes', () => {
    expect(
      stripInternalErrorPrefixes(
        'Internal error: Agent runtime error: RPC error: upstream overloaded'
      )
    ).toBe('upstream overloaded');
    expect(
      stripInternalErrorPrefixes('Runtime error: connection reset by peer')
    ).toBe('connection reset by peer');
  });

  it('humanizes internal runtime connection messages while keeping raw text in details', () => {
    const tRuntime = (key: string) => key;
    expect(
      formatRuntimeConnectionMessage(
        'agent session retired after cancel was not acknowledged',
        tRuntime
      )
    ).toEqual({
      summary: 'conversation:runtime.cancelRetiredSummary',
      technicalDetail:
        'agent session retired after cancel was not acknowledged',
    });
    expect(
      formatRuntimeConnectionMessage(
        'session retired after prompt idle timeout (300s)',
        tRuntime
      )
    ).toEqual({
      summary: 'conversation:runtime.idleRetiredSummary',
      technicalDetail: 'session retired after prompt idle timeout (300s)',
    });
    expect(
      formatRuntimeConnectionMessage(
        'Agent connection closed before the turn completed.',
        tRuntime
      )
    ).toEqual({
      summary: 'conversation:runtime.connectionClosedSummary',
      technicalDetail: 'Agent connection closed before the turn completed.',
    });
  });

  it('localizes dynamic backend notice titles and produces 3-tier notice views', () => {
    const tRich = (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key;

    expect(
      localizeBackendNoticeTitle('会话加载异常，正在重连 3/10 次…', tRich)
    ).toBe(
      'conversation:backendNotice.reconnectingProgress:{"attempt":3,"max":10}'
    );
    expect(
      localizeBackendNoticeTitle('Queued message (position 2)', tRich)
    ).toBe('conversation:backendNotice.queuedPosition:{"position":2}');
    expect(
      localizeBackendNoticeTitle(
        'Automatic compaction finished (saved 40%)',
        tRich
      )
    ).toBe('conversation:backendNotice.contextCompacted');

    expect(
      getConversationSessionNoticeView(
        {
          title: '代理会话已归档',
          message: '运行命令解除归档',
          severity: 'warning',
          action: {
            kind: 'copy_command',
            label: 'Copy command',
            command: 'codex unarchive abc',
          },
        },
        tRich
      )
    ).toEqual({
      title: 'conversation:backendNotice.sessionArchived',
      summary: 'conversation:backendNotice.sessionArchivedWithCommand',
      technicalDetail: 'codex unarchive abc',
    });

    expect(
      getConversationSessionNoticeView(
        {
          title: '加载代理会话失败',
          message:
            'session/load failed: enoent 确认重新绑定后将冷启动，不会保留 Agent 侧上下文。',
          severity: 'warning',
        },
        tRich
      )
    ).toEqual({
      title: 'conversation:backendNotice.sessionLoadFailed',
      summary: 'conversation:backendNotice.sessionLoadFailedDescription',
      technicalDetail: 'session/load failed: enoent',
    });
  });
});
