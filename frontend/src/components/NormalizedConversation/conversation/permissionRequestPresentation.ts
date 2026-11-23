import type { AgentPermissionOption } from 'shared/types';

export type PermissionAllowScope = 'once' | 'session' | 'always';

export const COMMAND_PREFIX_OPTION_PREFIX = 'allow-prefix-';

export function isAllowOption(option: AgentPermissionOption): boolean {
  return option.kind === 'allow_once' || option.kind === 'allow_always';
}

export function isCommandPrefixOption(option: AgentPermissionOption): boolean {
  return (
    option.kind === 'allow_once' &&
    option.id.startsWith(COMMAND_PREFIX_OPTION_PREFIX)
  );
}

export function resolveCommandPrefixOptions(
  options: AgentPermissionOption[]
): AgentPermissionOption[] {
  return options.filter(isCommandPrefixOption);
}

export function resolvePermissionAllowOption(
  options: AgentPermissionOption[],
  scope: PermissionAllowScope
): AgentPermissionOption | null {
  const plainAllowOnce = options.find(
    (option) => option.kind === 'allow_once' && !isCommandPrefixOption(option)
  );
  const allowOnce =
    plainAllowOnce ?? options.find((option) => option.kind === 'allow_once');
  const allowAlways = options.find((option) => option.kind === 'allow_always');
  const anyAllow = options.find(isAllowOption);

  if (scope === 'once') {
    return allowOnce ?? anyAllow ?? null;
  }

  return allowAlways ?? allowOnce ?? anyAllow ?? null;
}

export function permissionPreviewText({
  title,
  command,
}: {
  title: string | null | undefined;
  command: string | null | undefined;
}): string {
  const parts = [title?.trim(), command?.trim()].filter(
    (value): value is string => Boolean(value)
  );
  return [...new Set(parts)].join('\n');
}
