import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSessionControlsSnapshot } from 'shared/types';
import {
  composerSessionControlDisplay,
  invalidateAgentSessionControlsCaches,
  liveSessionControlsSnapshot,
  loadAgentSessionControlsCatalog,
  mergeCreateSessionControls,
  preferSessionControlValues,
  publishLiveSessionControls,
  sessionControlsQueryKey,
  sessionControlsSchemaQueryKey,
} from './sessionControlsQuery';

const capabilityCatalog = vi.fn();
const refreshCapabilityCatalog = vi.fn();

vi.mock('./api', () => ({
  agentsApi: {
    capabilityCatalog: (...args: unknown[]) => capabilityCatalog(...args),
    refreshCapabilityCatalog: (...args: unknown[]) =>
      refreshCapabilityCatalog(...args),
  },
}));

const CONTROLS: AgentSessionControlsSnapshot = {
  modes: [{ id: 'plan', label: 'Plan', description: null }],
  current_mode: 'plan',
  config_options: [],
};

describe('session controls query cache', () => {
  it('reuses live composer controls only within the same agent and workspace', () => {
    const client = new QueryClient();

    publishLiveSessionControls(client, {
      agentType: 'codex',
      workspaceId: 'workspace-1',
      controls: CONTROLS,
    });

    expect(
      client.getQueryData(sessionControlsQueryKey('codex', 'workspace-1'))
    ).toEqual(CONTROLS);
    expect(
      client.getQueryData(sessionControlsQueryKey('codex', 'workspace-2'))
    ).toBeUndefined();
    expect(
      client.getQueryData(sessionControlsQueryKey('claude_code', 'workspace-1'))
    ).toBeUndefined();
  });

  it('publishes an agent-wide schema so every create surface sees live options', () => {
    const client = new QueryClient();
    const withEffort: AgentSessionControlsSnapshot = {
      modes: CONTROLS.modes,
      current_mode: 'plan',
      config_options: [
        {
          key: 'reasoning_effort',
          label: '思考强度',
          category: 'thought_level',
          value: 'high',
          choices: [
            { value: 'low', label: '低' },
            { value: 'high', label: '高' },
          ],
        },
      ],
    };

    publishLiveSessionControls(client, {
      agentType: 'codex',
      workspaceId: 'workspace-1',
      controls: withEffort,
    });

    expect(client.getQueryData(sessionControlsSchemaQueryKey('codex'))).toEqual(
      withEffort
    );
    expect(
      client.getQueryData(sessionControlsSchemaQueryKey('claude_code'))
    ).toBeUndefined();
  });

  it('replaces stale schema choices with the newest live controls', () => {
    const client = new QueryClient();
    const modelWith = (values: string[]): AgentSessionControlsSnapshot => ({
      modes: [],
      current_mode: null,
      config_options: [
        {
          key: 'model',
          label: 'Model',
          category: 'model',
          value: values[0],
          choices: values.map((value) => ({ value, label: value })),
        },
      ],
    });

    publishLiveSessionControls(client, {
      agentType: 'omp',
      workspaceId: 'workspace-1',
      controls: modelWith(['dimo/opus', 'antigravity/gemini']),
    });
    publishLiveSessionControls(client, {
      agentType: 'omp',
      workspaceId: 'workspace-1',
      controls: modelWith(['dimo/opus']),
    });

    const schema = client.getQueryData<AgentSessionControlsSnapshot>(
      sessionControlsSchemaQueryKey('omp')
    );
    expect(
      schema?.config_options[0].choices?.map((choice) => choice.value)
    ).toEqual(['dimo/opus']);
  });

  it('normalizes null or undefined agentType without throwing during disabled query key evaluation', () => {
    expect(sessionControlsQueryKey(null, null)).toEqual([
      'agent-session-controls-catalog',
      '',
      null,
    ]);
    expect(sessionControlsQueryKey(undefined, 'workspace-1')).toEqual([
      'agent-session-controls-catalog',
      '',
      'workspace-1',
    ]);
    expect(sessionControlsSchemaQueryKey(null)).toEqual([
      'agent-session-controls-schema',
      '',
    ]);
  });
});

describe('composerSessionControlDisplay', () => {
  const catalog: AgentSessionControlsSnapshot = {
    modes: [
      { id: 'plan', label: 'Plan', description: null },
      { id: 'agent', label: 'Agent', description: null },
    ],
    current_mode: 'plan',
    config_options: [
      {
        key: 'model',
        label: 'Model',
        category: 'model',
        value: 'grok-4',
        choices: [{ value: 'grok-4', label: 'Grok 4' }],
      },
    ],
  };

  it('uses the create-form catalog when the conversation has no ACP controls yet', () => {
    expect(
      composerSessionControlDisplay([
        liveSessionControlsSnapshot({ current: null, modes: [] }, []),
        catalog,
      ])
    ).toEqual({
      sessionModes: {
        current: 'plan',
        modes: catalog.modes,
      },
      sessionConfigOptions: catalog.config_options,
    });
  });

  it('keeps live conversation controls over the catalog once ACP has advertised them', () => {
    const live = liveSessionControlsSnapshot(
      {
        current: 'agent',
        modes: catalog.modes,
      },
      [
        {
          key: 'model',
          label: 'Model',
          category: 'model',
          value: 'grok-4-fast',
          choices: [
            { value: 'grok-4', label: 'Grok 4' },
            { value: 'grok-4-fast', label: 'Grok 4 Fast' },
          ],
        },
      ]
    );

    expect(composerSessionControlDisplay([live, catalog])).toEqual({
      sessionModes: {
        current: 'agent',
        modes: catalog.modes,
      },
      sessionConfigOptions: [
        {
          key: 'model',
          label: 'Model',
          category: 'model',
          value: 'grok-4-fast',
          choices: [
            { value: 'grok-4', label: 'Grok 4' },
            { value: 'grok-4-fast', label: 'Grok 4 Fast' },
          ],
        },
      ],
    });
  });

  it('renders nothing when neither the conversation nor the catalog has controls', () => {
    expect(composerSessionControlDisplay([null, undefined])).toEqual({
      sessionModes: { current: null, modes: [] },
      sessionConfigOptions: [],
    });
  });
});

describe('mergeCreateSessionControls', () => {
  it('adds live effort and fast options onto a catalog that only has model', () => {
    const catalog: AgentSessionControlsSnapshot = {
      modes: [{ id: 'auto', label: 'Auto', description: null }],
      current_mode: 'auto',
      config_options: [
        {
          key: 'model',
          label: 'Model',
          category: 'model',
          value: 'gpt-6-astra',
          choices: [{ value: 'gpt-6-astra', label: 'gpt-6-astra' }],
        },
      ],
    };
    const live: AgentSessionControlsSnapshot = {
      modes: [
        { id: 'auto', label: 'Auto', description: null },
        { id: 'agent-full-access', label: '完全访问', description: null },
      ],
      current_mode: 'agent-full-access',
      config_options: [
        {
          key: 'model',
          label: 'Model',
          category: 'model',
          value: 'other-model',
          choices: [
            { value: 'gpt-6-astra', label: 'gpt-6-astra' },
            { value: 'other-model', label: 'other-model' },
          ],
        },
        {
          key: 'reasoning_effort',
          label: '思考强度',
          category: 'thought_level',
          value: 'high',
          choices: [
            { value: 'low', label: '低' },
            { value: 'high', label: '高' },
          ],
        },
        {
          key: 'fast_mode',
          label: 'Fast',
          category: 'model_config',
          value: false,
          choices: [
            { value: false, label: 'Off' },
            { value: true, label: 'On' },
          ],
        },
      ],
    };

    const merged = mergeCreateSessionControls([catalog, live]);
    expect(merged?.current_mode).toBe('auto');
    expect(merged?.config_options.map((option) => option.key)).toEqual([
      'model',
      'reasoning_effort',
      'fast_mode',
    ]);
    expect(
      merged?.config_options.find((option) => option.key === 'model')?.value
    ).toBe('gpt-6-astra');
  });

  it('does not keep a second reasoning-effort option from a later snapshot', () => {
    const catalog: AgentSessionControlsSnapshot = {
      modes: [],
      current_mode: null,
      config_options: [
        {
          key: 'model',
          label: 'Model',
          category: 'model',
          value: 'grok-4.6',
          choices: [{ value: 'grok-4.6', label: 'Grok 4.6' }],
        },
        {
          key: 'effort',
          label: '推理强度',
          category: 'thought_level',
          value: 'high',
          choices: [{ value: 'high', label: 'High Effort' }],
        },
      ],
    };
    const live: AgentSessionControlsSnapshot = {
      modes: [],
      current_mode: null,
      config_options: [
        {
          key: 'model',
          label: 'Model',
          category: 'model',
          value: 'grok-4.6',
          choices: [{ value: 'grok-4.6', label: 'Grok 4.6' }],
        },
        {
          key: 'reasoning_effort',
          label: 'Reasoning Effort',
          category: 'thought_level',
          value: 'high',
          choices: [{ value: 'high', label: 'High' }],
        },
      ],
    };

    const merged = mergeCreateSessionControls([live, catalog]);
    expect(merged?.config_options.map((option) => option.key)).toEqual([
      'model',
      'reasoning_effort',
    ]);
  });
});

describe('loadAgentSessionControlsCatalog', () => {
  beforeEach(() => {
    capabilityCatalog.mockReset();
    refreshCapabilityCatalog.mockReset();
  });

  it('returns a matching persisted catalog without probing', async () => {
    capabilityCatalog.mockResolvedValue(CONTROLS);

    await expect(loadAgentSessionControlsCatalog('grok')).resolves.toEqual(
      CONTROLS
    );
    expect(refreshCapabilityCatalog).not.toHaveBeenCalled();
  });

  it('returns null without blocking on refreshCapabilityCatalog when no catalog is cached yet', async () => {
    capabilityCatalog.mockResolvedValue(null);

    await expect(
      loadAgentSessionControlsCatalog('antigravity')
    ).resolves.toBeNull();
    expect(capabilityCatalog).toHaveBeenCalledWith('antigravity');
    expect(refreshCapabilityCatalog).not.toHaveBeenCalled();
  });

  it('returns null without calling IPC when agentType is empty', async () => {
    await expect(loadAgentSessionControlsCatalog('')).resolves.toBeNull();
    expect(capabilityCatalog).not.toHaveBeenCalled();
    expect(refreshCapabilityCatalog).not.toHaveBeenCalled();
  });
});

describe('preferSessionControlValues & invalidateAgentSessionControlsCaches', () => {
  it('keeps catalog current_mode over stale workspace live current_mode while preserving offered config values', () => {
    const catalog: AgentSessionControlsSnapshot = {
      modes: [
        { id: 'default', label: 'Default', description: null },
        { id: 'bypassPermissions', label: 'Bypass', description: null },
      ],
      current_mode: 'bypassPermissions',
      config_options: [
        {
          key: 'effort',
          label: 'Effort',
          category: 'thought_level',
          value: 'high',
          choices: [
            { value: 'low', label: 'Low' },
            { value: 'high', label: 'High' },
          ],
        },
      ],
    };
    const staleWorkspaceLive: AgentSessionControlsSnapshot = {
      modes: catalog.modes,
      current_mode: 'default',
      config_options: [
        {
          key: 'effort',
          label: 'Effort',
          category: 'thought_level',
          value: 'low',
          choices: [
            { value: 'low', label: 'Low' },
            { value: 'high', label: 'High' },
          ],
        },
      ],
    };

    const resolved = preferSessionControlValues(catalog, staleWorkspaceLive);
    expect(resolved?.current_mode).toBe('bypassPermissions');
    expect(
      resolved?.config_options.find((opt) => opt.key === 'effort')?.value
    ).toBe('low');
  });

  it('removes workspace live and schema caches when native config changes', () => {
    const client = new QueryClient();
    publishLiveSessionControls(client, {
      agentType: 'claude_code',
      workspaceId: 'workspace-1',
      controls: CONTROLS,
    });
    client.setQueryData(sessionControlsQueryKey('claude_code', null), CONTROLS);

    invalidateAgentSessionControlsCaches(client, 'claude_code');

    expect(
      client.getQueryData(sessionControlsQueryKey('claude_code', 'workspace-1'))
    ).toBeUndefined();
    expect(
      client.getQueryData(sessionControlsSchemaQueryKey('claude_code'))
    ).toBeUndefined();
    expect(
      client.getQueryState(sessionControlsQueryKey('claude_code', null))
        ?.isInvalidated
    ).toBe(true);
  });
});
