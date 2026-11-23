import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { IDockviewPanelProps } from 'dockview-react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useFileTreeStore } from '@/stores/useFileTreeStore';
import DockviewFileTreePanel from './DockviewFileTreePanel';

const mocks = vi.hoisted(() => ({
  pickHostDirectory: vi.fn(),
  listDirectoryChildren: vi.fn(),
  subscribeFileTreeChanges: vi.fn(),
  openFilePreview: vi.fn(),
  renameFilePreviews: vi.fn(),
  projectState: {
    projectId: undefined as string | undefined,
    project: undefined as { id: string; root_path?: string | null } | undefined,
  },
  repos: [] as Array<{ path: string }>,
  activeWorktreeId: null as string | null,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/lib/hostFs', () => ({
  pickHostDirectory: mocks.pickHostDirectory,
}));

vi.mock('@/lib/api', () => ({
  fileTreeApi: {
    listDirectoryChildren: mocks.listDirectoryChildren,
  },
}));

vi.mock('@/lib/fileTreeChangeStream', () => ({
  subscribeFileTreeChanges: mocks.subscribeFileTreeChanges,
}));

vi.mock('@/hooks/usePanelActions', () => ({
  usePanelActions: () => ({
    openFilePreview: mocks.openFilePreview,
    renameFilePreviews: mocks.renameFilePreviews,
  }),
}));

vi.mock('@/contexts/ProjectContext', () => ({
  useProject: () => mocks.projectState,
}));

vi.mock('@/hooks/useProjectRepos', () => ({
  useProjectRepos: () => ({ data: mocks.repos }),
}));

vi.mock('@/contexts/WorktreeContext', () => ({
  useWorktree: () => ({ activeWorktreeId: mocks.activeWorktreeId }),
}));

vi.mock('@/hooks/useAttempt', () => ({
  useAttempt: () => ({ data: undefined }),
}));

vi.mock('@/hooks/useAttemptRepo', () => ({
  useAttemptRepo: () => ({ repos: [] }),
}));

vi.mock('@/components/file-tree/FileTreePanel', () => ({
  FileTreePanel: ({
    workspacePath,
    files,
    directories,
  }: {
    workspacePath: string;
    files: string[];
    directories: string[];
  }) => (
    <div data-testid="mock-file-tree-panel">
      <div data-testid="workspace-path">{workspacePath}</div>
      <div data-testid="file-list">{files.join(',')}</div>
      <div data-testid="dir-list">{directories.join(',')}</div>
    </div>
  ),
}));

function buildPanelProps(): IDockviewPanelProps {
  return {
    params: {},
    api: {} as IDockviewPanelProps['api'],
    containerApi: {} as IDockviewPanelProps['containerApi'],
  };
}

describe('DockviewFileTreePanel', () => {
  beforeEach(() => {
    useFileTreeStore.setState({
      rootPath: null,
      selectedFilePath: null,
      diffFilePath: null,
      revealTarget: null,
    });
    mocks.pickHostDirectory.mockReset();
    mocks.listDirectoryChildren.mockReset();
    mocks.subscribeFileTreeChanges.mockReset();
    mocks.subscribeFileTreeChanges.mockReturnValue(() => {});
    mocks.projectState = { projectId: undefined, project: undefined };
    mocks.repos = [];
    mocks.activeWorktreeId = null;
  });

  it('loads directory contents after picking a folder manually when no project folder is active', async () => {
    const pickedFolder = 'C:\\Users\\alice\\Documents\\demo-folder';
    mocks.pickHostDirectory.mockResolvedValue(pickedFolder);
    mocks.listDirectoryChildren.mockResolvedValue({
      files: ['README.md'],
      directories: ['src'],
      gitignored_files: [],
      gitignored_directories: [],
    });

    render(<DockviewFileTreePanel {...buildPanelProps()} />);

    const openButton = screen.getByRole('button', {
      name: 'fileTreePanel.openFolder',
    });
    fireEvent.click(openButton);

    await waitFor(() => {
      expect(mocks.listDirectoryChildren).toHaveBeenCalledWith(
        pickedFolder,
        ''
      );
    });

    expect(screen.getByTestId('workspace-path')).toHaveTextContent(
      pickedFolder
    );
    expect(screen.getByTestId('file-list')).toHaveTextContent('README.md');
    expect(screen.getByTestId('dir-list')).toHaveTextContent('src');
  });

  it('clears the manually picked folder when switching to another project', async () => {
    const pickedFolder = 'C:\\Users\\alice\\Documents\\manual-folder';
    const nextProjectFolder = 'C:\\Users\\alice\\Documents\\project-b';
    mocks.pickHostDirectory.mockResolvedValue(pickedFolder);
    mocks.listDirectoryChildren.mockImplementation(async (rootPath: string) => {
      if (rootPath === pickedFolder) {
        return {
          files: ['manual.txt'],
          directories: [],
          gitignored_files: [],
          gitignored_directories: [],
        };
      }
      if (rootPath === nextProjectFolder) {
        return {
          files: ['project-b.ts'],
          directories: [],
          gitignored_files: [],
          gitignored_directories: [],
        };
      }
      return {
        files: [],
        directories: [],
        gitignored_files: [],
        gitignored_directories: [],
      };
    });

    const { rerender } = render(
      <DockviewFileTreePanel {...buildPanelProps()} />
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'fileTreePanel.openFolder' })
    );

    await waitFor(() => {
      expect(screen.getByTestId('file-list')).toHaveTextContent('manual.txt');
    });

    mocks.projectState = {
      projectId: 'project-b',
      project: { id: 'project-b', root_path: nextProjectFolder },
    };

    rerender(<DockviewFileTreePanel {...buildPanelProps()} />);

    await waitFor(() => {
      expect(mocks.listDirectoryChildren).toHaveBeenCalledWith(
        nextProjectFolder,
        ''
      );
    });
    expect(screen.getByTestId('workspace-path')).toHaveTextContent(
      nextProjectFolder
    );
    expect(screen.getByTestId('file-list')).toHaveTextContent('project-b.ts');
  });
});
