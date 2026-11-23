import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Copy,
  FileText,
  Globe2,
  SquareTerminal,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import type {
  AgentPermissionOption,
  AgentPermissionResponse,
  ConversationPermissionView,
} from 'shared/types';
import type { StatusNoticeActor } from '@/contexts/ConversationStatusContext';
import { StatusNoticeActorChip } from '@/components/tasks/follow-up/StatusNoticeActorChip';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import {
  resolveCommandPrefixOptions,
  resolvePermissionAllowOption,
  type PermissionAllowScope,
} from './permissionRequestPresentation';

export type PermissionStackControl = {
  index: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
};

export type PermissionStackItem = {
  request: ConversationPermissionView;
  actor?: StatusNoticeActor | null;
  responding?: boolean;
  onRespond: (permissionId: string, response: AgentPermissionResponse) => void;
};

/**
 * Stacked Capsule dock for 1..N pending permission requests.
 * Single requests render a standalone Capsule bar; multiple concurrent requests
 * collapse into a layered deck with a tabular `1 / N` stepper so the stream
 * never gets pushed off-screen.
 */
export function PermissionRequestStack({
  items,
}: {
  items: PermissionStackItem[];
}) {
  const [activeId, setActiveId] = useState<string | null>(null);

  const activeIndex = useMemo(() => {
    if (items.length === 0) return 0;
    if (activeId) {
      const idx = items.findIndex(
        (item) => item.request.permission_id === activeId
      );
      if (idx >= 0) return idx;
    }
    return 0;
  }, [items, activeId]);

  useEffect(() => {
    if (items.length === 0) {
      if (activeId !== null) setActiveId(null);
      return;
    }
    if (!activeId || !items.some((i) => i.request.permission_id === activeId)) {
      setActiveId(items[0].request.permission_id);
    }
  }, [items, activeId]);

  if (items.length === 0) return null;

  const current = items[activeIndex] ?? items[0];
  const count = items.length;

  const step = (delta: number) => {
    if (count <= 1) return;
    const nextIndex = (activeIndex + delta + count) % count;
    setActiveId(items[nextIndex].request.permission_id);
  };

  if (count === 1) {
    return (
      <PermissionRequestCard
        key={current.request.permission_id}
        request={current.request}
        actor={current.actor}
        responding={current.responding}
        onRespond={current.onRespond}
      />
    );
  }

  return (
    <div
      className="permission-capsule-stack"
      data-testid="permission-capsule-stack"
    >
      {count > 2 ? (
        <div
          className="permission-capsule-stack-rim permission-capsule-stack-rim--back"
          aria-hidden="true"
        />
      ) : null}
      <div
        className="permission-capsule-stack-rim permission-capsule-stack-rim--front"
        aria-hidden="true"
      />
      <PermissionRequestCard
        key={current.request.permission_id}
        request={current.request}
        actor={current.actor}
        responding={current.responding}
        onRespond={current.onRespond}
        stack={{
          index: activeIndex,
          total: count,
          onPrev: () => step(-1),
          onNext: () => step(1),
        }}
      />
    </div>
  );
}

/**
 * Inline, answerable permission request in Capsule form (Dimo style — compact
 * title-first bar docked at the bottom of the message stream, with an upward
 * detail drawer for commands/diffs/paths so full inspection stays one click away).
 */
export function PermissionRequestCard({
  request,
  actor,
  onRespond,
  responding = false,
  stack,
}: {
  request: ConversationPermissionView;
  actor?: StatusNoticeActor | null;
  onRespond: (permissionId: string, response: AgentPermissionResponse) => void;
  responding?: boolean;
  stack?: PermissionStackControl;
}) {
  const { t } = useTranslation(['conversation', 'common']);
  const [detailsOpen, setDetailsOpen] = useState(false);
  useEffect(() => {
    setDetailsOpen(false);
  }, [request.permission_id]);
  const pending = request.status === 'pending';
  const options = request.options ?? [];
  const detail = useMemo(
    () => parseToolDetail(request.details, request.title),
    [request.details, request.title]
  );
  const permissionType = permissionTypeFor(detail.kind);
  const PermissionTypeIcon = permissionType.icon;
  const primaryAllow = resolvePermissionAllowOption(options, 'once');
  const commandPrefixOptions = resolveCommandPrefixOptions(options);
  const rejectOption =
    options.find((option) => option.kind === 'reject_once') ??
    options.find((option) => option.kind === 'reject_always');
  const allowScopes: Array<{
    scope: PermissionAllowScope;
    label: string;
  }> = [
    { scope: 'once', label: t('permissionRequestCard.allowOnce') },
    { scope: 'session', label: t('permissionRequestCard.allowSession') },
    { scope: 'always', label: t('permissionRequestCard.allowAlways') },
  ];

  const primaryTitle =
    detail.heading ?? detail.subtitle ?? t('permissionRequestCard.title');
  const secondaryLine = resolveSecondaryLine({
    primaryTitle,
    fallbackTitle: t('permissionRequestCard.title'),
    heading: detail.heading,
    subtitle: detail.subtitle,
    primaryPath: detail.primaryPath,
    command: detail.command,
  });
  const hasDetails = Boolean(detail.body);

  const respondWithOption = (
    option: AgentPermissionOption,
    scope: PermissionAllowScope = 'once'
  ) =>
    onRespond(request.permission_id, {
      kind: 'selected',
      option_id: option.id,
      ...(scope !== 'once' ? { persist: true } : {}),
      ...(scope === 'always' ? { persist_for_agent: true } : {}),
      ...(typeof request.revision === 'number' && request.revision > 0
        ? { expected_revision: request.revision }
        : {}),
    });
  const respondWithScope = (scope: PermissionAllowScope) => {
    const option = resolvePermissionAllowOption(options, scope);
    if (option) respondWithOption(option, scope);
  };

  return (
    <section className="permission-request-card conv-entry-item text-sm">
      {hasDetails && detailsOpen ? (
        <div
          className="permission-capsule-drawer"
          data-testid="permission-capsule-drawer"
        >
          {detail.body}
        </div>
      ) : null}

      <div className="permission-capsule-bar">
        {actor ? <StatusNoticeActorChip actor={actor} /> : null}
        <span
          className={cn(
            'permission-capsule-type-pill',
            permissionType.pillClass
          )}
        >
          <PermissionTypeIcon className="h-3 w-3" aria-hidden="true" />
          <span>{t(`permissionRequestCard.types.${permissionType.key}`)}</span>
        </span>

        <div className="permission-capsule-summary">
          <h3 className="permission-capsule-title" title={primaryTitle}>
            {primaryTitle}
          </h3>
          {secondaryLine ? (
            <p className="permission-capsule-subtitle" title={secondaryLine}>
              {secondaryLine}
            </p>
          ) : null}
        </div>

        {stack && stack.total > 1 ? (
          <div
            className="permission-capsule-stepper"
            data-testid="permission-capsule-stepper"
          >
            <button
              type="button"
              className="permission-capsule-step-btn"
              onClick={stack.onPrev}
              aria-label={t('permissionRequestCard.prevRequest')}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <span className="px-1 tabular-nums">
              {stack.index + 1} / {stack.total}
            </span>
            <button
              type="button"
              className="permission-capsule-step-btn"
              onClick={stack.onNext}
              aria-label={t('permissionRequestCard.nextRequest')}
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : null}

        <div className="permission-capsule-actions">
          {hasDetails ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
              aria-expanded={detailsOpen}
              aria-label={
                detailsOpen
                  ? t('permissionRequestCard.collapseDetails')
                  : t('permissionRequestCard.details')
              }
              onClick={() => setDetailsOpen((open) => !open)}
            >
              {detailsOpen ? (
                <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              <span>{t('permissionRequestCard.details')}</span>
            </Button>
          ) : null}

          {pending ? (
            <>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 px-2.5 text-xs"
                disabled={responding}
                onClick={() =>
                  rejectOption
                    ? respondWithOption(rejectOption)
                    : onRespond(request.permission_id, { kind: 'cancelled' })
                }
              >
                {t('permissionRequestCard.reject')}
              </Button>
              {primaryAllow ? (
                <div
                  className="permission-request-allow-group inline-flex items-stretch"
                  role="group"
                  aria-label={t('permissionRequestCard.allowActions')}
                >
                  <Button
                    type="button"
                    size="sm"
                    disabled={responding}
                    className="h-7 rounded-r-none px-2.5 text-xs"
                    onClick={() => respondWithScope('once')}
                  >
                    {t('permissionRequestCard.allow')}
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        size="sm"
                        disabled={responding}
                        className="h-7 w-7 rounded-l-none border-l border-l-primary-foreground/20 px-0"
                        aria-label={t('permissionRequestCard.expandAllow')}
                      >
                        <ChevronDown className="h-3.5 w-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      align="end"
                      side="top"
                      className="w-[min(280px,calc(100vw-24px))] p-1.5"
                    >
                      {allowScopes.flatMap(({ scope, label }) => {
                        const option = resolvePermissionAllowOption(
                          options,
                          scope
                        );
                        const scopeItem = (
                          <DropdownMenuItem
                            key={scope}
                            disabled={responding || !option}
                            className="px-2.5 py-2"
                            onSelect={() => respondWithScope(scope)}
                          >
                            {label}
                          </DropdownMenuItem>
                        );
                        if (
                          scope !== 'once' ||
                          commandPrefixOptions.length === 0
                        ) {
                          return [scopeItem];
                        }
                        return [
                          scopeItem,
                          ...commandPrefixOptions.map((prefixOption) => (
                            <DropdownMenuItem
                              key={prefixOption.id}
                              disabled={responding}
                              className="px-2.5 py-2"
                              onSelect={() => respondWithOption(prefixOption)}
                            >
                              <span className="flex min-w-0 flex-col gap-0.5">
                                <span>
                                  {t(
                                    'permissionRequestCard.allowCommandPrefix'
                                  )}
                                </span>
                                {prefixOption.description ? (
                                  <code className="block break-all font-mono text-[11px] text-muted-foreground">
                                    {prefixOption.description}
                                  </code>
                                ) : null}
                              </span>
                            </DropdownMenuItem>
                          )),
                        ];
                      })}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              ) : null}
            </>
          ) : (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Check className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{t('permissionRequestCard.responded')}</span>
            </span>
          )}
        </div>
      </div>
    </section>
  );
}

function resolveSecondaryLine({
  primaryTitle,
  fallbackTitle,
  heading,
  subtitle,
  primaryPath,
  command,
}: {
  primaryTitle: string;
  fallbackTitle: string;
  heading: string | null;
  subtitle: string | null;
  primaryPath: string | null;
  command: string | null;
}): string | null {
  if (heading && subtitle && subtitle !== heading) {
    return subtitle;
  }
  if (primaryPath && !primaryTitle.includes(primaryPath)) {
    return primaryPath;
  }
  if (primaryTitle === fallbackTitle && command) {
    return command;
  }
  return null;
}

type PermissionType = {
  key: 'file' | 'terminal' | 'web' | 'tool';
  icon: LucideIcon;
  pillClass?: string;
};

function permissionTypeFor(kind: string | null): PermissionType {
  const normalized = kind?.trim().toLowerCase() ?? '';
  if (
    ['execute', 'command', 'terminal', 'shell', 'bash'].some((value) =>
      normalized.includes(value)
    )
  ) {
    return {
      key: 'terminal',
      icon: SquareTerminal,
      pillClass: 'permission-capsule-type-pill--terminal',
    };
  }
  if (
    ['file', 'read', 'write', 'edit', 'delete', 'move', 'copy', 'patch'].some(
      (value) => normalized.includes(value)
    )
  ) {
    return {
      key: 'file',
      icon: FileText,
      pillClass: 'permission-capsule-type-pill--file',
    };
  }
  if (
    ['web', 'browser', 'fetch', 'http', 'url'].some((value) =>
      normalized.includes(value)
    )
  ) {
    return {
      key: 'web',
      icon: Globe2,
      pillClass: 'permission-capsule-type-pill--web',
    };
  }
  return { key: 'tool', icon: Wrench };
}

type ParsedDetail = {
  kind: string | null;
  heading: string | null;
  subtitle: string | null;
  primaryPath: string | null;
  command: string | null;
  body: React.ReactNode | null;
};

/** ACP or Native tool-call shape behind a permission request. */
type ToolDetail = {
  kind?: string | null;
  toolName?: string | null;
  tool_name?: string | null;
  title?: string | null;
  reason?: string | null;
  decisionReason?: string | null;
  content?: unknown[] | null;
  locations?: { path?: string }[] | null;
  rawInput?: unknown;
  input?: unknown;
  _meta?: Record<string, unknown> | null;
  fields?: {
    kind?: string | null;
    toolName?: string | null;
    tool_name?: string | null;
    title?: string | null;
    reason?: string | null;
    decisionReason?: string | null;
    content?: unknown[] | null;
    locations?: { path?: string }[] | null;
    rawInput?: unknown;
    input?: unknown;
    _meta?: Record<string, unknown> | null;
  } | null;
};

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pickNonEmptyString(
  obj: Record<string, unknown> | null | undefined,
  key: string
): string | null {
  const value = obj?.[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function inferPermissionKind(
  declaredKind: string | null,
  toolName: string | null,
  effectiveInput: unknown
): string | null {
  const trimmedKind = declaredKind?.trim() ?? '';
  if (trimmedKind && trimmedKind.toLowerCase() !== 'other') {
    return trimmedKind;
  }
  const canonical = (toolName ?? '').replace(/[\s._-]/g, '').toLowerCase();
  if (
    canonical === 'bash' ||
    canonical === 'commandexecution' ||
    canonical === 'shell' ||
    canonical === 'execcommand' ||
    canonical === 'executecommand'
  ) {
    return 'execute';
  }
  if (
    canonical === 'edit' ||
    canonical === 'write' ||
    canonical === 'multiedit' ||
    canonical === 'filechange' ||
    canonical === 'applypatch' ||
    canonical === 'notebookedit'
  ) {
    return 'edit';
  }
  if (
    canonical === 'read' ||
    canonical === 'readfile' ||
    canonical === 'glob' ||
    canonical === 'grep'
  ) {
    return 'read';
  }
  if (canonical === 'webfetch' || canonical === 'websearch') {
    return 'web';
  }
  const inputObj = asObject(effectiveInput);
  if (inputObj) {
    if (
      Array.isArray(inputObj.changes) ||
      'old_string' in inputObj ||
      'new_string' in inputObj ||
      'diff' in inputObj
    ) {
      return 'edit';
    }
    if ('command' in inputObj || 'cmd' in inputObj) {
      return 'execute';
    }
  }
  return trimmedKind || null;
}

function extractShellCommandLabel(
  rawInput: unknown,
  command: string | null
): string | null {
  const obj = asObject(rawInput);
  if (!obj) return null;
  for (const key of ['description', 'title', 'summary', 'reason']) {
    const label = pickNonEmptyString(obj, key);
    if (label && label !== command) {
      return label;
    }
  }
  return null;
}

/**
 * Resolve permission heading & subtitle following Codeg `permission-request.ts`:
 * 1. `_meta.claudeCode.title` (or `_meta.jetbrains.air.commandTitle`)
 * 2. `_meta.permission.title` (or `_meta.jetbrains.air.permission.title`)
 * 3. `toolCall.title` / `request.title`
 *
 * When a candidate is byte-equal to the shell command already rendered in the
 * command block, suppress it as a heading so the command is never printed twice.
 */
function resolvePermissionHeadings(
  record: ToolDetail | null,
  fields: NonNullable<ToolDetail['fields']> | null,
  effectiveInput: unknown,
  requestTitle: string | null | undefined,
  command: string | null
): { heading: string | null; subtitle: string | null } {
  const meta = asObject(record?._meta) ?? asObject(fields?._meta) ?? null;
  const claudeCode = asObject(meta?.claudeCode);
  const air = asObject(asObject(meta?.jetbrains)?.air);
  const permission = asObject(meta?.permission) ?? asObject(air?.permission);

  const claudeTitle =
    pickNonEmptyString(claudeCode, 'title') ??
    pickNonEmptyString(air, 'commandTitle');
  const permissionTitle = pickNonEmptyString(permission, 'title');
  const metaHeadingRaw = claudeTitle ?? permissionTitle ?? null;

  const metaHeading =
    metaHeadingRaw !== null && command !== null && metaHeadingRaw === command
      ? extractShellCommandLabel(effectiveInput, command)
      : metaHeadingRaw;

  const toolCallTitle =
    pickNonEmptyString(fields as Record<string, unknown> | null, 'title') ??
    pickNonEmptyString(record as Record<string, unknown> | null, 'title') ??
    pickNonEmptyString(fields as Record<string, unknown> | null, 'reason') ??
    pickNonEmptyString(record as Record<string, unknown> | null, 'reason');
  const trimmedRequestTitle =
    typeof requestTitle === 'string' && requestTitle.trim().length > 0
      ? requestTitle.trim()
      : null;

  if (metaHeading) {
    return {
      heading: metaHeading,
      subtitle: null,
    };
  }

  const fallbackCandidate = trimmedRequestTitle ?? toolCallTitle;
  const subtitle =
    fallbackCandidate !== null &&
    command !== null &&
    fallbackCandidate === command
      ? extractShellCommandLabel(effectiveInput, command)
      : fallbackCandidate;

  return {
    heading: null,
    subtitle,
  };
}

type ExtractedInputDiff = {
  path: string;
  oldText?: string;
  newText?: string;
  unifiedDiff?: string;
};

function extractInputDiffs(rawInput: unknown): ExtractedInputDiff[] {
  const input = asObject(rawInput);
  if (!input) return [];

  if (Array.isArray(input.changes)) {
    const out: ExtractedInputDiff[] = [];
    for (const item of input.changes) {
      const change = asObject(item);
      if (!change) continue;
      const path =
        pickNonEmptyString(change, 'path') ??
        pickNonEmptyString(change, 'file_path') ??
        pickNonEmptyString(change, 'filePath') ??
        '(file)';
      const unifiedDiff =
        pickNonEmptyString(change, 'diff') ??
        pickNonEmptyString(change, 'patch') ??
        pickNonEmptyString(change, 'unified_diff');
      const oldText =
        typeof change.oldText === 'string'
          ? change.oldText
          : typeof change.old_string === 'string'
            ? change.old_string
            : undefined;
      const newText =
        typeof change.newText === 'string'
          ? change.newText
          : typeof change.new_string === 'string'
            ? change.new_string
            : typeof change.content === 'string'
              ? change.content
              : undefined;
      if (unifiedDiff) {
        out.push({ path, unifiedDiff });
      } else if (oldText !== undefined || newText !== undefined) {
        out.push({ path, oldText: oldText ?? '', newText: newText ?? '' });
      }
    }
    if (out.length > 0) return out;
  }

  const filePath =
    pickNonEmptyString(input, 'file_path') ??
    pickNonEmptyString(input, 'filePath') ??
    pickNonEmptyString(input, 'path') ??
    pickNonEmptyString(input, 'target_file');
  if (!filePath) return [];

  const unifiedDiff =
    pickNonEmptyString(input, 'diff') ??
    pickNonEmptyString(input, 'patch') ??
    pickNonEmptyString(input, 'unified_diff');
  if (unifiedDiff) {
    return [{ path: filePath, unifiedDiff }];
  }

  const oldText =
    typeof input.old_string === 'string'
      ? input.old_string
      : typeof input.oldText === 'string'
        ? input.oldText
        : undefined;
  const newText =
    typeof input.new_string === 'string'
      ? input.new_string
      : typeof input.newText === 'string'
        ? input.newText
        : typeof input.content === 'string'
          ? input.content
          : undefined;
  if (oldText !== undefined || newText !== undefined) {
    return [
      {
        path: filePath,
        oldText: oldText ?? '',
        newText: newText ?? '',
      },
    ];
  }

  return [];
}

/** Faithfully render whatever the agent actually sent — never fabricate. */
function parseToolDetail(
  details: unknown,
  requestTitle?: string | null
): ParsedDetail {
  if (!details || typeof details !== 'object') {
    const trimmedTitle =
      typeof requestTitle === 'string' && requestTitle.trim().length > 0
        ? requestTitle.trim()
        : null;
    const reasonText =
      typeof details === 'string' && details.trim().length > 0
        ? details.trim()
        : null;
    return {
      kind: inferPermissionKind(null, trimmedTitle, null),
      heading: null,
      subtitle: trimmedTitle,
      primaryPath: null,
      command: null,
      body: reasonText ? (
        <pre className="overflow-x-auto whitespace-pre-wrap rounded-md border border-[var(--border-subtle)] bg-[var(--surface-content)] px-2.5 py-1.5 font-mono text-xs text-foreground">
          {reasonText}
        </pre>
      ) : null,
    };
  }
  const record = details as ToolDetail;
  const fields =
    record.fields && typeof record.fields === 'object' ? record.fields : record;
  const effectiveInput =
    fields?.rawInput ??
    fields?.input ??
    record.rawInput ??
    record.input ??
    fields;
  const declaredKind =
    typeof fields?.kind === 'string'
      ? fields.kind
      : typeof record.kind === 'string'
        ? record.kind
        : null;
  const toolName =
    pickNonEmptyString(fields as Record<string, unknown> | null, 'toolName') ??
    pickNonEmptyString(fields as Record<string, unknown> | null, 'tool_name') ??
    pickNonEmptyString(record as Record<string, unknown> | null, 'toolName') ??
    pickNonEmptyString(record as Record<string, unknown> | null, 'tool_name') ??
    (typeof requestTitle === 'string' && requestTitle.trim().length > 0
      ? requestTitle.trim()
      : null);
  const kind = inferPermissionKind(declaredKind, toolName, effectiveInput);
  const command = extractCommand(effectiveInput);
  const { heading, subtitle } = resolvePermissionHeadings(
    record,
    fields,
    effectiveInput,
    requestTitle,
    command
  );
  const blocks: React.ReactNode[] = [];
  let primaryPath: string | null = null;

  // 1) Content blocks (diffs, text, terminal output) carry the richest preview.
  const content = Array.isArray(fields?.content) ? fields!.content! : [];
  content.forEach((raw, index) => {
    const block = raw as Record<string, unknown>;
    if (block?.type === 'diff') {
      const path = typeof block.path === 'string' ? block.path : '(file)';
      if (!primaryPath && path !== '(file)') primaryPath = path;
      blocks.push(
        <DiffPreview
          key={`diff-${index}`}
          path={path}
          oldText={typeof block.oldText === 'string' ? block.oldText : ''}
          newText={typeof block.newText === 'string' ? block.newText : ''}
        />
      );
      return;
    }
    const text = extractText(block);
    if (text) {
      blocks.push(
        <pre
          key={`text-${index}`}
          className="overflow-x-auto whitespace-pre-wrap rounded-md border border-[var(--border-subtle)] bg-[var(--surface-content)] px-2.5 py-1.5 font-mono text-xs text-foreground"
        >
          {text}
        </pre>
      );
    }
  });

  // 2) Native input diff previews (`input.changes` or `input.{file_path, old_string, new_string}`)
  // when no ACP `content` diff block was attached.
  if (blocks.length === 0) {
    const inputDiffs = extractInputDiffs(effectiveInput);
    inputDiffs.forEach((item, index) => {
      if (!primaryPath && item.path !== '(file)') primaryPath = item.path;
      blocks.push(
        <DiffPreview
          key={`input-diff-${index}`}
          path={item.path}
          oldText={item.oldText ?? ''}
          newText={item.newText ?? ''}
          unifiedDiff={item.unifiedDiff}
        />
      );
    });
  }

  // 3) Command preview from rawInput/input when no content block surfaced one.
  if (blocks.length === 0 && command) {
    blocks.push(
      <CommandWell key="command" command={command} toolName={toolName} />
    );
  }

  // 4) File locations.
  const locations = Array.isArray(fields?.locations) ? fields!.locations! : [];
  const paths = locations
    .map((loc) => loc?.path)
    .filter((p): p is string => typeof p === 'string' && p.length > 0);
  if (!primaryPath && paths.length > 0) {
    primaryPath = paths[0];
  }
  if (paths.length > 0) {
    blocks.push(
      <ul
        key="locations"
        className="mt-1 space-y-0.5 text-xs text-muted-foreground"
      >
        {paths.map((p) => (
          <li key={p} className="truncate font-mono">
            {p}
          </li>
        ))}
      </ul>
    );
  }

  return {
    kind,
    heading,
    subtitle,
    primaryPath,
    command,
    body:
      blocks.length > 0 ? <div className="space-y-1.5">{blocks}</div> : null,
  };
}

function CommandWell({
  command,
  toolName,
}: {
  command: string;
  toolName: string | null;
}) {
  const { t } = useTranslation(['conversation', 'common']);
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(command).then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      });
    }
  };

  return (
    <div className="permission-capsule-code-well">
      <div className="permission-capsule-code-head">
        <span className="truncate font-mono">{toolName || 'Command'}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-[var(--surface-control-hover)] hover:text-foreground"
        >
          {copied ? (
            <Check className="h-3 w-3" aria-hidden="true" />
          ) : (
            <Copy className="h-3 w-3" aria-hidden="true" />
          )}
          <span>
            {copied
              ? t('permissionRequestCard.copied')
              : t('permissionRequestCard.copy')}
          </span>
        </button>
      </div>
      <div className="permission-capsule-cmd-row">
        <span className="permission-capsule-cmd-prompt">$</span>
        <code className="min-w-0 flex-1 whitespace-pre-wrap break-words">
          {command}
        </code>
      </div>
    </div>
  );
}

function extractText(block: Record<string, unknown>): string | null {
  if (typeof block?.text === 'string') return block.text;
  const inner = block?.content as Record<string, unknown> | undefined;
  if (inner && typeof inner.text === 'string') return inner.text;
  return null;
}

function extractCommand(rawInput: unknown): string | null {
  if (!rawInput || typeof rawInput !== 'object') return null;
  const input = rawInput as Record<string, unknown>;
  for (const key of [
    'command',
    'cmd',
    'script',
    'commandLine',
    'command_line',
    'parsedCmd',
  ]) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value;
    if (Array.isArray(value)) {
      const parts = value.filter((v): v is string => typeof v === 'string');
      if (parts.length > 0) return parts.join(' ');
    }
  }
  return null;
}

function DiffPreview({
  path,
  oldText,
  newText,
  unifiedDiff,
}: {
  path: string;
  oldText: string;
  newText: string;
  unifiedDiff?: string;
}) {
  const { t } = useTranslation(['conversation', 'common']);
  const [open, setOpen] = useState(true);
  const isNew = !unifiedDiff && !oldText;
  return (
    <div className="permission-capsule-code-well">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="permission-capsule-code-head w-full text-left"
        aria-expanded={open}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <ChevronRight
            className={cn(
              'h-3 w-3 shrink-0 transition-transform',
              open && 'rotate-90'
            )}
          />
          <span className="truncate font-mono text-foreground">{path}</span>
        </span>
        <span className="shrink-0 text-muted-foreground">
          {isNew
            ? t('permissionRequestCard.newFile')
            : t('permissionRequestCard.modified')}
        </span>
      </button>
      {open ? (
        <div className="space-y-1.5 p-2">
          {unifiedDiff ? (
            <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded border border-[var(--border-subtle)] bg-[var(--surface-topbar)] px-2 py-1.5 font-mono text-[11px] text-foreground">
              {unifiedDiff}
            </pre>
          ) : (
            <>
              {!isNew ? (
                <DiffPane
                  label={t('permissionRequestCard.before')}
                  text={oldText}
                  tone="del"
                />
              ) : null}
              <DiffPane
                label={
                  isNew
                    ? t('permissionRequestCard.content')
                    : t('permissionRequestCard.after')
                }
                text={newText}
                tone="add"
              />
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function DiffPane({
  label,
  text,
  tone,
}: {
  label: string;
  text: string;
  tone: 'add' | 'del';
}) {
  return (
    <div>
      <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <pre
        className={cn(
          'max-h-52 overflow-auto whitespace-pre-wrap rounded border px-2 py-1.5 font-mono text-[11px]',
          tone === 'del'
            ? 'border-destructive/25 bg-destructive/5 text-destructive'
            : 'border-success/25 bg-success/5 text-success'
        )}
      >
        {text}
      </pre>
    </div>
  );
}
