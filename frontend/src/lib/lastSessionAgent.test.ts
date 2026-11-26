import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutorConfigs, ExecutorProfileId } from 'shared/types';
import type { SelectableAgent } from '@/features/agents/useSelectableAgents';

const persistFrontendPreference = vi.hoisted(() => vi.fn());

vi.mock('@/lib/frontendPreferences', () => ({
  persistFrontendPreference,
}));

import {
  LAST_SESSION_AGENT_KEY,
  clearLastSessionAgent,
  getLastSessionAgent,
  recordLastSessionAgent,
  resolveNewSessionExecutorProfile,
  subscribeLastSessionAgent,
} from './lastSessionAgent';

function selectableAgent(
  agentId: string,
  overrides: Partial<SelectableAgent> = {}
): SelectableAgent {
  return {
    agentId,
    displayName: agentId,
    iconLight: null,
    iconDark: null,
    iconSvg: null,
    enabled: true,
    lifecycle: 'ready',
    runnable: true,
    settingsFeatures: [],
    ...overrides,
  };
}

const PROFILES = {
  claude_code: { DEFAULT: {} },
  codex: { DEFAULT: {} },
  gemini: { FAST: {} },
} as unknown as ExecutorConfigs['executors'];

const DEFAULT_USER_PROFILE: ExecutorProfileId = {
  executor: 'claude_code',
  variant: null,
};

describe('lastSessionAgent', () => {
  beforeEach(() => {
    persistFrontendPreference.mockReset();
    localStorage.clear();
    clearLastSessionAgent();
  });

  it('defaults to null and persists recorded agent updates', () => {
    expect(getLastSessionAgent()).toBeNull();

    const listener = vi.fn();
    const unsubscribe = subscribeLastSessionAgent(listener);

    recordLastSessionAgent('  codex  ');
    expect(getLastSessionAgent()).toBe('codex');
    expect(localStorage.getItem(LAST_SESSION_AGENT_KEY)).toBe('codex');
    expect(persistFrontendPreference).toHaveBeenCalledWith(
      LAST_SESSION_AGENT_KEY,
      'codex'
    );
    expect(listener).toHaveBeenCalledTimes(1);

    // Repeating the same agent or passing empty values is a no-op.
    recordLastSessionAgent('codex');
    recordLastSessionAgent('');
    recordLastSessionAgent('   ');
    recordLastSessionAgent(null);
    expect(persistFrontendPreference).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
  });

  it('syncs updates received via window storage events', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeLastSessionAgent(listener);

    localStorage.setItem(LAST_SESSION_AGENT_KEY, 'gemini');
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: LAST_SESSION_AGENT_KEY,
        newValue: 'gemini',
      })
    );

    expect(getLastSessionAgent()).toBe('gemini');
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
  });
});

describe('resolveNewSessionExecutorProfile', () => {
  it('uses the last created session agent when available and runnable', () => {
    const profile = resolveNewSessionExecutorProfile({
      lastSessionAgent: 'codex',
      configExecutorProfile: DEFAULT_USER_PROFILE,
      profiles: PROFILES,
      selectableAgents: [
        selectableAgent('claude_code'),
        selectableAgent('codex'),
      ],
    });

    expect(profile).toEqual({ executor: 'codex', variant: null });
  });

  it('supports custom/open AgentIds not present in static profiles', () => {
    const profile = resolveNewSessionExecutorProfile({
      lastSessionAgent: 'vendor.custom_agent',
      configExecutorProfile: DEFAULT_USER_PROFILE,
      profiles: PROFILES,
      selectableAgents: [
        selectableAgent('claude_code'),
        selectableAgent('vendor.custom_agent'),
      ],
    });

    expect(profile).toEqual({
      executor: 'vendor.custom_agent',
      variant: null,
    });
  });

  it('uses the last session agent before selectableAgents finishes loading', () => {
    const profile = resolveNewSessionExecutorProfile({
      lastSessionAgent: 'gemini',
      configExecutorProfile: DEFAULT_USER_PROFILE,
      profiles: PROFILES,
      selectableAgents: [],
    });

    expect(profile).toEqual({ executor: 'gemini', variant: 'FAST' });
  });

  it('preserves user configured variant when last session agent matches user default', () => {
    const configured: ExecutorProfileId = {
      executor: 'codex',
      variant: 'HIGH',
    };

    const profile = resolveNewSessionExecutorProfile({
      lastSessionAgent: 'codex',
      configExecutorProfile: configured,
      profiles: PROFILES,
      selectableAgents: [selectableAgent('codex')],
    });

    expect(profile).toBe(configured);
  });

  it('matches canonical agentId case-insensitively against selectableAgents', () => {
    const profile = resolveNewSessionExecutorProfile({
      lastSessionAgent: 'CODEX',
      configExecutorProfile: DEFAULT_USER_PROFILE,
      profiles: PROFILES,
      selectableAgents: [
        selectableAgent('claude_code'),
        selectableAgent('codex'),
      ],
    });

    expect(profile).toEqual({ executor: 'codex', variant: null });
  });

  it('falls back to user default agent when no last session agent is recorded', () => {
    const profile = resolveNewSessionExecutorProfile({
      lastSessionAgent: null,
      configExecutorProfile: DEFAULT_USER_PROFILE,
      profiles: PROFILES,
      selectableAgents: [
        selectableAgent('claude_code'),
        selectableAgent('codex'),
      ],
    });

    expect(profile).toBe(DEFAULT_USER_PROFILE);
  });

  it('falls back to user default agent when last session agent is disabled, uninstalled, not runnable, or missing', () => {
    const cases: SelectableAgent[][] = [
      [
        selectableAgent('claude_code'),
        selectableAgent('codex', { enabled: false }),
      ],
      [
        selectableAgent('claude_code'),
        selectableAgent('codex', { lifecycle: 'uninstalled', runnable: false }),
      ],
      [
        selectableAgent('claude_code'),
        selectableAgent('codex', { lifecycle: 'needs_auth', runnable: false }),
      ],
      [selectableAgent('claude_code')],
    ];

    for (const selectableAgents of cases) {
      const profile = resolveNewSessionExecutorProfile({
        lastSessionAgent: 'codex',
        configExecutorProfile: DEFAULT_USER_PROFILE,
        profiles: PROFILES,
        selectableAgents,
      });

      expect(profile).toBe(DEFAULT_USER_PROFILE);
    }
  });

  it('falls back to first available profile when both last session agent and user default are absent', () => {
    const profile = resolveNewSessionExecutorProfile({
      lastSessionAgent: null,
      configExecutorProfile: null,
      profiles: PROFILES,
      selectableAgents: [],
    });

    expect(profile).toEqual({ executor: 'claude_code', variant: null });
  });
});
