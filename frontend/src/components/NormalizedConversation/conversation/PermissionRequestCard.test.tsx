import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ConversationPermissionView } from 'shared/types';
import {
  PermissionRequestCard,
  PermissionRequestStack,
} from './PermissionRequestCard';

function fileEditRequest(
  overrides: Partial<ConversationPermissionView> = {}
): ConversationPermissionView {
  return {
    permission_id: 'perm-1',
    title: 'Edit README.md',
    status: 'pending',
    details: {
      fields: {
        kind: 'edit',
        content: [
          {
            type: 'diff',
            path: 'README.md',
            oldText: 'old line',
            newText: 'new line',
          },
        ],
      },
    },
    options: [
      { id: 'allow', label: 'Allow', kind: 'allow_once' },
      { id: 'deny', label: 'Deny', kind: 'reject_once' },
    ],
    ...overrides,
  };
}

describe('PermissionRequestCard', () => {
  it('presents a terminal permission primarily with its title and reveals the exact command in details', async () => {
    const user = userEvent.setup();
    render(
      <PermissionRequestCard
        request={fileEditRequest({
          title: 'Run the project test command',
          details: {
            fields: {
              kind: 'execute',
              rawInput: { command: 'pnpm test --runInBand' },
            },
          },
        })}
        onRespond={vi.fn()}
      />
    );

    expect(screen.getByText('终端')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Run the project test command' })
    ).toBeInTheDocument();
    expect(screen.queryByTestId('permission-capsule-drawer')).toBeNull();
    expect(screen.queryByText('pnpm test --runInBand')).toBeNull();

    await user.click(screen.getByRole('button', { name: '详情' }));

    expect(screen.getByTestId('permission-capsule-drawer')).toBeInTheDocument();
    expect(screen.getByText('pnpm test --runInBand')).toBeInTheDocument();
  });

  it('renders the real file path from the ACP diff detail when expanded', async () => {
    const user = userEvent.setup();
    render(
      <PermissionRequestCard request={fileEditRequest()} onRespond={vi.fn()} />
    );

    expect(
      screen.getByRole('heading', { name: 'Edit README.md' })
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '详情' }));
    expect(screen.getByText('README.md')).toBeInTheDocument();
    expect(screen.getByText('new line')).toBeInTheDocument();
  });

  it('answers with the selected option id', () => {
    const onRespond = vi.fn();
    render(
      <PermissionRequestCard
        request={fileEditRequest()}
        onRespond={onRespond}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '允许' }));

    expect(onRespond).toHaveBeenCalledWith('perm-1', {
      kind: 'selected',
      option_id: 'allow',
    });
  });

  it('echoes authoritative backend revision as expected_revision when present', () => {
    const onRespond = vi.fn();
    render(
      <PermissionRequestCard
        request={fileEditRequest({ revision: 7 })}
        onRespond={onRespond}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '允许' }));

    expect(onRespond).toHaveBeenCalledWith('perm-1', {
      kind: 'selected',
      option_id: 'allow',
      expected_revision: 7,
    });
  });

  it('keeps broader approval scopes behind the allow split menu', async () => {
    const user = userEvent.setup();
    const onRespond = vi.fn();
    render(
      <PermissionRequestCard
        request={fileEditRequest({
          options: [
            {
              id: 'allow-once',
              label: '允许一次',
              kind: 'allow_once',
            },
            {
              id: 'allow-similar',
              label: '允许类似命令',
              kind: 'allow_always',
              description: '本会话中匹配该命令前缀的请求',
            },
            { id: 'reject', label: '拒绝', kind: 'reject_once' },
          ],
        })}
        onRespond={onRespond}
      />
    );

    expect(
      screen.queryByRole('menuitem', { name: '本次会话中允许' })
    ).toBeNull();
    await user.click(screen.getByRole('button', { name: '展开允许选项' }));
    expect(
      screen.getByRole('menuitem', { name: '允许一次' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('menuitem', { name: '总是允许全部' })
    ).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: '本次会话中允许' }));

    expect(onRespond).toHaveBeenCalledWith('perm-1', {
      kind: 'selected',
      option_id: 'allow-similar',
      persist: true,
    });
  });

  it('persists agent-wide auto-approve when selecting always allow even when the agent only offers allow-once', async () => {
    const user = userEvent.setup();
    const onRespond = vi.fn();
    render(
      <PermissionRequestCard
        request={fileEditRequest()}
        onRespond={onRespond}
      />
    );

    await user.click(screen.getByRole('button', { name: '展开允许选项' }));
    await user.click(screen.getByRole('menuitem', { name: '总是允许全部' }));

    expect(onRespond).toHaveBeenCalledWith('perm-1', {
      kind: 'selected',
      option_id: 'allow',
      persist: true,
      persist_for_agent: true,
    });
  });

  it('uses the agent-provided reject option for the reject action', () => {
    const onRespond = vi.fn();
    render(
      <PermissionRequestCard
        request={fileEditRequest()}
        onRespond={onRespond}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '拒绝' }));

    expect(onRespond).toHaveBeenCalledWith('perm-1', {
      kind: 'selected',
      option_id: 'deny',
    });
  });

  it('cancels safely when the agent provides no reject option', () => {
    const onRespond = vi.fn();
    render(
      <PermissionRequestCard
        request={fileEditRequest({
          options: [{ id: 'allow', label: 'Allow', kind: 'allow_once' }],
        })}
        onRespond={onRespond}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '拒绝' }));

    expect(onRespond).toHaveBeenCalledWith('perm-1', { kind: 'cancelled' });
  });

  it('shows a resolved state instead of action buttons once answered', () => {
    render(
      <PermissionRequestCard
        request={fileEditRequest({ status: 'responded' })}
        onRespond={vi.fn()}
      />
    );

    expect(screen.getByText('已响应')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '允许' })).toBeNull();
  });

  it('renders a command preview from rawInput when details are opened', async () => {
    const user = userEvent.setup();
    render(
      <PermissionRequestCard
        request={fileEditRequest({
          title: 'Run command',
          details: {
            fields: { kind: 'execute', rawInput: { command: 'rm -rf build' } },
          },
        })}
        onRespond={vi.fn()}
      />
    );

    expect(
      screen.getByRole('heading', { name: 'Run command' })
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '详情' }));
    expect(screen.getByText('rm -rf build')).toBeInTheDocument();
  });

  it('disables actions while a response is in flight', () => {
    render(
      <PermissionRequestCard
        request={fileEditRequest()}
        onRespond={vi.fn()}
        responding
      />
    );

    expect(screen.getByRole('button', { name: '允许' })).toBeDisabled();
  });

  it('uses _meta.claudeCode.title as the visible heading without duplicating the title', async () => {
    const user = userEvent.setup();
    render(
      <PermissionRequestCard
        request={fileEditRequest({
          title: 'Build',
          details: {
            fields: {
              kind: 'execute',
              title: 'cargo build',
              rawInput: { command: 'cargo build' },
            },
            _meta: {
              claudeCode: { title: 'Build' },
              permission: { title: 'cargo build' },
            },
          },
        })}
        onRespond={vi.fn()}
      />
    );

    expect(screen.getByRole('heading', { name: 'Build' })).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: '权限申请' })
    ).not.toBeInTheDocument();
    expect(screen.getAllByText('Build')).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: '详情' }));
    expect(screen.getByText('cargo build')).toBeInTheDocument();
  });

  it('suppresses _meta.permission.title when it is byte-equal to the command', () => {
    render(
      <PermissionRequestCard
        request={fileEditRequest({
          title: 'pnpm test --runInBand',
          details: {
            fields: {
              kind: 'execute',
              title: 'pnpm test --runInBand',
              rawInput: { command: 'pnpm test --runInBand' },
            },
            _meta: {
              permission: { title: 'pnpm test --runInBand' },
            },
          },
        })}
        onRespond={vi.fn()}
      />
    );

    expect(
      screen.getByRole('heading', { name: '权限申请' })
    ).toBeInTheDocument();
    expect(screen.getAllByText('pnpm test --runInBand')).toHaveLength(1);
  });

  it('uses _meta.permission.title when _meta.claudeCode.title is absent and falls back to toolCall.title without meta', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <PermissionRequestCard
        request={fileEditRequest({
          title: 'Run command?',
          details: {
            fields: {
              kind: 'execute',
              title: 'Run command',
              rawInput: { command: 'git status' },
            },
            _meta: {
              permission: { title: 'Run command?' },
            },
          },
        })}
        onRespond={vi.fn()}
      />
    );

    expect(
      screen.getByRole('heading', { name: 'Run command?' })
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '详情' }));
    expect(screen.getByText('git status')).toBeInTheDocument();

    rerender(
      <PermissionRequestCard
        request={fileEditRequest({
          title: '',
          details: {
            fields: {
              kind: 'edit',
              title: 'Update Cargo.toml',
              locations: [{ path: 'Cargo.toml' }],
            },
          },
        })}
        onRespond={vi.fn()}
      />
    );

    expect(
      screen.getByRole('heading', { name: 'Update Cargo.toml' })
    ).toBeInTheDocument();
    expect(screen.getByText('Cargo.toml')).toBeInTheDocument();
  });

  it('renders command and unified diff previews from native details.input and bare input objects', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <PermissionRequestCard
        request={fileEditRequest({
          title: 'commandExecution',
          details: {
            toolName: 'commandExecution',
            input: { command: 'cargo test -p conversations --lib' },
          },
        })}
        onRespond={vi.fn()}
      />
    );

    expect(screen.getByText('终端')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '详情' }));
    expect(
      screen.getByText('cargo test -p conversations --lib')
    ).toBeInTheDocument();

    rerender(
      <PermissionRequestCard
        request={fileEditRequest({
          title: 'fileChange',
          details: {
            changes: [
              {
                path: 'src/native.ts',
                kind: 'update',
                diff: '@@ -1 +1 @@\n-const legacy = true;\n+const legacy = false;',
              },
            ],
          },
        })}
        onRespond={vi.fn()}
      />
    );

    expect(screen.getByText('文件')).toBeInTheDocument();
    expect(screen.getAllByText('src/native.ts').length).toBeGreaterThanOrEqual(
      1
    );
    expect(screen.getByText(/const legacy = false;/)).toBeInTheDocument();

    rerender(
      <PermissionRequestCard
        request={fileEditRequest({
          title: 'Edit',
          details: {
            toolName: 'Edit',
            input: {
              file_path: 'src/claude.ts',
              old_string: 'before()',
              new_string: 'after()',
            },
          },
        })}
        onRespond={vi.fn()}
      />
    );

    expect(screen.getAllByText('src/claude.ts').length).toBeGreaterThanOrEqual(
      1
    );
    expect(screen.getByText(/after\(\)/)).toBeInTheDocument();
  });

  it('stacks multiple pending requests into a single capsule deck with a stepper', async () => {
    const user = userEvent.setup();
    const onRespond = vi.fn();
    render(
      <PermissionRequestStack
        items={[
          {
            request: fileEditRequest({
              permission_id: 'perm-1',
              title: '运行单元测试',
            }),
            onRespond,
          },
          {
            request: fileEditRequest({
              permission_id: 'perm-2',
              title: '修改配置文件',
            }),
            onRespond,
          },
        ]}
      />
    );

    expect(screen.getByTestId('permission-capsule-stack')).toBeInTheDocument();
    expect(screen.getByText('1 / 2')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: '运行单元测试' })
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '下一条权限请求' }));

    expect(screen.getByText('2 / 2')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: '修改配置文件' })
    ).toBeInTheDocument();
  });
});
