import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MusePluginSummaryView } from 'shared/types';

import { agentManagementApi } from '@/features/agent-management';

import { MusePluginManager } from './MusePluginManager';

vi.mock('@/features/agent-management', async () => {
  const actual = await vi.importActual<
    typeof import('@/features/agent-management')
  >('@/features/agent-management');
  return {
    ...actual,
    agentManagementApi: {
      ...actual.agentManagementApi,
      musePlugins: vi.fn(),
      installMusePlugin: vi.fn(),
      approveMusePlugin: vi.fn(),
      setMusePluginEnabled: vi.fn(),
      removeMusePlugin: vi.fn(),
    },
  };
});

const summary: MusePluginSummaryView = {
  home: '/tmp/.local/share/muse/plugins',
  plugins: [
    {
      id: 'git-helper',
      name: 'git-helper',
      version: '1.2.0',
      status: 'pending_approval',
      enabled: false,
      approved: false,
      path: '/tmp/.local/share/muse/plugins/git-helper',
      source: 'git-helper@official',
      marketplace: 'official',
    },
  ],
};

describe('MusePluginManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(agentManagementApi.musePlugins).mockResolvedValue(summary);
  });

  it('lists installed Muse Code plugins and supports approve and enable', async () => {
    const user = userEvent.setup();
    vi.mocked(agentManagementApi.approveMusePlugin).mockResolvedValue({
      ...summary,
      plugins: [{ ...summary.plugins[0], approved: true, status: 'disabled' }],
    });
    vi.mocked(agentManagementApi.setMusePluginEnabled).mockResolvedValue({
      ...summary,
      plugins: [
        {
          ...summary.plugins[0],
          approved: true,
          enabled: true,
          status: 'enabled',
        },
      ],
    });

    render(<MusePluginManager />);
    expect(
      await screen.findByRole('button', { name: 'git-helper' })
    ).toBeInTheDocument();
    expect(screen.getByText('git-helper@official')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '批准' }));
    expect(agentManagementApi.approveMusePlugin).toHaveBeenCalledWith(
      'git-helper'
    );

    await user.click(screen.getByRole('button', { name: '启用' }));
    expect(agentManagementApi.setMusePluginEnabled).toHaveBeenCalledWith(
      'git-helper',
      true
    );
  });

  it('installs a Muse Code plugin from source spec', async () => {
    const user = userEvent.setup();
    vi.mocked(agentManagementApi.installMusePlugin).mockResolvedValue(summary);

    render(<MusePluginManager />);
    await screen.findByRole('button', { name: 'git-helper' });
    await user.type(screen.getByLabelText('来源'), 'code-review@official');
    await user.click(screen.getByRole('button', { name: '安装插件' }));
    expect(agentManagementApi.installMusePlugin).toHaveBeenCalledWith(
      'code-review@official'
    );
  });
});
