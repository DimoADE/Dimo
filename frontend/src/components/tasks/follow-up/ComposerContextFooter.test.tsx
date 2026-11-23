import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AgentSessionConfigOption } from 'shared/types';
import {
  ComposerContextFooter,
  isUnrestrictedPermissionMode,
} from './ComposerContextFooter';

describe('ComposerContextFooter', () => {
  it('shows default directory on the left, branch and permission mode on the right', () => {
    render(
      <ComposerContextFooter
        useWorktree={false}
        workspacePath="/repo/dimo"
        branchName="master"
        sessionModes={{
          current: 'full-access',
          modes: [
            { id: 'default', label: 'Default', description: null },
            { id: 'full-access', label: 'Full Access', description: null },
          ],
        }}
        onSelectMode={vi.fn()}
      />
    );

    const directory = screen.getByTestId('composer-footer-directory');
    expect(directory).toHaveAttribute('data-directory-kind', 'default');
    expect(directory).toHaveAttribute('title', '/repo/dimo');
    expect(directory).toHaveTextContent(/默认目录|Default directory/);

    const branch = screen.getByTestId('composer-footer-branch');
    expect(branch).toHaveTextContent('master');

    const permission = screen.getByTestId('composer-footer-permission');
    expect(permission).toHaveTextContent('Full Access');
    expect(permission).toHaveAttribute('data-permission-unrestricted', 'true');
  });

  it('shows Worktree when running in a worktree workspace and omits empty branch', () => {
    render(
      <ComposerContextFooter
        useWorktree
        workspacePath="/worktrees/feat-ui"
        branchName="   "
        sessionModes={{
          current: 'plan',
          modes: [
            { id: 'default', label: 'Default', description: null },
            { id: 'plan', label: 'Plan', description: null },
          ],
        }}
      />
    );

    const directory = screen.getByTestId('composer-footer-directory');
    expect(directory).toHaveAttribute('data-directory-kind', 'worktree');
    expect(directory).toHaveTextContent('Worktree');
    expect(
      screen.queryByTestId('composer-footer-branch')
    ).not.toBeInTheDocument();

    const permission = screen.getByTestId('composer-footer-permission');
    expect(permission).toHaveTextContent('Plan');
    expect(permission).not.toHaveAttribute('data-permission-unrestricted');
  });

  it('lets the user switch permission modes from the footer menu and respects the dangerous gate', async () => {
    const user = userEvent.setup();
    const onSelectMode = vi.fn();

    render(
      <ComposerContextFooter
        useWorktree={false}
        branchName="main"
        sessionModes={{
          current: 'default',
          modes: [
            { id: 'default', label: 'Default', description: null },
            { id: 'acceptEdits', label: 'Accept Edits', description: null },
            {
              id: 'bypassPermissions',
              label: 'Bypass Permissions',
              description: null,
            },
          ],
        }}
        onSelectMode={onSelectMode}
      />
    );

    await user.click(screen.getByTestId('composer-footer-permission'));
    expect(screen.queryByText('Bypass Permissions')).not.toBeInTheDocument();

    await user.click(await screen.findByText(/允许危险操作|Allow dangerous/i));
    await user.click(await screen.findByText('Bypass Permissions'));
    expect(onSelectMode).toHaveBeenCalledWith('bypassPermissions');
  });

  it('falls back to permission/mode session config options and updates via onSelectConfigOption', async () => {
    const user = userEvent.setup();
    const onSelectConfigOption = vi.fn();
    const options: AgentSessionConfigOption[] = [
      {
        key: 'mode',
        label: 'Mode',
        category: 'mode',
        value: 'agent-full-access',
        choices: [
          { value: 'agent', label: 'Agent', description: null },
          {
            value: 'agent-full-access',
            label: 'Agent (full access)',
            description: null,
          },
        ],
      },
    ];

    render(
      <ComposerContextFooter
        useWorktree={false}
        branchName="dev"
        sessionConfigOptions={options}
        onSelectConfigOption={onSelectConfigOption}
      />
    );

    const trigger = screen.getByTestId('composer-footer-permission');
    expect(trigger).toHaveAttribute('data-permission-unrestricted', 'true');
    expect(trigger).toHaveTextContent(/完全访问|Full access/i);

    await user.click(trigger);
    await user.click(await screen.findByText('Agent'));
    expect(onSelectConfigOption).toHaveBeenCalledWith('mode', 'agent');
  });

  it('renders a non-interactive indicator when disabled', () => {
    render(
      <ComposerContextFooter
        useWorktree={false}
        branchName="main"
        disabled
        sessionModes={{
          current: 'yolo',
          modes: [
            { id: 'build', label: 'Build', description: null },
            { id: 'yolo', label: 'YOLO', description: null },
          ],
        }}
        onSelectMode={vi.fn()}
      />
    );

    const permission = screen.getByTestId('composer-footer-permission');
    expect(permission.tagName).toBe('SPAN');
    expect(permission).toHaveTextContent('YOLO');
    expect(permission).toHaveAttribute('data-permission-unrestricted', 'true');
  });

  it('displays projectName instead of default directory label when not in a worktree', () => {
    render(
      <ComposerContextFooter
        useWorktree={false}
        projectName="Dimo"
        workspacePath="/repo/dimo"
        branchName="master"
      />
    );

    const directory = screen.getByTestId('composer-footer-directory');
    expect(directory).toHaveAttribute('data-directory-kind', 'default');
    expect(directory).toHaveTextContent('Dimo');
    expect(directory).not.toHaveTextContent(/默认目录|Default directory/);
  });

  it('renders a static folder label without workspace selector or branch for non-git directories', () => {
    render(
      <ComposerContextFooter
        useWorktree={false}
        projectName="MyNotes"
        workspacePath="/Users/alice/MyNotes"
        branchName={null}
        workspaceSwitcher={null}
      />
    );

    const directory = screen.getByTestId('composer-footer-directory');
    expect(directory.tagName).toBe('DIV');
    expect(directory).toHaveAttribute('data-directory-kind', 'default');
    expect(directory).toHaveTextContent('MyNotes');
    expect(
      screen.queryByTestId('composer-footer-branch')
    ).not.toBeInTheDocument();
  });

  it('opens workspace selector on directory click and switches workspace or branch', async () => {
    const user = userEvent.setup();
    const onSelectWorkspace = vi.fn();
    const onSelectBranch = vi.fn();
    const rootWorkspace = {
      id: 'ws-root',
      project_id: 'proj-1',
      task_id: 'task-1',
      parent_workspace_id: null,
      container_ref: '/repo/dimo',
      branch: 'master',
      use_worktree: false,
      agent_working_dir: null,
      setup_completed_at: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      archived: false,
      pinned: false,
      name: null,
    };
    const wtWorkspace = {
      ...rootWorkspace,
      id: 'ws-wt',
      container_ref: '/repo/.worktrees/feat-ui',
      branch: 'feat/ui',
      use_worktree: true,
    };

    render(
      <ComposerContextFooter
        useWorktree={false}
        projectName="Dimo"
        workspacePath="/repo/dimo"
        branchName="master"
        workspaceSwitcher={{
          workspaces: [
            {
              id: rootWorkspace.id,
              workspace: rootWorkspace,
              label: 'Dimo',
              branchLabel: 'master',
              isWorktree: false,
              isSelected: true,
              copyPath: '/repo/dimo',
            },
            {
              id: wtWorkspace.id,
              workspace: wtWorkspace,
              label: 'feat/ui',
              branchLabel: 'feat/ui',
              isWorktree: true,
              isSelected: false,
              copyPath: '/repo/.worktrees/feat-ui',
            },
          ],
          branches: [
            { name: 'master', role: 'current', workspaceId: null },
            { name: 'develop', role: 'available', workspaceId: null },
          ],
          canSwitchBranch: true,
          canEnsureDefaultDirectory: false,
          defaultDirectoryLabel: 'Dimo',
          defaultDirectoryBranch: 'master',
          isSwitching: false,
          disabled: false,
          onSelectWorkspace,
          onSelectBranch,
        }}
      />
    );

    const directoryButton = screen.getByTestId('composer-footer-directory');
    expect(directoryButton.tagName).toBe('BUTTON');
    expect(directoryButton).toHaveTextContent('Dimo');

    await user.click(directoryButton);
    await user.click(await screen.findByText('feat/ui'));
    expect(onSelectWorkspace).toHaveBeenCalledWith(wtWorkspace);

    await user.click(directoryButton);
    await user.click(
      await screen.findByRole('radio', { name: /Branch|分支/i })
    );
    await user.click(await screen.findByText('develop'));
    expect(onSelectBranch).toHaveBeenCalledWith({
      name: 'develop',
      role: 'available',
      workspaceId: null,
    });
  });

  it('detects unrestricted permission modes across agents', () => {
    expect(isUnrestrictedPermissionMode('full-access', 'Full Access')).toBe(
      true
    );
    expect(isUnrestrictedPermissionMode('agent-full-access', '完全访问')).toBe(
      true
    );
    expect(isUnrestrictedPermissionMode('yolo', 'Auto')).toBe(true);
    expect(
      isUnrestrictedPermissionMode('bypassPermissions', 'Bypass Permissions')
    ).toBe(true);
    expect(isUnrestrictedPermissionMode('default', 'Default')).toBe(false);
    expect(isUnrestrictedPermissionMode('plan', 'Plan')).toBe(false);
  });
});
