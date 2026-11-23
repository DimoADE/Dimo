import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { AgentId } from 'shared/types';
import type { BackendTransport } from '@/lib/backendTransport';
import type { TypeaheadTriggerMatch } from './typeahead-triggers';

export type AgentMention = {
  agent_kind: AgentId;
  display_name: string;
};

export type AgentMentionCandidate = AgentMention & {
  description?: string;
};

type AgentMentionContextValue = {
  candidates: AgentMentionCandidate[];
  loading: boolean;
  capability: 'unknown' | 'supported' | 'unsupported';
};

const AgentMentionContext = createContext<AgentMentionContextValue>({
  candidates: [],
  loading: false,
  capability: 'unknown',
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function delegationCapabilityOn(state: unknown): boolean {
  return isRecord(state) && state.delegation === true;
}

function readCandidates(value: unknown): AgentMentionCandidate[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((candidate) => {
    if (
      !isRecord(candidate) ||
      typeof candidate.agent_id !== 'string' ||
      typeof candidate.display_name !== 'string' ||
      candidate.enabled !== true ||
      candidate.lifecycle !== 'ready'
    ) {
      return [];
    }

    return [
      {
        agent_kind: candidate.agent_id,
        display_name: candidate.display_name,
      },
    ];
  });
}

export function agentMentionCapabilityFromDetail(
  delegationOn: boolean,
  conversationId: string | null | undefined,
  detail: unknown
): AgentMentionContextValue['capability'] {
  if (!delegationOn || !conversationId) return 'unsupported';
  if (!isRecord(detail)) return 'unsupported';
  const binding = detail.active_binding;
  if (binding == null) return 'supported';
  if (isRecord(binding) && binding.delegation_mcp_delivered === true) {
    return 'supported';
  }
  return 'unsupported';
}

export function AgentMentionProvider({
  transport,
  conversationId,
  children,
}: {
  transport: BackendTransport;
  conversationId?: string | null;
  children: ReactNode;
}) {
  const [candidates, setCandidates] = useState<AgentMentionCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [capability, setCapability] =
    useState<AgentMentionContextValue['capability']>('unknown');

  useEffect(() => {
    let active = true;
    setLoading(true);
    setCapability('unknown');
    void transport
      .call('agent_management_bar')
      .then((value) => {
        if (active) setCandidates(readCandidates(value));
      })
      .catch(() => {
        if (active) setCandidates([]);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    void Promise.all([
      conversationId
        ? transport.call('conversation_detail', { conversationId })
        : Promise.resolve(null),
      transport.call('official_product_mcp_state'),
    ])
      .then(([detail, mcpState]) => {
        if (!active) return;
        const delegationOn = delegationCapabilityOn(mcpState);
        setCapability(
          agentMentionCapabilityFromDetail(delegationOn, conversationId, detail)
        );
      })
      .catch(() => {
        if (active) setCapability('unsupported');
      });

    return () => {
      active = false;
    };
  }, [conversationId, transport]);

  const value = useMemo(
    () => ({ candidates, loading, capability }),
    [candidates, capability, loading]
  );

  return (
    <AgentMentionContext.Provider value={value}>
      {children}
    </AgentMentionContext.Provider>
  );
}

export function useAgentMentions(): AgentMentionContextValue {
  return useContext(AgentMentionContext);
}

function escapeMentionLabel(value: string): string {
  return value.replace(/[\\\]]/g, '\\$&');
}

export function serializeAgentMention(mention: AgentMention): string {
  return `[&${escapeMentionLabel(mention.display_name)}](dimo://agent/${encodeURIComponent(
    mention.agent_kind
  )})`;
}

export function isAgentMentionCodeContext(
  source: string,
  offset: number
): boolean {
  const lines = source.slice(0, offset).split('\n');
  let fence: { marker: '`' | '~'; size: number } | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1].charAt(0) as '`' | '~';
      const size = fenceMatch[1].length;
      const trailing = line.slice(fenceMatch[0].length);
      if (!fence) {
        fence = { marker, size };
      } else if (
        fence.marker === marker &&
        size >= fence.size &&
        /^[ \t]*$/.test(trailing)
      ) {
        fence = null;
      }
      continue;
    }

    if (index === lines.length - 1 && !fence) {
      if (/^(?: {4}|\t)/.test(line)) return true;
      let inlineDelimiter = 0;
      for (let cursor = 0; cursor < line.length; ) {
        if (line.charAt(cursor) !== '`') {
          cursor += 1;
          continue;
        }
        let runEnd = cursor + 1;
        while (line.charAt(runEnd) === '`') runEnd += 1;
        const runLength = runEnd - cursor;
        inlineDelimiter =
          inlineDelimiter === runLength
            ? 0
            : inlineDelimiter === 0
              ? runLength
              : inlineDelimiter;
        cursor = runEnd;
      }
      return inlineDelimiter > 0;
    }
  }

  return fence !== null;
}

type CodeFenceState = { marker: '`' | '~'; size: number };

function matchLineFencePrefix(
  source: string,
  lineStart: number,
  lineEnd: number
): {
  marker: '`' | '~';
  size: number;
  prefixEnd: number;
  markerStart: number;
} | null {
  let cursor = lineStart;
  let spaces = 0;
  while (cursor < lineEnd && spaces < 3 && source.charCodeAt(cursor) === 32) {
    cursor += 1;
    spaces += 1;
  }
  if (cursor >= lineEnd) return null;
  const ch = source.charCodeAt(cursor);
  if (ch !== 96 && ch !== 126) return null;
  const markerStart = cursor;
  while (cursor < lineEnd && source.charCodeAt(cursor) === ch) {
    cursor += 1;
  }
  const size = cursor - markerStart;
  if (size < 3) return null;
  return {
    marker: ch === 96 ? '`' : '~',
    size,
    prefixEnd: cursor,
    markerStart,
  };
}

function advanceInlineBackticks(
  source: string,
  from: number,
  limit: number,
  initialDelimiter: number
): { pos: number; delimiter: number; resultAtLimit: boolean } {
  let pos = from;
  let delimiter = initialDelimiter;
  while (pos < limit) {
    const tick = source.indexOf('`', pos);
    if (tick === -1 || tick >= limit) {
      return { pos: limit, delimiter, resultAtLimit: delimiter > 0 };
    }
    let runEnd = tick + 1;
    while (runEnd < source.length && source.charCodeAt(runEnd) === 96) {
      runEnd += 1;
    }
    if (runEnd > limit) {
      const partialLen = limit - tick;
      const tempDelimiter =
        delimiter === partialLen ? 0 : delimiter === 0 ? partialLen : delimiter;
      return { pos: tick, delimiter, resultAtLimit: tempDelimiter > 0 };
    }
    const runLength = runEnd - tick;
    delimiter =
      delimiter === runLength ? 0 : delimiter === 0 ? runLength : delimiter;
    pos = runEnd;
  }
  return { pos, delimiter, resultAtLimit: delimiter > 0 };
}

/**
 * Stateful O(N) equivalent of `isAgentMentionCodeContext(source, offset)` for
 * monotonically non-decreasing `offset` queries across `source`.
 */
export function createAgentMentionCodeContextScanner(
  source: string
): (offset: number) => boolean {
  const len = source.length;
  let fence: CodeFenceState | null = null;
  let lineStart = 0;
  let lineEnd = -1;
  let lineKind: 'normal' | 'fence-open' | 'fence-close' | 'indented' = 'normal';
  let fencePrefixEnd = 0;
  let closingWhitespaceEnd = 0;
  let nextLineFence: CodeFenceState | null = null;
  let indentEnd = Number.POSITIVE_INFINITY;
  let inlinePos = 0;
  let inlineDelimiter = 0;
  let initialized = false;

  const initLine = (start: number) => {
    lineStart = start;
    const nl = source.indexOf('\n', start);
    lineEnd = nl === -1 ? len : nl;
    inlinePos = start;
    inlineDelimiter = 0;
    indentEnd = Number.POSITIVE_INFINITY;

    const matched = matchLineFencePrefix(source, lineStart, lineEnd);
    if (matched) {
      if (!fence) {
        fencePrefixEnd = matched.markerStart + 3;
        lineKind = 'fence-open';
        nextLineFence = { marker: matched.marker, size: matched.size };
        return;
      }
      if (fence.marker === matched.marker && matched.size >= fence.size) {
        fencePrefixEnd = matched.markerStart + fence.size;
        let ws = matched.prefixEnd;
        while (
          ws < lineEnd &&
          (source.charCodeAt(ws) === 32 || source.charCodeAt(ws) === 9)
        ) {
          ws += 1;
        }
        closingWhitespaceEnd = ws;
        lineKind = 'fence-close';
        nextLineFence = ws === lineEnd ? null : fence;
        return;
      }
    }

    lineKind = 'normal';
    nextLineFence = fence;
    if (!fence && lineStart < lineEnd) {
      const first = source.charCodeAt(lineStart);
      if (first === 9) {
        lineKind = 'indented';
        indentEnd = lineStart + 1;
      } else if (
        first === 32 &&
        lineStart + 4 <= lineEnd &&
        source.charCodeAt(lineStart + 1) === 32 &&
        source.charCodeAt(lineStart + 2) === 32 &&
        source.charCodeAt(lineStart + 3) === 32
      ) {
        lineKind = 'indented';
        indentEnd = lineStart + 4;
      }
    }
  };

  return (offset: number): boolean => {
    const clamped = Math.max(0, Math.min(offset, len));
    if (!initialized) {
      initialized = true;
      initLine(0);
    } else if (clamped < lineStart) {
      // Fallback for non-monotonic callers
      return isAgentMentionCodeContext(source, clamped);
    }

    while (clamped > lineEnd) {
      fence = nextLineFence;
      initLine(lineEnd + 1);
    }

    if (lineKind === 'fence-open') {
      if (clamped >= fencePrefixEnd) return true;
      const step = advanceInlineBackticks(
        source,
        inlinePos,
        clamped,
        inlineDelimiter
      );
      inlinePos = step.pos;
      inlineDelimiter = step.delimiter;
      return step.resultAtLimit;
    }

    if (lineKind === 'fence-close') {
      if (clamped < fencePrefixEnd) return true;
      if (clamped <= closingWhitespaceEnd) return false;
      return true;
    }

    if (fence !== null) return true;

    if (lineKind === 'indented' && clamped >= indentEnd) {
      return true;
    }

    const step = advanceInlineBackticks(
      source,
      inlinePos,
      clamped,
      inlineDelimiter
    );
    inlinePos = step.pos;
    inlineDelimiter = step.delimiter;
    return step.resultAtLimit;
  };
}

export function matchAgentMentionTrigger(
  text: string
): TypeaheadTriggerMatch | null {
  const match = /(?:^|[\s([{])&([^\s&]*)$/.exec(text);
  if (!match) return null;

  const triggerOffset = match.index + match[0].indexOf('&');
  if (isAgentMentionCodeContext(text, triggerOffset)) return null;
  return {
    leadOffset: triggerOffset,
    matchingString: match[1],
    replaceableString: match[0].slice(match[0].indexOf('&')),
  };
}
