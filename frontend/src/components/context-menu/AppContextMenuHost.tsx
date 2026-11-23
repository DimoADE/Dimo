import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import {
  type SlotContribution,
  useSlotContributions,
} from '@dimoai/plugin-sdk';
import { useTranslation } from 'react-i18next';
import { desktopApi } from '@/lib/api/misc';
import {
  readClipboardViaBridge,
  writeClipboardViaBridge,
} from '@/vscode/bridge';
import {
  dismissActiveProductContextMenu,
  ProductContextMenu,
} from './ProductContextMenu';
import {
  getContextMenuSelectedText,
  isEditableContextMenuTarget,
  isForbiddenContextMenuTarget,
  isReadOnlyEditable,
} from './contextMenuHitTest';
import type {
  OpenProductContextMenuInput,
  ProductContextMenuItem,
} from './contextMenuTypes';

const DEVELOPER_MODE_CHANGED_EVENT = 'developer-mode-changed';

type DesktopDeveloperState = {
  isDev: boolean;
  developerMode: boolean;
};

function readDesktopDeveloperState(): DesktopDeveloperState {
  if (typeof window === 'undefined' || !window.dimoDesktop) {
    return { isDev: false, developerMode: false };
  }
  return {
    isDev: Boolean(window.dimoDesktop.isDev),
    developerMode: Boolean(window.dimoDesktop.isDeveloperMode?.()),
  };
}

function buildDeveloperMenuItems(
  x: number,
  y: number,
  t: (key: string) => string
): ProductContextMenuItem[] {
  return [
    {
      id: 'reload',
      label: t('contextMenu.reload'),
      onSelect: () => {
        void desktopApi.reloadWindow().catch(() => {
          window.location.reload();
        });
      },
    },
    {
      id: 'force-reload',
      label: t('contextMenu.forceReload'),
      onSelect: () => {
        void desktopApi.forceReloadWindow().catch(() => {
          window.location.reload();
        });
      },
    },
    { type: 'separator', id: 'dev-tools-sep' },
    {
      id: 'inspect-element',
      label: t('contextMenu.inspectElement'),
      onSelect: () => {
        void desktopApi.inspectElement(x, y).catch(() => undefined);
      },
    },
    {
      id: 'devtools',
      label: t('contextMenu.openDevTools'),
      onSelect: () => {
        void desktopApi.openDeveloperTools().catch(() => undefined);
      },
    },
  ];
}

type AppContextMenuValue = {
  open: (input: OpenProductContextMenuInput) => void;
  close: () => void;
  openSurfaceMenu: (
    event: ReactMouseEvent | MouseEvent,
    items: ProductContextMenuItem[]
  ) => boolean;
};

const AppContextMenuContext = createContext<AppContextMenuValue | null>(null);

function cutFromInput(el: HTMLInputElement | HTMLTextAreaElement) {
  const start = el.selectionStart ?? 0;
  const end = el.selectionEnd ?? 0;
  if (end <= start) return;
  const selected = el.value.slice(start, end);
  void writeClipboardViaBridge(selected);
  const next = el.value.slice(0, start) + el.value.slice(end);
  el.value = next;
  el.setSelectionRange(start, start);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function pasteIntoInput(
  el: HTMLInputElement | HTMLTextAreaElement,
  text: string
) {
  const start = el.selectionStart ?? 0;
  const end = el.selectionEnd ?? 0;
  el.value = el.value.slice(0, start) + text + el.value.slice(end);
  const caret = start + text.length;
  el.setSelectionRange(caret, caret);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function buildEditMenu(
  target: EventTarget | null,
  t: (key: string) => string
): ProductContextMenuItem[] {
  const selected = getContextMenuSelectedText(target);
  const readOnly = isReadOnlyEditable(target);
  const canCopy = selected.length > 0;
  const canCut = canCopy && !readOnly;
  const canPaste = !readOnly;
  const items: ProductContextMenuItem[] = [];
  if (canCut) {
    items.push({
      id: 'cut',
      label: t('contextMenu.cut'),
      onSelect: () => {
        if (
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement
        ) {
          cutFromInput(target);
        } else {
          const text = getContextMenuSelectedText(target);
          void writeClipboardViaBridge(text);
          document.execCommand('delete');
        }
      },
    });
  }
  items.push({
    id: 'copy',
    label: t('contextMenu.copy'),
    disabled: !canCopy,
    onSelect: () => {
      void writeClipboardViaBridge(selected);
    },
  });
  if (canPaste) {
    items.push({
      id: 'paste',
      label: t('contextMenu.paste'),
      onSelect: () => {
        void readClipboardViaBridge().then((text) => {
          if (
            target instanceof HTMLInputElement ||
            target instanceof HTMLTextAreaElement
          ) {
            target.focus();
            pasteIntoInput(target, text);
            return;
          }
          if (target instanceof HTMLElement) {
            target.focus();
            document.execCommand('insertText', false, text);
          }
        });
      },
    });
  }
  return items;
}

function withSelectionCopy(
  items: ProductContextMenuItem[],
  target: EventTarget | null,
  copyLabel: string
): ProductContextMenuItem[] {
  const selected = getContextMenuSelectedText(target).trim();
  if (!selected) return items;
  if (
    items[0] &&
    items[0].type !== 'submenu' &&
    items[0].type !== 'separator' &&
    items[0].id === 'copy'
  ) {
    return items;
  }
  return [
    {
      id: 'copy-selection',
      label: copyLabel,
      onSelect: () => {
        void writeClipboardViaBridge(selected);
      },
    },
    { type: 'separator', id: 'copy-selection-sep' },
    ...items,
  ];
}

function buildPluginContextMenuItems(
  contributions: readonly SlotContribution[],
  target: EventTarget | null
): ProductContextMenuItem[] {
  if (contributions.length === 0) return [];
  const selectedText = getContextMenuSelectedText(target).trim();
  const isFileTree =
    target instanceof Element &&
    Boolean(
      target.closest(
        '[data-panel-id="file-tree"], [data-testid*="file-tree"], .file-tree'
      )
    );
  const contextPayload: Record<string, unknown> = {
    target,
    selectedText,
    zone: isFileTree ? 'file-tree' : 'message',
  };

  return contributions
    .filter((contrib) => {
      if (
        contrib.slot === 'file-tree.context-menu' &&
        target instanceof Element
      ) {
        if (!isFileTree && !contrib.when) return false;
      }
      if (contrib.when) {
        try {
          return Boolean(contrib.when(contextPayload));
        } catch {
          return false;
        }
      }
      return true;
    })
    .map((contrib) => ({
      id: `plugin-ctx:${contrib.pluginId ?? 'builtin'}:${contrib.id}`,
      label: contrib.label ?? contrib.id,
      onSelect: () => {
        void Promise.resolve(contrib.onActivate?.(contextPayload)).catch(
          () => undefined
        );
      },
    }));
}

function withPluginItems(
  baseItems: ProductContextMenuItem[],
  pluginItems: ProductContextMenuItem[]
): ProductContextMenuItem[] {
  if (pluginItems.length === 0) return baseItems;
  if (baseItems.length === 0) return pluginItems;
  const existingIds = new Set(
    baseItems.filter((item) => item.type !== 'separator').map((item) => item.id)
  );
  const freshPluginItems = pluginItems.filter(
    (item) => item.type !== 'separator' && !existingIds.has(item.id)
  );
  if (freshPluginItems.length === 0) return baseItems;
  return [
    ...baseItems,
    { type: 'separator', id: 'plugin-context-menu-sep' },
    ...freshPluginItems,
  ];
}

export function AppContextMenuHost({ children }: { children: ReactNode }) {
  const { t } = useTranslation('common');
  const [menu, setMenu] = useState<OpenProductContextMenuInput | null>(null);
  const [desktopDevState, setDesktopDevState] = useState<DesktopDeveloperState>(
    () => readDesktopDeveloperState()
  );
  const targetRef = useRef<EventTarget | null>(null);
  const messageMenuContribs = useSlotContributions('message.context-menu');
  const fileTreeMenuContribs = useSlotContributions('file-tree.context-menu');
  const allPluginMenuContribs = useMemo(
    () => [...messageMenuContribs, ...fileTreeMenuContribs],
    [messageMenuContribs, fileTreeMenuContribs]
  );

  useEffect(() => {
    const bridge =
      typeof window !== 'undefined' ? window.dimoDesktop : undefined;
    if (!bridge) {
      return;
    }
    setDesktopDevState(readDesktopDeveloperState());
    let cancelled = false;
    if (typeof bridge.isDeveloperMode !== 'function') {
      void desktopApi
        .getDeveloperMode()
        .then((enabled) => {
          if (!cancelled) {
            setDesktopDevState((prev) => ({
              ...prev,
              developerMode: Boolean(enabled),
            }));
          }
        })
        .catch(() => undefined);
    }
    let unlisten: (() => void) | null = null;
    void bridge.events
      ?.listen?.(DEVELOPER_MODE_CHANGED_EVENT, (payload) => {
        const enabled =
          typeof payload === 'object' &&
          payload !== null &&
          'enabled' in payload
            ? Boolean((payload as { enabled?: unknown }).enabled)
            : Boolean(bridge.isDeveloperMode?.());
        setDesktopDevState((prev) => ({
          ...prev,
          developerMode: enabled,
        }));
      })
      .then((fn) => {
        if (cancelled) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const developerMenuEnabled =
    desktopDevState.isDev || desktopDevState.developerMode;

  const close = useCallback(() => setMenu(null), []);

  const open = useCallback((input: OpenProductContextMenuInput) => {
    dismissActiveProductContextMenu();
    setMenu(input.items.length > 0 ? input : null);
  }, []);

  const openSurfaceMenu = useCallback(
    (event: ReactMouseEvent | MouseEvent, items: ProductContextMenuItem[]) => {
      if (
        isForbiddenContextMenuTarget(event.target) ||
        isEditableContextMenuTarget(event.target)
      ) {
        return false;
      }
      event.preventDefault();
      event.stopPropagation();
      targetRef.current = event.target;
      const baseItems = withSelectionCopy(
        items,
        event.target,
        t('contextMenu.copy')
      );
      const pluginItems = buildPluginContextMenuItems(
        allPluginMenuContribs,
        event.target
      );
      open({
        x: event.clientX,
        y: event.clientY,
        items: withPluginItems(baseItems, pluginItems),
      });
      return true;
    },
    [allPluginMenuContribs, open, t]
  );

  useEffect(() => {
    const onCapture = (event: MouseEvent) => {
      event.preventDefault();
      if (
        developerMenuEnabled &&
        event.shiftKey &&
        !isForbiddenContextMenuTarget(event.target)
      ) {
        event.stopPropagation();
        targetRef.current = event.target;
        open({
          x: event.clientX,
          y: event.clientY,
          items: withSelectionCopy(
            buildDeveloperMenuItems(event.clientX, event.clientY, t),
            event.target,
            t('contextMenu.copy')
          ),
        });
      }
    };
    const onBubble = (event: MouseEvent) => {
      if (isForbiddenContextMenuTarget(event.target)) {
        close();
        return;
      }
      if (isEditableContextMenuTarget(event.target)) {
        targetRef.current = event.target;
        open({
          x: event.clientX,
          y: event.clientY,
          items: buildEditMenu(event.target, t),
        });
        return;
      }
      const pluginItems = buildPluginContextMenuItems(
        allPluginMenuContribs,
        event.target
      );
      if (developerMenuEnabled) {
        targetRef.current = event.target;
        const devItems = buildDeveloperMenuItems(
          event.clientX,
          event.clientY,
          t
        );
        open({
          x: event.clientX,
          y: event.clientY,
          items: withSelectionCopy(
            withPluginItems(devItems, pluginItems),
            event.target,
            t('contextMenu.copy')
          ),
        });
        return;
      }
      if (pluginItems.length > 0) {
        targetRef.current = event.target;
        open({
          x: event.clientX,
          y: event.clientY,
          items: pluginItems,
        });
        return;
      }
      close();
    };
    document.addEventListener('contextmenu', onCapture, true);
    document.addEventListener('contextmenu', onBubble);
    return () => {
      document.removeEventListener('contextmenu', onCapture, true);
      document.removeEventListener('contextmenu', onBubble);
    };
  }, [allPluginMenuContribs, close, developerMenuEnabled, open, t]);

  useEffect(() => {
    if (!developerMenuEnabled) {
      return;
    }
    const isMac =
      typeof navigator !== 'undefined' &&
      /mac/i.test(navigator.platform || navigator.userAgent);
    if (isMac) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        !event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        event.metaKey ||
        event.repeat
      ) {
        return;
      }
      const isKeyR = event.code === 'KeyR' || event.key.toLowerCase() === 'r';
      if (!isKeyR || isForbiddenContextMenuTarget(event.target)) {
        return;
      }
      event.preventDefault();
      void desktopApi.reloadWindow().catch(() => {
        window.location.reload();
      });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [developerMenuEnabled]);

  const value = useMemo(
    () => ({ open, close, openSurfaceMenu }),
    [close, open, openSurfaceMenu]
  );

  return (
    <AppContextMenuContext.Provider value={value}>
      {children}
      {menu ? (
        <ProductContextMenu
          x={menu.x}
          y={menu.y}
          items={menu.items}
          header={menu.header}
          ariaLabel={menu.ariaLabel}
          onClose={close}
        />
      ) : null}
    </AppContextMenuContext.Provider>
  );
}

const NOOP_MENU: AppContextMenuValue = {
  open: () => undefined,
  close: () => undefined,
  openSurfaceMenu: (event) => {
    if (
      isForbiddenContextMenuTarget(event.target) ||
      isEditableContextMenuTarget(event.target)
    ) {
      return false;
    }
    event.preventDefault();
    event.stopPropagation();
    return true;
  },
};

export function useAppContextMenu(): AppContextMenuValue {
  return useContext(AppContextMenuContext) ?? NOOP_MENU;
}
