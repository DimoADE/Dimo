import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type PointerEvent,
} from 'react';
import {
  getComposerHoverTarget,
  getHoverableTokenFromEventTarget,
  type ComposerHoverTarget,
} from './composerSearch';

export type ActiveComposerHover = {
  anchor: HTMLElement;
  target: ComposerHoverTarget;
};

function isSameHoverTarget(
  a: ComposerHoverTarget,
  b: ComposerHoverTarget
): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'pasted_text' && b.kind === 'pasted_text') {
    return a.text === b.text;
  }
  if (a.kind === 'structured' && b.kind === 'structured') {
    return a.token.raw === b.token.raw;
  }
  return false;
}

export function useSessionComposerHover() {
  const elementTokenTooltipId = useId();
  const quoteTokenTooltipId = useId();
  const pastedTextTokenTooltipId = useId();
  const hoverHideTimerRef = useRef<number | null>(null);
  const quoteEditingRef = useRef(false);
  const [activeHover, setActiveHover] = useState<ActiveComposerHover | null>(
    null
  );

  const cancelHoverHide = useCallback(() => {
    if (hoverHideTimerRef.current != null) {
      window.clearTimeout(hoverHideTimerRef.current);
      hoverHideTimerRef.current = null;
    }
  }, []);

  const setQuoteEditing = useCallback(
    (editing: boolean) => {
      quoteEditingRef.current = editing;
      if (editing) {
        cancelHoverHide();
      }
    },
    [cancelHoverHide]
  );

  const showTokenHover = useCallback(
    (target: EventTarget | null) => {
      const anchor = getHoverableTokenFromEventTarget(target);
      if (!anchor) return;
      const resolved = getComposerHoverTarget(anchor);
      if (!resolved) return;
      cancelHoverHide();
      setActiveHover((current) => {
        if (
          current?.anchor === anchor &&
          isSameHoverTarget(current.target, resolved)
        ) {
          return current;
        }
        quoteEditingRef.current = false;
        return { anchor, target: resolved };
      });
    },
    [cancelHoverHide]
  );

  const dismissTokenHover = useCallback(() => {
    cancelHoverHide();
    quoteEditingRef.current = false;
    setActiveHover(null);
  }, [cancelHoverHide]);

  const hideTokenHover = useCallback(
    (anchor: HTMLElement, delayMs = 0) => {
      if (quoteEditingRef.current) return;
      const hide = () => {
        if (quoteEditingRef.current) return;
        setActiveHover((current) =>
          current?.anchor === anchor ? null : current
        );
        hoverHideTimerRef.current = null;
      };
      cancelHoverHide();
      if (delayMs <= 0) {
        hide();
        return;
      }
      hoverHideTimerRef.current = window.setTimeout(hide, delayMs);
    },
    [cancelHoverHide]
  );

  const handleTokenPointerOver = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      showTokenHover(event.target);
    },
    [showTokenHover]
  );

  const handleTokenPointerOut = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const anchor = getHoverableTokenFromEventTarget(event.target);
      if (!anchor) return;
      if (
        event.relatedTarget instanceof Node &&
        anchor.contains(event.relatedTarget)
      ) {
        return;
      }
      hideTokenHover(anchor, 120);
    },
    [hideTokenHover]
  );

  const handleTokenFocus = useCallback(
    (event: FocusEvent<HTMLDivElement>) => {
      showTokenHover(event.target);
    },
    [showTokenHover]
  );

  const handleTokenBlur = useCallback(
    (event: FocusEvent<HTMLDivElement>) => {
      const anchor = getHoverableTokenFromEventTarget(event.target);
      if (anchor) hideTokenHover(anchor, 120);
    },
    [hideTokenHover]
  );

  useEffect(() => () => cancelHoverHide(), [cancelHoverHide]);

  useEffect(() => {
    const anchor = activeHover?.anchor;
    if (!anchor) {
      quoteEditingRef.current = false;
      return undefined;
    }
    if (!anchor.isConnected) {
      quoteEditingRef.current = false;
      setActiveHover(null);
      return undefined;
    }
    const observer = new MutationObserver(() => {
      if (!anchor.isConnected) {
        quoteEditingRef.current = false;
        setActiveHover(null);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [activeHover]);

  useEffect(() => {
    const anchor = activeHover?.anchor;
    if (!anchor) return undefined;
    const tooltipId =
      activeHover.target.kind === 'pasted_text'
        ? pastedTextTokenTooltipId
        : activeHover.target.token.kind === 'quote'
          ? quoteTokenTooltipId
          : elementTokenTooltipId;

    const previousDescription = anchor.getAttribute('aria-describedby');
    const descriptionIds = new Set(
      previousDescription?.split(/\s+/).filter(Boolean) ?? []
    );
    descriptionIds.add(tooltipId);
    anchor.setAttribute(
      'aria-describedby',
      Array.from(descriptionIds).join(' ')
    );

    return () => {
      const remainingIds = new Set(
        anchor.getAttribute('aria-describedby')?.split(/\s+/).filter(Boolean) ??
          []
      );
      remainingIds.delete(tooltipId);
      if (remainingIds.size > 0) {
        anchor.setAttribute(
          'aria-describedby',
          Array.from(remainingIds).join(' ')
        );
      } else {
        anchor.removeAttribute('aria-describedby');
      }
    };
  }, [
    activeHover,
    elementTokenTooltipId,
    pastedTextTokenTooltipId,
    quoteTokenTooltipId,
  ]);

  return {
    elementTokenTooltipId,
    quoteTokenTooltipId,
    pastedTextTokenTooltipId,
    activeHover,
    showTokenHover,
    dismissTokenHover,
    cancelHoverHide,
    hideTokenHover,
    setQuoteEditing,
    handleTokenPointerOver,
    handleTokenPointerOut,
    handleTokenFocus,
    handleTokenBlur,
  };
}
