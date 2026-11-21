import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionsApi } from '@/lib/api';
import {
  findCachedSessionReviewState,
  invalidateWorkspaceSessions,
  markReviewSessionViewed,
  removeSessionsFromWorkspaceCaches,
} from './sessionQueryCache';

describe('removeSessionsFromWorkspaceCaches', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('evicts deleted sessions from workspace and active-attempt caches', () => {
    const queryClient = new QueryClient();

    queryClient.setQueryData(
      ['workspaceSessions', 'workspace-1'],
      [{ id: 'deleted-session' }, { id: 'kept-session' }]
    );
    queryClient.setQueryData(
      ['workspaceSessions', 'workspace-1', 'summaries'],
      [{ id: 'deleted-session' }, { id: 'kept-session' }]
    );
    queryClient.setQueryData(['taskAttemptWithSession', 'workspace-1'], {
      id: 'workspace-1',
      session: { id: 'deleted-session' },
    });
    queryClient.setQueryData(['taskAttemptWithSession', 'workspace-2'], {
      id: 'workspace-2',
      session: { id: 'kept-session' },
    });
    queryClient.setQueryData(['session', 'deleted-session'], {
      id: 'deleted-session',
    });

    removeSessionsFromWorkspaceCaches(queryClient, ['deleted-session']);

    expect(
      queryClient.getQueryData<Array<{ id: string }>>([
        'workspaceSessions',
        'workspace-1',
      ])
    ).toEqual([{ id: 'kept-session' }]);
    expect(
      queryClient.getQueryData<Array<{ id: string }>>([
        'workspaceSessions',
        'workspace-1',
        'summaries',
      ])
    ).toEqual([{ id: 'kept-session' }]);
    expect(
      queryClient.getQueryData<{ session?: { id: string } }>([
        'taskAttemptWithSession',
        'workspace-1',
      ])?.session
    ).toBeUndefined();
    expect(
      queryClient.getQueryData<{ session?: { id: string } }>([
        'taskAttemptWithSession',
        'workspace-2',
      ])?.session?.id
    ).toBe('kept-session');
    expect(
      queryClient.getQueryData(['session', 'deleted-session'])
    ).toBeUndefined();
  });

  it('invalidates the workspace session list for a live import', async () => {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    await invalidateWorkspaceSessions(queryClient, 'workspace-1');

    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ['workspaceSessions', 'workspace-1'],
    });
  });
});

describe('markReviewSessionViewed', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('optimistically updates cached status to done, calls markViewed, and invalidates workspace sessions', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(
      ['workspaceSessions', 'workspace-1', 'summaries'],
      [
        {
          id: 'session-1',
          workspace_id: 'workspace-1',
          status: 'inreview',
          is_running: false,
        },
      ]
    );
    queryClient.setQueryData(['session', 'session-1'], {
      id: 'session-1',
      workspace_id: 'workspace-1',
      status: 'inreview',
    });

    const markViewedSpy = vi
      .spyOn(sessionsApi, 'markViewed')
      .mockResolvedValue({
        id: 'session-1',
        workspace_id: 'workspace-1',
        status: 'done',
      } as never);
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const promise = markReviewSessionViewed(queryClient, 'session-1', {
      onlyIfCached: true,
    });

    expect(
      queryClient.getQueryData<Array<{ status: string }>>([
        'workspaceSessions',
        'workspace-1',
        'summaries',
      ])?.[0]?.status
    ).toBe('done');
    expect(
      queryClient.getQueryData<{ status: string }>(['session', 'session-1'])
        ?.status
    ).toBe('done');

    await expect(promise).resolves.toBe(true);
    expect(markViewedSpy).toHaveBeenCalledWith('session-1');
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['workspaceSessions', 'workspace-1'],
    });
  });

  it('skips running or non-inreview sessions and deduplicates concurrent requests', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(
      ['workspaceSessions', 'workspace-1', 'summaries'],
      [
        {
          id: 'running-session',
          workspace_id: 'workspace-1',
          status: 'inreview',
          is_running: true,
        },
        {
          id: 'done-session',
          workspace_id: 'workspace-1',
          status: 'done',
          is_running: false,
        },
        {
          id: 'review-session',
          workspace_id: 'workspace-1',
          status: 'inreview',
          is_running: false,
        },
      ]
    );

    let resolveMarkViewed!: (value: never) => void;
    const markViewedSpy = vi
      .spyOn(sessionsApi, 'markViewed')
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveMarkViewed = resolve;
          })
      );

    expect(
      await markReviewSessionViewed(queryClient, 'running-session', {
        onlyIfCached: true,
      })
    ).toBe(false);
    expect(
      await markReviewSessionViewed(queryClient, 'done-session', {
        onlyIfCached: true,
      })
    ).toBe(false);
    expect(markViewedSpy).not.toHaveBeenCalled();

    const first = markReviewSessionViewed(queryClient, 'review-session', {
      onlyIfCached: true,
    });
    const second = markReviewSessionViewed(queryClient, 'review-session', {
      onlyIfCached: true,
    });
    expect(markViewedSpy).toHaveBeenCalledTimes(1);

    resolveMarkViewed({ id: 'review-session', status: 'done' } as never);
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
  });

  it('reverts optimistic status back to inreview when markViewed fails', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(
      ['workspaceSessions', 'workspace-1', 'summaries'],
      [
        {
          id: 'session-err',
          workspace_id: 'workspace-1',
          status: 'inreview',
          is_running: false,
        },
      ]
    );
    queryClient.setQueryData(['session', 'session-err'], {
      id: 'session-err',
      workspace_id: 'workspace-1',
      status: 'inreview',
    });

    vi.spyOn(sessionsApi, 'markViewed').mockRejectedValue(
      new Error('network error')
    );

    await expect(
      markReviewSessionViewed(queryClient, 'session-err', {
        onlyIfCached: true,
      })
    ).resolves.toBe(false);

    expect(
      findCachedSessionReviewState(queryClient, 'session-err')?.status
    ).toBe('inreview');
    expect(
      queryClient.getQueryData<{ status: string }>(['session', 'session-err'])
        ?.status
    ).toBe('inreview');
  });
});
