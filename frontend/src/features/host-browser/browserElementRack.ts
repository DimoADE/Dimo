import { create } from 'zustand';

export const BROWSER_ELEMENT_DROP_EVENT = 'dimo-browser-element-drop';
const MAX_STAGED_ELEMENTS_PER_TAB = 20;

export interface StagedBrowserElement {
  id: string;
  tabId: string | null;
  label: string;
  tokenValue: string;
  selector: string;
  description: string;
  imageFile: File | null;
  imagePromise?: Promise<File | null>;
}

interface BrowserElementRackState {
  items: StagedBrowserElement[];
}

let nextElementSeq = 1;

export const useBrowserElementRackStore = create<BrowserElementRackState>(
  () => ({
    items: [],
  })
);

export function stagePickedBrowserElement(input: {
  tabId?: string | null;
  label: string;
  tokenValue: string;
  selector?: string;
  description?: string;
  imagePromise?: Promise<File | null>;
}): string {
  const id = `browser-el-${nextElementSeq++}`;
  const tabId = input.tabId ?? null;
  const item: StagedBrowserElement = {
    id,
    tabId,
    label: input.label,
    tokenValue: input.tokenValue,
    selector: input.selector?.trim() ?? '',
    description: input.description?.trim() ?? '',
    imageFile: null,
    ...(input.imagePromise ? { imagePromise: input.imagePromise } : {}),
  };

  useBrowserElementRackStore.setState((state) => {
    const otherTabItems = state.items.filter((entry) => entry.tabId !== tabId);
    const sameTabItems = state.items.filter((entry) => entry.tabId === tabId);
    const nextSameTab = [...sameTabItems, item];
    const trimmedSameTab =
      nextSameTab.length > MAX_STAGED_ELEMENTS_PER_TAB
        ? nextSameTab.slice(-MAX_STAGED_ELEMENTS_PER_TAB)
        : nextSameTab;
    return {
      items: [...otherTabItems, ...trimmedSameTab],
    };
  });

  return id;
}

export function setPickedBrowserElementImagePromise(
  id: string,
  imagePromise: Promise<File | null>
): void {
  useBrowserElementRackStore.setState((state) => {
    const index = state.items.findIndex((item) => item.id === id);
    if (index === -1) return state;
    const nextItems = state.items.slice();
    nextItems[index] = {
      ...nextItems[index],
      imagePromise,
    };
    return { items: nextItems };
  });
}

export function attachPickedBrowserElementImage(
  id: string,
  imageFile: File
): void {
  useBrowserElementRackStore.setState((state) => {
    const index = state.items.findIndex((item) => item.id === id);
    if (index === -1) return state;
    const nextItems = state.items.slice();
    nextItems[index] = {
      ...nextItems[index],
      imageFile,
    };
    return { items: nextItems };
  });
}

export function removeStagedBrowserElement(id: string): void {
  useBrowserElementRackStore.setState((state) => {
    const nextItems = state.items.filter((item) => item.id !== id);
    if (nextItems.length === state.items.length) return state;
    return { items: nextItems };
  });
}

export function clearStagedBrowserElements(tabId?: string | null): void {
  if (tabId == null) {
    useBrowserElementRackStore.setState({ items: [] });
    return;
  }
  useBrowserElementRackStore.setState((state) => {
    const nextItems = state.items.filter((item) => item.tabId !== tabId);
    if (nextItems.length === state.items.length) return state;
    return { items: nextItems };
  });
}

export type BrowserElementDragState = {
  isDragging: boolean;
  item: StagedBrowserElement | null;
  pointer: { x: number; y: number } | null;
};

let dragState: BrowserElementDragState = {
  isDragging: false,
  item: null,
  pointer: null,
};

const dragListeners = new Set<(state: BrowserElementDragState) => void>();

function emitDragState(): void {
  for (const listener of dragListeners) {
    listener(dragState);
  }
}

export function startBrowserElementDrag(
  item: StagedBrowserElement,
  pointer: { x: number; y: number }
): void {
  dragState = {
    isDragging: true,
    item,
    pointer,
  };
  emitDragState();
}

export function updateBrowserElementDragPointer(
  pointer: { x: number; y: number } | null
): void {
  if (!dragState.isDragging) return;
  dragState = {
    ...dragState,
    pointer,
  };
  emitDragState();
}

export function clearBrowserElementDrag(): void {
  if (!dragState.isDragging && !dragState.item && !dragState.pointer) return;
  dragState = {
    isDragging: false,
    item: null,
    pointer: null,
  };
  emitDragState();
}

export function getBrowserElementDragState(): BrowserElementDragState {
  return dragState;
}

export function subscribeBrowserElementDrag(
  listener: (state: BrowserElementDragState) => void
): () => void {
  dragListeners.add(listener);
  listener(dragState);
  return () => {
    dragListeners.delete(listener);
  };
}

export function dispatchBrowserElementDrop(
  clientX: number,
  clientY: number,
  overrideItem?: StagedBrowserElement | null
): boolean {
  const item = overrideItem ?? dragState.item;
  if (typeof document === 'undefined' || !item) {
    return false;
  }
  const latest =
    useBrowserElementRackStore.getState().items.find((i) => i.id === item.id) ??
    item;
  const element = document.elementFromPoint(clientX, clientY);
  if (!(element instanceof Element)) {
    return false;
  }
  const dropZone = element.closest('[data-file-reference-drop-zone]');
  if (!(dropZone instanceof HTMLElement)) {
    return false;
  }
  const event = new CustomEvent<StagedBrowserElement>(
    BROWSER_ELEMENT_DROP_EVENT,
    {
      detail: latest,
      bubbles: false,
      cancelable: true,
    }
  );
  // Listener calls `event.preventDefault()` when it accepts the drop.
  const notCancelled = dropZone.dispatchEvent(event);
  return !notCancelled;
}

export function resetBrowserElementRackForTests(): void {
  nextElementSeq = 1;
  clearBrowserElementDrag();
  useBrowserElementRackStore.setState({ items: [] });
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    clearStagedBrowserElements();
    clearBrowserElementDrag();
  });
}
