import { useEffect, useState } from 'react';

import { useOptionalWorktree } from '@/contexts/WorktreeContext';

import { BotAutomationsPanel } from './BotAutomationsPanel';
import { collaborationCall } from './collaborationApi';

function readConfigWorkspaceId(
  config: Record<string, unknown> | null | undefined
): string {
  if (!config) return '';
  for (const key of ['workspace_id', 'workspaceId']) {
    const value = config[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

export function AssistantDetailsTasksTab({
  memberId,
  botName,
  workspaceId: propWorkspaceId,
  initialCreateKind = null,
  createRequestNonce,
}: {
  memberId: string;
  botName: string;
  workspaceId?: string | null;
  initialCreateKind?: 'event' | 'schedule' | null;
  createRequestNonce?: number;
}) {
  const worktree = useOptionalWorktree();
  const [memberWorkspaceId, setMemberWorkspaceId] = useState('');

  const directWorkspaceId =
    propWorkspaceId ?? worktree?.activeWorktreeId ?? null;

  useEffect(() => {
    if (!memberId || directWorkspaceId) return;
    let active = true;
    void collaborationCall<{ config?: Record<string, unknown> | null }>(
      'collaboration',
      'member.config.get',
      { memberId }
    )
      .then((page) => {
        if (!active) return;
        setMemberWorkspaceId(readConfigWorkspaceId(page.config));
      })
      .catch(() => {
        // Non-fatal fallback; BotAutomationsPanel still works with null workspaceId.
      });
    return () => {
      active = false;
    };
  }, [directWorkspaceId, memberId]);

  const effectiveWorkspaceId = directWorkspaceId ?? (memberWorkspaceId || null);

  return (
    <div
      className="collaboration-assistant-details-tasks"
      data-testid="collaboration-assistant-details-tasks"
    >
      <BotAutomationsPanel
        memberId={memberId}
        botName={botName}
        workspaceId={effectiveWorkspaceId}
        initialCreateKind={initialCreateKind}
        createRequestNonce={createRequestNonce}
      />
    </div>
  );
}
