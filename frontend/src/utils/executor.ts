import type {
  AgentId,
  ExecutorConfigs,
  ExecutorProfileId,
} from 'shared/types';

const RESERVED_KEYS = new Set(['recently_used_models']);

function getExecutorVariantKeys(
  executorProfile: Record<string, unknown> | null | undefined
): string[] {
  return Object.keys(executorProfile || {}).filter(
    (key) => !RESERVED_KEYS.has(key)
  );
}

function getSortedExecutorVariantKeys(
  executorProfile: Record<string, unknown> | null | undefined
): string[] {
  return getExecutorVariantKeys(executorProfile).sort((a, b) => {
    if (a === 'DEFAULT') return -1;
    if (b === 'DEFAULT') return 1;
    return a.localeCompare(b);
  });
}

function getVariantOptions(
  executor: string | null | undefined,
  profiles: ExecutorConfigs['executors'] | null | undefined
): string[] {
  if (!executor || !profiles) return [];
  const executorConfig = (profiles as Record<string, unknown>)[executor];
  if (!executorConfig) return [];

  return getSortedExecutorVariantKeys(
    executorConfig as Record<string, unknown>
  );
}

function getDefaultVariantForExecutor(
  executor: string | null | undefined,
  profiles: ExecutorConfigs['executors'] | null | undefined
): string | null {
  const variants = getVariantOptions(executor, profiles);
  if (variants.length === 0) return null;

  const preferred = variants.includes('DEFAULT') ? 'DEFAULT' : variants[0];
  return preferred === 'DEFAULT' ? null : preferred;
}

export function getDefaultProfileForExecutor(
  executor: AgentId | null | undefined,
  profiles: ExecutorConfigs['executors'] | null | undefined
): ExecutorProfileId | null {
  if (!executor) return null;

  return {
    executor,
    variant: getDefaultVariantForExecutor(executor, profiles),
  };
}

export function getFirstAvailableProfile(
  profiles: ExecutorConfigs['executors'] | null | undefined
): ExecutorProfileId | null {
  if (!profiles) return null;

  const executors = Object.keys(profiles).sort() as AgentId[];
  const firstExecutor = executors[0];
  if (!firstExecutor) return null;

  return getDefaultProfileForExecutor(firstExecutor, profiles);
}

/**
 * Compare two ExecutorProfileIds for equality.
 * Treats null/undefined variant as equivalent to "DEFAULT".
 */
export function areProfilesEqual(
  a: ExecutorProfileId | null | undefined,
  b: ExecutorProfileId | null | undefined
): boolean {
  if (!a || !b) return a === b;
  if (a.executor !== b.executor) return false;

  const variantA = a.variant ?? 'DEFAULT';
  const variantB = b.variant ?? 'DEFAULT';
  const modelA = a.model ?? 'DEFAULT';
  const modelB = b.model ?? 'DEFAULT';
  const fastModeA = a.fast_mode == null ? 'FAST_DEFAULT' : String(a.fast_mode);
  const fastModeB = b.fast_mode == null ? 'FAST_DEFAULT' : String(b.fast_mode);
  const reasoningA = a.reasoning_effort ?? 'REASONING_DEFAULT';
  const reasoningB = b.reasoning_effort ?? 'REASONING_DEFAULT';
  return (
    variantA === variantB &&
    modelA === modelB &&
    fastModeA === fastModeB &&
    reasoningA === reasoningB
  );
}
