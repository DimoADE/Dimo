import i18n from '@/i18n';
import type {
  ProjectActivityAlert,
  ProjectActivitySnapshot,
  ProjectActivityVisualState,
} from '@/stores/useWindowProjectsStore';

export function deriveProjectVisualState(
  snapshot: ProjectActivitySnapshot,
  alert?: ProjectActivityAlert
): ProjectActivityVisualState {
  if (snapshot.isLoading || snapshot.hasRunning) {
    return 'loading';
  }

  if (alert?.kind === 'error' && alert.unread) {
    return 'error-unread';
  }

  if (snapshot.hasError) {
    return 'error';
  }

  if (alert?.kind === 'success' && alert.unread) {
    return 'success-unread';
  }

  if (snapshot.hasSessions) {
    return 'success';
  }

  return 'idle';
}

export function resolveProjectVisualStateMeta(
  visualState: ProjectActivityVisualState
): {
  label: string;
  dotClassName: string;
  pulseClassName?: string;
} {
  switch (visualState) {
    case 'loading':
      return {
        label: 'Loading',
        dotClassName: 'text-primary',
      };
    case 'success-unread':
      return {
        label: i18n.t('panels:projectActivity.statusSuccessUnread'),
        dotClassName: 'bg-[hsl(var(--success))]',
        pulseClassName: 'animate-pulse',
      };
    case 'success':
      return {
        label: i18n.t('panels:projectActivity.statusSuccess'),
        dotClassName: 'bg-[hsl(var(--success))]',
      };
    case 'error-unread':
      return {
        label: i18n.t('panels:projectActivity.statusErrorUnread'),
        dotClassName: 'bg-destructive',
        pulseClassName: 'animate-pulse',
      };
    case 'error':
      return {
        label: i18n.t('panels:projectActivity.statusError'),
        dotClassName: 'bg-destructive',
      };
    default:
      return {
        label: i18n.t('panels:projectActivity.statusIdle'),
        dotClassName: 'bg-muted-foreground/60',
      };
  }
}

const MAX_RECENT_SESSION_TITLE_CHARS = 20;

export function formatRecentSessionTitle(
  title: string,
  maxChars = MAX_RECENT_SESSION_TITLE_CHARS
): string {
  const normalized = title.trim();
  const chars = Array.from(normalized);
  if (chars.length <= maxChars) {
    return normalized;
  }
  return `${chars.slice(0, maxChars).join('')}...`;
}
