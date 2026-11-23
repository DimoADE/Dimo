import {
  useEffect,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type MutableRefObject,
  type PointerEvent,
  type RefObject,
  type UIEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { FolderOpen } from 'lucide-react';
import {
  ChatComposerInput,
  type ChatComposerInputHandle,
  type ChatComposerTrigger,
} from '@astryxdesign/core/Chat';
import { requestConversationScrollToQuote } from '@/lib/conversationScroll';
import { cn } from '@/lib/utils';
import { prepareImageFileForUpload } from '@/utils/clipboard';
import { isAttachableFile } from '@/utils/mediaAttachments';
import { QuoteTokenPreview } from '../QuoteTokenPreview';
import {
  astryxHandlesComposerSubmit,
  composerEnterAction,
  isComposerImeCommitEnter,
} from '../sessionComposerSubmitHotkey';
import { ComposerAtReferencePanel } from '../ComposerAtReferenceMenu';
import type { SendMessageShortcut } from 'shared/types';
import {
  hasQuoteSourceAnchor,
  type SessionComposerStructuredToken,
} from '../sessionComposerStructuredTokens';
import {
  getHoverableTokenFromEventTarget,
  getStructuredHoverToken,
} from './composerSearch';
import { getSessionComposerEditable } from './sessionComposerDom';
import {
  findPastedTextChipBeforeCaret,
  isPastedTextTokenElement,
  PASTED_TEXT_TOKEN_KIND,
  serializeDomNodeWithTokens,
} from './pastedTextToken';
import { PastedTextTokenPreview } from './PastedTextTokenPreview';
import { PreviewElementTokenTooltip } from './PreviewElementTokenTooltip';
import type { ActiveComposerHover } from './useSessionComposerHover';
import type { useComposerAtReferencePanel } from '../useComposerAtReferencePanel';

type ScrollFadeState = 'none' | 'top' | 'bottom' | 'both';

function computeScrollFade(element: HTMLElement): ScrollFadeState {
  if (element.scrollHeight <= element.clientHeight + 2) {
    return 'none';
  }
  const canScrollUp = element.scrollTop > 2;
  const canScrollDown =
    element.scrollTop + element.clientHeight < element.scrollHeight - 2;
  if (canScrollUp && canScrollDown) return 'both';
  if (canScrollUp) return 'top';
  if (canScrollDown) return 'bottom';
  return 'none';
}

export function SessionComposerSurface({
  dropZoneRef,
  handleDragOver,
  handleDragLeave,
  handleDrop,
  dropActive,
  disabled,
  tryAcceptPromptSuggestionOnTab,
  handleTokenPointerOver,
  handleTokenPointerOut,
  handleTokenFocus,
  handleTokenBlur,
  composerRootRef,
  value,
  sessionId,
  promptSuggestion,
  hasActivePromptSuggestion = false,
  isComposing,
  onCompositionStateChange,
  onDismissPromptSuggestion,
  onChange,
  onUpdateQuoteAnnotation,
  atReference,
  className,
  effectivePlaceholder,
  triggers,
  composerHandleRef,
  lastCompositionEndAtRef,
  sendShortcut,
  handleHistoryKeyDown,
  handleSubmit,
  isMaterializingSubmitRef: _isMaterializingSubmitRef,
  onAttachImages,
  handleComposerPaste,
  activeHover,
  elementTokenTooltipId,
  quoteTokenTooltipId,
  pastedTextTokenTooltipId,
  showTokenHover,
  cancelHoverHide,
  hideTokenHover,
  setQuoteEditing,
  onExpandPastedTextChip,
  onRemovePastedTextChip,
  onUndoPastedTextChip,
}: {
  dropZoneRef: RefObject<HTMLDivElement | null>;
  handleDragOver: (event: DragEvent<HTMLDivElement>) => void;
  handleDragLeave: (event: DragEvent<HTMLDivElement>) => void;
  handleDrop: (event: DragEvent<HTMLDivElement>) => void;
  dropActive: boolean;
  disabled: boolean;
  tryAcceptPromptSuggestionOnTab: (
    event: KeyboardEvent<HTMLElement>
  ) => boolean;
  handleTokenPointerOver: (event: PointerEvent<HTMLDivElement>) => void;
  handleTokenPointerOut: (event: PointerEvent<HTMLDivElement>) => void;
  handleTokenFocus: (event: FocusEvent<HTMLDivElement>) => void;
  handleTokenBlur: (event: FocusEvent<HTMLDivElement>) => void;
  composerRootRef: RefObject<HTMLDivElement | null>;
  value: string;
  sessionId?: string | null;
  promptSuggestion: string | null | undefined;
  hasActivePromptSuggestion?: boolean;
  isComposing: boolean;
  onCompositionStateChange: (composing: boolean) => void;
  onDismissPromptSuggestion?: () => void;
  onChange: (value: string) => void;
  onUpdateQuoteAnnotation?: (
    anchor: HTMLElement,
    targetRaw: string,
    annotation: string
  ) => void;
  atReference: ReturnType<typeof useComposerAtReferencePanel>;
  className?: string;
  effectivePlaceholder: string;
  triggers: ChatComposerTrigger[];
  composerHandleRef: RefObject<ChatComposerInputHandle | null>;
  lastCompositionEndAtRef: MutableRefObject<number>;
  sendShortcut: SendMessageShortcut;
  handleHistoryKeyDown: (event: KeyboardEvent<HTMLDivElement>) => boolean;
  handleSubmit: (text: string) => void;
  isMaterializingSubmitRef: MutableRefObject<boolean>;
  onAttachImages: (files: File[]) => void;
  handleComposerPaste: (
    event: ClipboardEvent<HTMLDivElement>,
    text?: string
  ) => boolean;
  activeHover: ActiveComposerHover | null;
  elementTokenTooltipId: string;
  quoteTokenTooltipId: string;
  pastedTextTokenTooltipId: string;
  showTokenHover: (target: EventTarget | null) => void;
  cancelHoverHide: () => void;
  hideTokenHover: (anchor: HTMLElement, delayMs?: number) => void;
  setQuoteEditing?: (editing: boolean) => void;
  onExpandPastedTextChip?: (anchor: HTMLElement) => void;
  onRemovePastedTextChip?: (anchor: HTMLElement) => void;
  onUndoPastedTextChip?: () => boolean;
}) {
  const { t } = useTranslation('tasks');
  const [scrollFade, setScrollFade] = useState<ScrollFadeState>('none');

  useEffect(() => {
    if (!value) {
      setScrollFade((prev) => (prev === 'none' ? prev : 'none'));
      return undefined;
    }
    const rafId = window.requestAnimationFrame(() => {
      const editable = getSessionComposerEditable(composerRootRef.current);
      if (!editable) return;
      const next = computeScrollFade(editable);
      setScrollFade((prev) => (prev === next ? prev : next));
    });
    return () => window.cancelAnimationFrame(rafId);
  }, [composerRootRef, value]);

  const handleEditorScrollCapture = (event: UIEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (!target.hasAttribute('contenteditable')) return;
    const next = computeScrollFade(target);
    setScrollFade((prev) => (prev === next ? prev : next));
  };

  const jumpToQuoteToken = (token: SessionComposerStructuredToken) => {
    if (token.kind !== 'quote' || !hasQuoteSourceAnchor(token.quote)) return;
    requestConversationScrollToQuote({
      ...token.quote,
      conversationId: token.quote?.conversationId ?? (sessionId || undefined),
      snippet: token.value,
    });
  };

  const handleSurfaceClick = (event: MouseEvent<HTMLDivElement>) => {
    const anchor = getHoverableTokenFromEventTarget(event.target);
    if (!anchor) return;
    if (anchor.dataset.tokenKind === PASTED_TEXT_TOKEN_KIND) {
      showTokenHover(anchor);
      return;
    }
    const token = getStructuredHoverToken(anchor);
    if (token?.kind === 'quote' && hasQuoteSourceAnchor(token.quote)) {
      jumpToQuoteToken(token);
    }
  };

  const handleSurfaceCopy = (event: ClipboardEvent<HTMLDivElement>) => {
    const editor = getSessionComposerEditable(composerRootRef.current);
    if (!editor) return;

    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      if (!editor.contains(range.commonAncestorContainer)) return;
      const fragment = range.cloneContents();
      if (!fragment.querySelector('[data-pasted-text-token]')) return;
      event.preventDefault();
      event.clipboardData?.setData(
        'text/plain',
        serializeDomNodeWithTokens(fragment)
      );
      return;
    }

    if (
      document.activeElement instanceof HTMLElement &&
      isPastedTextTokenElement(document.activeElement) &&
      editor.contains(document.activeElement)
    ) {
      const raw = document.activeElement.dataset.astryxTokenValue ?? '';
      if (!raw) return;
      event.preventDefault();
      event.clipboardData?.setData('text/plain', raw);
    }
  };

  return (
    <div
      ref={dropZoneRef}
      className="session-composer-file-drop-zone min-w-0"
      data-file-reference-drop-zone
      data-testid="session-composer-file-drop-zone"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {dropActive ? (
        <div
          className="session-composer-drop-overlay"
          role="status"
          aria-label={t('composer.dropFiles')}
        >
          <FolderOpen aria-hidden="true" />
          <strong>{t('composer.dropFiles')}</strong>
        </div>
      ) : null}
      <div
        className={cn(
          'session-composer-input-surface min-h-[1.75rem] px-1 pb-1 pt-0',
          disabled && 'opacity-60'
        )}
        data-testid="session-composer-input-surface"
        data-prompt-suggestion={
          hasActivePromptSuggestion && !isComposing ? 'true' : undefined
        }
        data-scroll-fade={scrollFade !== 'none' ? scrollFade : undefined}
        onKeyDown={(event) => {
          tryAcceptPromptSuggestionOnTab(event);
        }}
        onClick={handleSurfaceClick}
        onCopy={handleSurfaceCopy}
        onScrollCapture={handleEditorScrollCapture}
        onPointerOver={handleTokenPointerOver}
        onPointerOut={handleTokenPointerOut}
        onFocusCapture={handleTokenFocus}
        onBlurCapture={(event) => {
          onCompositionStateChange(false);
          handleTokenBlur(event);
        }}
        onCompositionStartCapture={() => onCompositionStateChange(true)}
        onCompositionEndCapture={() => onCompositionStateChange(false)}
      >
        <ChatComposerInput
          ref={composerRootRef}
          value={value}
          onChange={(next) => {
            if (next && promptSuggestion) {
              onDismissPromptSuggestion?.();
            }
            onChange(next);
            if (atReference.isOpen || next.includes('@')) {
              queueMicrotask(() => atReference.detect());
            }
          }}
          isDisabled={disabled}
          className={cn(
            'session-composer-editor min-h-[1.75rem] w-full px-0.5 pb-1 pt-0 font-sans subpixel-antialiased text-[13px] leading-5 tracking-[0.005em]',
            className
          )}
          maxRows={7}
          placeholder={
            isComposing || value.length > 0 ? '' : effectivePlaceholder
          }
          label={t('composer.inputLabel')}
          hasHistory={false}
          pasteAsToken={false}
          triggers={triggers}
          handleRef={composerHandleRef}
          onKeyDown={(event) => {
            if (
              isComposerImeCommitEnter(event, lastCompositionEndAtRef.current)
            ) {
              return;
            }
            if (atReference.handleKeyDown(event)) {
              return;
            }
            if (tryAcceptPromptSuggestionOnTab(event)) {
              return;
            }
            if (
              !disabled &&
              (event.metaKey || event.ctrlKey) &&
              !event.shiftKey &&
              !event.altKey &&
              event.key.toLowerCase() === 'z'
            ) {
              if (onUndoPastedTextChip?.()) {
                event.preventDefault();
                return;
              }
            }
            if (
              !disabled &&
              (event.key === 'Backspace' || event.key === 'Delete')
            ) {
              const editor = getSessionComposerEditable(
                composerRootRef.current
              );
              if (
                editor &&
                document.activeElement instanceof HTMLElement &&
                isPastedTextTokenElement(document.activeElement) &&
                editor.contains(document.activeElement)
              ) {
                event.preventDefault();
                onRemovePastedTextChip?.(document.activeElement);
                return;
              }
              const selection = window.getSelection();
              if (
                editor &&
                selection &&
                selection.isCollapsed &&
                selection.rangeCount > 0
              ) {
                const range = selection.getRangeAt(0);
                const startNode = range.startContainer;
                const insideToken =
                  startNode instanceof HTMLElement
                    ? startNode.closest<HTMLElement>('[data-astryx-token]')
                    : startNode.parentElement?.closest<HTMLElement>(
                        '[data-astryx-token]'
                      );
                if (insideToken && editor.contains(insideToken)) {
                  event.preventDefault();
                  if (
                    insideToken.dataset.tokenKind === PASTED_TEXT_TOKEN_KIND
                  ) {
                    onRemovePastedTextChip?.(insideToken);
                    return;
                  }
                  const next = insideToken.nextSibling;
                  if (
                    next?.nodeType === Node.TEXT_NODE &&
                    /^[\u00A0\u200B\uFEFF]+$/.test(next.textContent ?? '')
                  ) {
                    next.remove();
                  }
                  insideToken.remove();
                  editor.dispatchEvent(new Event('input', { bubbles: true }));
                  return;
                }
                if (event.key === 'Backspace') {
                  const precedingPastedChip = findPastedTextChipBeforeCaret(
                    editor,
                    range
                  );
                  if (precedingPastedChip) {
                    event.preventDefault();
                    onRemovePastedTextChip?.(precedingPastedChip);
                    return;
                  }
                }
              }
            }
            if (handleHistoryKeyDown(event)) {
              return;
            }
            const action = composerEnterAction(
              sendShortcut,
              event,
              lastCompositionEndAtRef.current
            );
            if (action === 'defer') {
              if (!event.shiftKey && astryxHandlesComposerSubmit(event)) {
                event.preventDefault();
                const text = composerHandleRef.current?.getValue().trim() ?? '';
                if (text) {
                  handleSubmit(text);
                }
              }
              return;
            }
            event.preventDefault();
            if (action === 'newline') {
              composerHandleRef.current?.insertText('\n');
              onChange(composerHandleRef.current?.getValue() ?? value);
              return;
            }
            const text = composerHandleRef.current?.getValue().trim() ?? '';
            if (!text) return;
            handleSubmit(text);
          }}
          onSubmit={handleSubmit}
          onFiles={(files) => {
            const attached = files
              .filter(isAttachableFile)
              .map(prepareImageFileForUpload);
            if (attached.length > 0) onAttachImages(attached);
          }}
          onPaste={handleComposerPaste}
          data-testid="session-composer-editor"
        />
        {activeHover?.target.kind === 'structured' &&
        activeHover.target.token.kind === 'element' ? (
          <PreviewElementTokenTooltip
            anchor={activeHover.anchor}
            id={elementTokenTooltipId}
            token={activeHover.target.token}
          />
        ) : null}
        {activeHover?.target.kind === 'structured' &&
        activeHover.target.token.kind === 'quote' ? (
          <QuoteTokenPreview
            anchor={activeHover.anchor}
            id={quoteTokenTooltipId}
            text={activeHover.target.token.value}
            quoteMeta={activeHover.target.token.quote}
            onJumpToSource={
              hasQuoteSourceAnchor(activeHover.target.token.quote)
                ? () => {
                    if (activeHover.target.kind === 'structured') {
                      jumpToQuoteToken(activeHover.target.token);
                    }
                  }
                : undefined
            }
            onUpdateAnnotation={
              !disabled && onUpdateQuoteAnnotation
                ? (nextNote) => {
                    if (activeHover.target.kind === 'structured') {
                      onUpdateQuoteAnnotation(
                        activeHover.anchor,
                        activeHover.target.token.raw,
                        nextNote
                      );
                    }
                  }
                : undefined
            }
            onEditingChange={setQuoteEditing}
            onPointerEnter={cancelHoverHide}
            onPointerLeave={() => hideTokenHover(activeHover.anchor, 120)}
          />
        ) : null}
        {activeHover?.target.kind === 'pasted_text' ? (
          <PastedTextTokenPreview
            anchor={activeHover.anchor}
            id={pastedTextTokenTooltipId}
            text={activeHover.target.text}
            lineCount={activeHover.target.lineCount}
            charCount={activeHover.target.charCount}
            disabled={disabled}
            onExpand={
              onExpandPastedTextChip
                ? () => onExpandPastedTextChip(activeHover.anchor)
                : undefined
            }
            onRemove={
              onRemovePastedTextChip
                ? () => onRemovePastedTextChip(activeHover.anchor)
                : undefined
            }
            onPointerEnter={cancelHoverHide}
            onPointerLeave={() => hideTokenHover(activeHover.anchor, 120)}
          />
        ) : null}
      </div>
      {atReference.panel ? (
        <ComposerAtReferencePanel
          groups={atReference.panel.groups}
          activeTab={atReference.panel.activeTab}
          selectedIndex={atReference.panel.selectedIndex}
          loading={atReference.panel.loading}
          anchor={dropZoneRef.current}
          onSelectTab={atReference.selectTab}
          onSelectItem={atReference.selectItem}
        />
      ) : null}
    </div>
  );
}
