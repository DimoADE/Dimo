import { useCallback, useState } from 'react';

export type GitPanelMode = 'diff' | 'log' | 'branches' | 'issues' | 'prs';
export type DiffViewStyle = 'split' | 'unified';
export type DiffListView = 'flat' | 'tree';
export type LogViewMode = 'graph' | 'list';

interface UseGitPanelControllerReturn {
  mode: GitPanelMode;
  setMode: (mode: GitPanelMode) => void;
  diffViewStyle: DiffViewStyle;
  setDiffViewStyle: (style: DiffViewStyle) => void;
  diffListView: DiffListView;
  setDiffListView: (view: DiffListView) => void;
  logViewMode: LogViewMode;
  setLogViewMode: (view: LogViewMode) => void;
  selectedDiffPath: string | null;
  setSelectedDiffPath: (path: string | null) => void;
  toggleDiffViewStyle: () => void;
  toggleDiffListView: () => void;
  toggleLogViewMode: () => void;
}

export function useGitPanelController(): UseGitPanelControllerReturn {
  const [mode, setMode] = useState<GitPanelMode>('diff');
  const [diffViewStyle, setDiffViewStyle] = useState<DiffViewStyle>('unified');
  const [diffListView, setDiffListView] = useState<DiffListView>('flat');
  const [logViewMode, setLogViewMode] = useState<LogViewMode>('graph');
  const [selectedDiffPath, setSelectedDiffPath] = useState<string | null>(null);

  const toggleDiffViewStyle = useCallback(() => {
    setDiffViewStyle((prev) => (prev === 'split' ? 'unified' : 'split'));
  }, []);

  const toggleDiffListView = useCallback(() => {
    setDiffListView((prev) => (prev === 'flat' ? 'tree' : 'flat'));
  }, []);

  const toggleLogViewMode = useCallback(() => {
    setLogViewMode((prev) => (prev === 'graph' ? 'list' : 'graph'));
  }, []);

  return {
    mode,
    setMode,
    diffViewStyle,
    setDiffViewStyle,
    diffListView,
    setDiffListView,
    logViewMode,
    setLogViewMode,
    selectedDiffPath,
    setSelectedDiffPath,
    toggleDiffViewStyle,
    toggleDiffListView,
    toggleLogViewMode,
  };
}
