/**
 * User-configurable layout arrangements, persisted in localStorage and shared
 * across every project. Three independent arrangements exist:
 *
 * - Workspace page: three visible columns (A dock / B workspace / C session)
 *   mapped onto left / center / right. Stored arrangements still pin
 *   `bottom: terminal` for the dockview engine; the settings schematic does
 *   not expose a D terminal strip.
 * - Kanban page: three zones (A session list / B session monitor / C session
 *   execution) mapped onto three column slots.
 * - Collaboration page: three zones (A collaboration spaces / B message area /
 *   C preview area) mapped onto three column slots.
 *
 * The settings window is a separate webview, so cross-window sync relies on
 * the `storage` event (same pattern as the i18n language preference).
 */
import { useSyncExternalStore } from 'react';

import { persistFrontendPreference } from '@/lib/frontendPreferences';

export type LayoutZone = 'dock' | 'workspace' | 'session' | 'terminal';
type LayoutSlot = 'left' | 'center' | 'right' | 'bottom';
export type LayoutArrangement = Record<LayoutSlot, LayoutZone>;

export type KanbanZone = 'list' | 'monitor' | 'session';
type KanbanSlot = 'left' | 'center' | 'right';
type KanbanArrangement = Record<KanbanSlot, KanbanZone>;

type CollaborationZone = 'spaces' | 'thread' | 'preview';
type CollaborationSlot = 'left' | 'center' | 'right';
type CollaborationArrangement = Record<CollaborationSlot, CollaborationZone>;

export const LAYOUT_SLOTS: readonly LayoutSlot[] = [
  'left',
  'center',
  'right',
  'bottom',
];

const LAYOUT_ZONES: readonly LayoutZone[] = [
  'dock',
  'workspace',
  'session',
  'terminal',
];

const KANBAN_SLOTS: readonly KanbanSlot[] = ['left', 'center', 'right'];

const KANBAN_ZONES: readonly KanbanZone[] = ['list', 'monitor', 'session'];

const COLLABORATION_SLOTS: readonly CollaborationSlot[] = [
  'left',
  'center',
  'right',
];

const COLLABORATION_ZONES: readonly CollaborationZone[] = [
  'spaces',
  'thread',
  'preview',
];

export const DEFAULT_LAYOUT_ARRANGEMENT: LayoutArrangement = {
  left: 'dock',
  center: 'workspace',
  right: 'session',
  bottom: 'terminal',
};

export const DEFAULT_KANBAN_ARRANGEMENT: KanbanArrangement = {
  left: 'list',
  center: 'monitor',
  right: 'session',
};

const DEFAULT_COLLABORATION_ARRANGEMENT: CollaborationArrangement = {
  left: 'spaces',
  center: 'thread',
  right: 'preview',
};

export function arrangementsEqual<A extends Record<string, string>>(
  a: A,
  b: A
): boolean {
  return (Object.keys(a) as (keyof A)[]).every((slot) => a[slot] === b[slot]);
}

interface ArrangementPreference<S extends string, Z extends string> {
  get: () => Record<S, Z>;
  set: (arrangement: Record<S, Z>) => void;
  reset: () => void;
  subscribe: (listener: () => void) => () => void;
}

type ArrangementStorageKey =
  | 'dimo:layout-arrangement'
  | 'dimo:kanban-layout-arrangement'
  | 'dimo:collaboration-layout-arrangement';

function createArrangementPreference<S extends string, Z extends string>(
  storageKey: ArrangementStorageKey,
  slots: readonly S[],
  zones: readonly Z[],
  defaultValue: Record<S, Z>
): ArrangementPreference<S, Z> {
  let cachedRaw: string | null = null;
  let cached: Record<S, Z> = defaultValue;
  const listeners = new Set<() => void>();
  let storageListenerInstalled = false;

  const isValid = (value: unknown): value is Record<S, Z> => {
    if (!value || typeof value !== 'object') return false;

    const record = value as Record<string, unknown>;
    const assigned = slots.map((slot) => record[slot]);
    return (
      assigned.every(
        (zone) => typeof zone === 'string' && zones.includes(zone as Z)
      ) && new Set(assigned).size === zones.length
    );
  };

  const read = (): Record<S, Z> => {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(storageKey);
    } catch {
      return defaultValue;
    }

    if (raw === cachedRaw) return cached;

    cachedRaw = raw;
    if (!raw) {
      cached = defaultValue;
      return cached;
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      cached = isValid(parsed) ? parsed : defaultValue;
    } catch {
      cached = defaultValue;
    }

    return cached;
  };

  const emit = () => {
    for (const listener of [...listeners]) {
      listener();
    }
  };

  const installStorageListener = () => {
    if (storageListenerInstalled || typeof window === 'undefined') return;

    storageListenerInstalled = true;
    window.addEventListener('storage', (event) => {
      if (event.key !== null && event.key !== storageKey) return;
      read();
      emit();
    });
  };

  return {
    get: read,
    set: (arrangement) => {
      if (!isValid(arrangement)) return;

      try {
        localStorage.setItem(storageKey, JSON.stringify(arrangement));
        persistFrontendPreference(storageKey, arrangement);
      } catch {
        // Keep the in-memory value even when persistence is unavailable.
      }

      cachedRaw = JSON.stringify(arrangement);
      cached = arrangement;
      emit();
    },
    reset: () => {
      try {
        localStorage.setItem(storageKey, JSON.stringify(defaultValue));
        persistFrontendPreference(storageKey, defaultValue);
      } catch {
        // Keep the in-memory value even when persistence is unavailable.
      }
      cachedRaw = JSON.stringify(defaultValue);
      cached = defaultValue;
      emit();
    },
    subscribe: (listener) => {
      installStorageListener();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const workspacePreference = createArrangementPreference(
  'dimo:layout-arrangement',
  LAYOUT_SLOTS,
  LAYOUT_ZONES,
  DEFAULT_LAYOUT_ARRANGEMENT
);

const kanbanPreference = createArrangementPreference(
  'dimo:kanban-layout-arrangement',
  KANBAN_SLOTS,
  KANBAN_ZONES,
  DEFAULT_KANBAN_ARRANGEMENT
);

const collaborationPreference = createArrangementPreference(
  'dimo:collaboration-layout-arrangement',
  COLLABORATION_SLOTS,
  COLLABORATION_ZONES,
  DEFAULT_COLLABORATION_ARRANGEMENT
);

// --- Workspace page arrangement ---

export function isDefaultArrangement(arrangement: LayoutArrangement): boolean {
  return arrangementsEqual(arrangement, DEFAULT_LAYOUT_ARRANGEMENT);
}

export function slotOfZone(
  arrangement: LayoutArrangement,
  zone: LayoutZone
): LayoutSlot {
  return LAYOUT_SLOTS.find((slot) => arrangement[slot] === zone) ?? 'center';
}

export function getLayoutArrangement(): LayoutArrangement {
  return workspacePreference.get();
}

export function useLayoutArrangement(): LayoutArrangement {
  return useSyncExternalStore(
    workspacePreference.subscribe,
    workspacePreference.get,
    () => DEFAULT_LAYOUT_ARRANGEMENT
  );
}

// --- Kanban page arrangement ---

export function kanbanSlotOfZone(
  arrangement: KanbanArrangement,
  zone: KanbanZone
): KanbanSlot {
  return KANBAN_SLOTS.find((slot) => arrangement[slot] === zone) ?? 'right';
}

/**
 * The session/monitor divider sits on the session edge that faces the
 * monitor, so swapping those two zones keeps the handle between them.
 */
export function kanbanSessionResizeHandleSide(
  arrangement: KanbanArrangement
): 'left' | 'right' {
  const sessionIndex = KANBAN_SLOTS.indexOf(
    kanbanSlotOfZone(arrangement, 'session')
  );
  const monitorIndex = KANBAN_SLOTS.indexOf(
    kanbanSlotOfZone(arrangement, 'monitor')
  );
  return sessionIndex < monitorIndex ? 'right' : 'left';
}

export function setKanbanArrangement(arrangement: KanbanArrangement): void {
  kanbanPreference.set(arrangement);
}

export function resetKanbanArrangement(): void {
  kanbanPreference.reset();
}

export function useKanbanArrangement(): KanbanArrangement {
  return useSyncExternalStore(
    kanbanPreference.subscribe,
    kanbanPreference.get,
    () => DEFAULT_KANBAN_ARRANGEMENT
  );
}

// --- Collaboration page arrangement ---

export function useCollaborationArrangement(): CollaborationArrangement {
  return useSyncExternalStore(
    collaborationPreference.subscribe,
    collaborationPreference.get,
    () => DEFAULT_COLLABORATION_ARRANGEMENT
  );
}
