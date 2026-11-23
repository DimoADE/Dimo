import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import {
  nextWorkspaceTerminalTitle,
  type TerminalSurface,
} from '@/lib/workspaceTerminalTabs';

/**
 * Terminal session metadata tracked per workspace.
 */
export interface TerminalSession {
  /** Unique tab ID (frontend-generated) */
  tabId: string;
  /** PTY session ID returned by Tauri backend */
  sessionId: string | null;
  /** Workspace ID this terminal belongs to */
  workspaceId: string;
  /** Display title for the terminal tab */
  title: string;
  /** Shell type override (e.g. 'powershell.exe', 'cmd.exe') */
  shell?: string;
  /** Session type: 'pty' for normal terminal, 'log-viewer' for dev server logs */
  type?: 'pty' | 'log-viewer' | 'agent-command';
  /** ExecutionProcess ID, only used when type is 'log-viewer' */
  processId?: string;
  /** Whether this terminal should reject user input */
  readOnly?: boolean;
  /** Logical source of the terminal session */
  source?: 'workspace' | 'acp' | 'codex' | 'log-viewer';
  /** Whether the tab is currently running a foreground command */
  busy?: boolean;
  /** Where this session is shown: bottom terminal zone or an editor tab */
  surface?: TerminalSurface;
  /** Last known or initial working directory of this terminal session */
  cwd?: string;
}

interface TerminalState {
  /** Terminal sessions grouped by workspace ID */
  sessionsByWorkspace: Record<string, TerminalSession[]>;
  /** Active terminal tab ID per workspace */
  activeTabByWorkspace: Record<string, string | null>;

  /** Add a new terminal session for a workspace */
  addSession: (
    workspaceId: string,
    tabId: string,
    shell?: string,
    options?: {
      title?: string;
      type?: 'pty' | 'log-viewer' | 'agent-command';
      processId?: string;
      readOnly?: boolean;
      source?: 'workspace' | 'acp' | 'codex' | 'log-viewer';
      sessionId?: string | null;
      surface?: TerminalSurface;
      cwd?: string;
    }
  ) => void;
  /** Set the PTY session ID once the backend creates it */
  setSessionId: (tabId: string, sessionId: string) => void;
  /** Remove a terminal session */
  removeSession: (workspaceId: string, tabId: string) => void;
  /** Set the active tab for a workspace */
  setActiveTab: (workspaceId: string, tabId: string | null) => void;
  /** Update the title of a terminal tab */
  updateTitle: (tabId: string, title: string) => void;
  /** Mark whether a tab is running a command */
  setBusy: (tabId: string, busy: boolean) => void;
  /** Update the current working directory of a terminal tab */
  setCwd: (tabId: string, cwd: string) => void;
  /** Clear all sessions for a workspace */
  clearWorkspace: (workspaceId: string) => void;
  /** Get sessions for a specific workspace */
  getSessionsForWorkspace: (workspaceId: string) => TerminalSession[];
}

let tabCounter = 0;

export function generateTerminalTabId(): string {
  tabCounter += 1;
  return `term-${Date.now()}-${tabCounter}`;
}

function updateSessionInWorkspaces(
  sessionsByWorkspace: Record<string, TerminalSession[]>,
  tabId: string,
  updater: (session: TerminalSession) => TerminalSession | null
): Record<string, TerminalSession[]> | null {
  for (const [wsId, sessions] of Object.entries(sessionsByWorkspace)) {
    const idx = sessions.findIndex((session) => session.tabId === tabId);
    if (idx === -1) continue;
    const nextSession = updater(sessions[idx]);
    if (!nextSession || nextSession === sessions[idx]) {
      return null;
    }
    const nextSessions = sessions.slice();
    nextSessions[idx] = nextSession;
    return {
      ...sessionsByWorkspace,
      [wsId]: nextSessions,
    };
  }
  return null;
}

const dedupedTerminalStorage = {
  lastWrittenByKey: new Map<string, string>(),
  getItem: (name: string): string | null => {
    try {
      return window.localStorage.getItem(name);
    } catch {
      return null;
    }
  },
  setItem: (name: string, value: string): void => {
    if (dedupedTerminalStorage.lastWrittenByKey.get(name) === value) {
      return;
    }
    dedupedTerminalStorage.lastWrittenByKey.set(name, value);
    try {
      window.localStorage.setItem(name, value);
    } catch {
      // Ignore quota/storage errors.
    }
  },
  removeItem: (name: string): void => {
    dedupedTerminalStorage.lastWrittenByKey.delete(name);
    try {
      window.localStorage.removeItem(name);
    } catch {
      // Ignore storage errors.
    }
  },
};

export const useTerminalStore = create<TerminalState>()(
  persist(
    (set, get) => ({
      sessionsByWorkspace: {},
      activeTabByWorkspace: {},

      addSession: (workspaceId, tabId, shell, options) => {
        const state = get();
        const existing = state.sessionsByWorkspace[workspaceId] || [];
        const session: TerminalSession = {
          tabId,
          sessionId: options?.sessionId ?? null,
          workspaceId,
          title:
            options?.title ??
            (options?.type === 'log-viewer'
              ? `Log ${existing.length + 1}`
              : nextWorkspaceTerminalTitle(
                  shell,
                  existing.map((session) => session.title)
                )),
          shell,
          busy: false,
          type: options?.type ?? 'pty',
          processId: options?.processId,
          readOnly: options?.readOnly ?? false,
          source:
            options?.source ??
            (options?.type === 'log-viewer' ? 'log-viewer' : 'workspace'),
          surface: options?.surface ?? 'panel',
          cwd: options?.cwd,
        };
        set({
          sessionsByWorkspace: {
            ...state.sessionsByWorkspace,
            [workspaceId]: [...existing, session],
          },
          activeTabByWorkspace: {
            ...state.activeTabByWorkspace,
            [workspaceId]: tabId,
          },
        });
      },

      setSessionId: (tabId, sessionId) => {
        const updated = updateSessionInWorkspaces(
          get().sessionsByWorkspace,
          tabId,
          (session) =>
            session.sessionId === sessionId ? null : { ...session, sessionId }
        );
        if (updated) {
          set({ sessionsByWorkspace: updated });
        }
      },

      removeSession: (workspaceId, tabId) => {
        const state = get();
        const sessions = state.sessionsByWorkspace[workspaceId] || [];
        const newSessions = sessions.filter(
          (session) => session.tabId !== tabId
        );
        const wasActive = state.activeTabByWorkspace[workspaceId] === tabId;

        let newActive = state.activeTabByWorkspace[workspaceId];
        if (wasActive && newSessions.length > 0) {
          const closedIdx = sessions.findIndex(
            (session) => session.tabId === tabId
          );
          const nextIdx = Math.min(closedIdx, newSessions.length - 1);
          newActive = newSessions[nextIdx]?.tabId ?? null;
        } else if (newSessions.length === 0) {
          newActive = null;
        }

        set({
          sessionsByWorkspace: {
            ...state.sessionsByWorkspace,
            [workspaceId]: newSessions,
          },
          activeTabByWorkspace: {
            ...state.activeTabByWorkspace,
            [workspaceId]: newActive,
          },
        });
      },

      setActiveTab: (workspaceId, tabId) => {
        set((state) => {
          if (state.activeTabByWorkspace[workspaceId] === tabId) {
            return state;
          }
          return {
            activeTabByWorkspace: {
              ...state.activeTabByWorkspace,
              [workspaceId]: tabId,
            },
          };
        });
      },

      updateTitle: (tabId, title) => {
        const updated = updateSessionInWorkspaces(
          get().sessionsByWorkspace,
          tabId,
          (session) => (session.title === title ? null : { ...session, title })
        );
        if (updated) {
          set({ sessionsByWorkspace: updated });
        }
      },

      setBusy: (tabId, busy) => {
        const updated = updateSessionInWorkspaces(
          get().sessionsByWorkspace,
          tabId,
          (session) => (session.busy === busy ? null : { ...session, busy })
        );
        if (updated) {
          set({ sessionsByWorkspace: updated });
        }
      },

      setCwd: (tabId, cwd) => {
        const updated = updateSessionInWorkspaces(
          get().sessionsByWorkspace,
          tabId,
          (session) => (session.cwd === cwd ? null : { ...session, cwd })
        );
        if (updated) {
          set({ sessionsByWorkspace: updated });
        }
      },

      clearWorkspace: (workspaceId) => {
        const state = get();
        const restSessions = { ...state.sessionsByWorkspace };
        delete restSessions[workspaceId];
        const restActive = { ...state.activeTabByWorkspace };
        delete restActive[workspaceId];
        set({
          sessionsByWorkspace: restSessions,
          activeTabByWorkspace: restActive,
        });
      },

      getSessionsForWorkspace: (workspaceId) => {
        return get().sessionsByWorkspace[workspaceId] || [];
      },
    }),
    {
      name: 'dimo-terminal-sessions',
      version: 3,
      storage: createJSONStorage(() => dedupedTerminalStorage),
      migrate: (persistedState) => {
        const state = (persistedState ?? {}) as Partial<TerminalState>;
        const sessionsByWorkspace = Object.fromEntries(
          Object.entries(state.sessionsByWorkspace ?? {}).map(
            ([workspaceId, sessions]) => [
              workspaceId,
              (sessions ?? [])
                .filter(
                  (session) =>
                    !session.readOnly &&
                    session.source !== 'acp' &&
                    session.source !== 'codex'
                )
                .map((session) => ({
                  ...session,
                  sessionId: null,
                  busy: false,
                })),
            ]
          )
        );

        const activeTabByWorkspace = Object.fromEntries(
          Object.entries(state.activeTabByWorkspace ?? {}).map(
            ([workspaceId, activeTabId]) => {
              const sessions = sessionsByWorkspace[workspaceId] ?? [];
              const nextActiveTab = sessions.some(
                (session) => session.tabId === activeTabId
              )
                ? activeTabId
                : (sessions[0]?.tabId ?? null);
              return [workspaceId, nextActiveTab];
            }
          )
        );

        return {
          sessionsByWorkspace,
          activeTabByWorkspace,
        };
      },
      partialize: (state) => ({
        sessionsByWorkspace: Object.fromEntries(
          Object.entries(state.sessionsByWorkspace).map(
            ([workspaceId, sessions]) => [
              workspaceId,
              sessions
                .filter(
                  (session) =>
                    !session.readOnly &&
                    session.source !== 'acp' &&
                    session.source !== 'codex'
                )
                .map((session) => ({
                  ...session,
                  sessionId: null,
                  busy: false,
                })),
            ]
          )
        ),
        activeTabByWorkspace: Object.fromEntries(
          Object.entries(state.activeTabByWorkspace).map(
            ([workspaceId, activeTabId]) => {
              const persistedSessions =
                state.sessionsByWorkspace[workspaceId]?.filter(
                  (session) =>
                    !session.readOnly &&
                    session.source !== 'acp' &&
                    session.source !== 'codex'
                ) ?? [];
              const nextActiveTab = persistedSessions.some(
                (session) => session.tabId === activeTabId
              )
                ? activeTabId
                : (persistedSessions[0]?.tabId ?? null);
              return [workspaceId, nextActiveTab];
            }
          )
        ),
      }),
    }
  )
);
