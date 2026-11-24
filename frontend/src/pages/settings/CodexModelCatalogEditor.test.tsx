import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { CodexModelCatalogConfigRequest } from 'shared/types';

import { CodexModelConfigFields } from './CodexModelCatalogEditor';

describe('CodexModelConfigFields', () => {
  it('keeps focus while typing a custom model id', async () => {
    const user = userEvent.setup();
    function Harness() {
      const [draft, setDraft] = useState<CodexModelCatalogConfigRequest>({
        customs: [
          {
            slug: 'custom-model-1',
            display_name: null,
            context_window: null,
            base: 'gpt-official',
            overrides: null,
          },
        ],
        excluded_officials: [],
        default_model: null,
      });
      return (
        <CodexModelConfigFields
          catalog={{
            agent_id: 'codex',
            source: 'live',
            models: [
              {
                id: 'gpt-official',
                label: 'GPT Official',
                context_window: null,
                reasoning_levels: [],
              },
            ],
            default_model: null,
            error: null,
          }}
          defaultModels={[
            {
              id: 'gpt-5.5',
              label: 'GPT-5.5',
              context_window: null,
              reasoning_levels: [],
            },
          ]}
          disabled={false}
          draft={draft}
          showOfficialModels={false}
          onChange={setDraft}
        />
      );
    }

    render(<Harness />);
    const modelId = screen.getByLabelText('自定义模型 1 模型 ID');
    await user.click(modelId);
    await user.keyboard('a');
    expect(screen.getByLabelText('自定义模型 1 模型 ID')).toHaveFocus();
    expect(screen.getByLabelText('自定义模型 1 模型 ID')).toHaveValue(
      'custom-model-1a'
    );
  });

  it('includes custom models in the default model picker', async () => {
    const user = userEvent.setup();
    render(
      <CodexModelConfigFields
        catalog={{
          agent_id: 'codex',
          source: 'live',
          models: [],
          default_model: null,
          error: null,
        }}
        defaultModels={[
          {
            id: 'gpt-5.5',
            label: 'GPT-5.5',
            context_window: null,
            reasoning_levels: [],
          },
        ]}
        disabled={false}
        draft={{
          customs: [
            {
              slug: 'my-gateway-model',
              display_name: 'Gateway',
              context_window: null,
              base: 'gpt-5.5',
              overrides: null,
            },
          ],
          excluded_officials: [],
          default_model: null,
        }}
        showOfficialModels={false}
        onChange={vi.fn()}
      />
    );

    await user.click(screen.getByLabelText('Codex 模型清单默认项'));
    expect(
      screen.getByRole('option', { name: 'Gateway · 自定义' })
    ).toBeVisible();
    expect(
      screen.getByRole('option', { name: 'GPT-5.5 · gpt-5.5' })
    ).toBeVisible();
  });
});
