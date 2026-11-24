import { describe, expect, it } from 'vitest';
import type { ExecutorConfigs } from 'shared/types';
import {
  areProfilesEqual,
  getDefaultProfileForExecutor,
  getFirstAvailableProfile,
} from './executor';

const profiles = {
  claude_code: {
    DEFAULT: {
      CLAUDE_CODE: {
        append_prompt: null,
        dangerously_skip_permissions: true,
      },
    },
    PLAN: {
      CLAUDE_CODE: {
        append_prompt: null,
        plan: true,
      },
    },
  },
  codex: {
    CUSTOM_ONLY: {
      CODEX: {
        append_prompt: null,
        sandbox: 'danger-full-access',
      },
    },
  },
} as const satisfies ExecutorConfigs['executors'];

describe('executor utilities', () => {
  it('resolves default and first available profiles', () => {
    expect(getDefaultProfileForExecutor('claude_code', profiles)).toEqual({
      executor: 'claude_code',
      variant: null,
    });
    expect(getDefaultProfileForExecutor('codex', profiles)).toEqual({
      executor: 'codex',
      variant: 'CUSTOM_ONLY',
    });
    expect(getFirstAvailableProfile(profiles)).toEqual({
      executor: 'claude_code',
      variant: null,
    });
  });

  it('compares executor profiles treating null and DEFAULT variants equally', () => {
    expect(
      areProfilesEqual(
        { executor: 'claude_code', variant: null },
        { executor: 'claude_code', variant: 'DEFAULT' }
      )
    ).toBe(true);
    expect(
      areProfilesEqual(
        { executor: 'claude_code', variant: 'PLAN' },
        { executor: 'claude_code', variant: null }
      )
    ).toBe(false);
    expect(
      areProfilesEqual(
        { executor: 'claude_code', variant: null, model: 'sonnet' },
        { executor: 'claude_code', variant: null, model: 'opus' }
      )
    ).toBe(false);
  });
});
