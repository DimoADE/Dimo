import { useTranslation } from 'react-i18next';
import type { StatusNoticeActor } from '@/contexts/ConversationStatusContext';

export function StatusNoticeActorChip({
  actor,
}: {
  actor?: StatusNoticeActor | null;
}) {
  const { t } = useTranslation(['conversation']);
  if (!actor) return null;

  const content = (
    <>
      {actor.avatar ? (
        <span className="composer-status-actor-avatar" aria-hidden="true">
          {actor.avatar}
        </span>
      ) : null}
      <span className="composer-status-actor-name">{actor.name}</span>
    </>
  );

  if (actor.onOpenSession) {
    const label = t('statusDock.openMemberSession', { name: actor.name });
    return (
      <button
        type="button"
        className="composer-status-actor composer-status-actor--interactive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
        onClick={actor.onOpenSession}
        title={label}
        aria-label={label}
        data-testid={
          actor.id ? `status-notice-actor-${actor.id}` : 'status-notice-actor'
        }
      >
        {content}
      </button>
    );
  }

  return (
    <span
      className="composer-status-actor"
      data-testid={
        actor.id ? `status-notice-actor-${actor.id}` : 'status-notice-actor'
      }
    >
      {content}
    </span>
  );
}
