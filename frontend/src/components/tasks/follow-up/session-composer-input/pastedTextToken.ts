import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FileText } from 'lucide-react';
import { prepareEmptyComposerForTokenInsert } from './sessionComposerDom';

export const PASTED_TEXT_TOKEN_KIND = 'pasted_text';
export const PASTED_TEXT_CHIP_MIN_CHARS = 1000;
export const PASTED_TEXT_CHIP_MIN_LINES = 10;

export type PastedTextMetrics = {
  lineCount: number;
  charCount: number;
};

export type PastedChipUndoEntry = {
  chip: HTMLSpanElement;
  spacer: Text | null;
  replacedText: string;
  valueAfterInsert: string | null;
};

let cachedPastedIconMarkup: string | null = null;

function pastedTextIconMarkup(): string {
  if (cachedPastedIconMarkup === null) {
    cachedPastedIconMarkup = renderToStaticMarkup(
      createElement(FileText, { className: 'h-3 w-3 shrink-0' })
    );
  }
  return cachedPastedIconMarkup;
}

export function normalizePastedText(text: string): string {
  if (!text.includes('\r')) return text;
  return text.replace(/\r\n?/g, '\n');
}

export function measurePastedText(text: string): PastedTextMetrics {
  const charCount = text.length;
  if (charCount === 0) {
    return { lineCount: 0, charCount: 0 };
  }
  let lineCount = 1;
  let pos = text.indexOf('\n');
  while (pos !== -1) {
    lineCount += 1;
    pos = text.indexOf('\n', pos + 1);
  }
  return { lineCount, charCount };
}

export function shouldFoldPastedTextAsChip(text: string): boolean {
  if (!text) return false;
  if (text.length >= PASTED_TEXT_CHIP_MIN_CHARS) return true;
  let lineCount = 1;
  let pos = text.indexOf('\n');
  while (pos !== -1) {
    lineCount += 1;
    if (lineCount >= PASTED_TEXT_CHIP_MIN_LINES) return true;
    pos = text.indexOf('\n', pos + 1);
  }
  return false;
}

export function isPastedTextTokenElement(
  node: Node | null | undefined
): node is HTMLElement {
  return (
    node instanceof HTMLElement &&
    node.hasAttribute('data-astryx-token') &&
    node.dataset.tokenKind === PASTED_TEXT_TOKEN_KIND
  );
}

export function serializeDomNodeWithTokens(node: Node): string {
  let result = '';
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      result += child.textContent ?? '';
    } else if (child instanceof HTMLElement) {
      if (child.hasAttribute('data-astryx-token')) {
        result += child.getAttribute('data-astryx-token-value') ?? '';
      } else if (child.tagName === 'BR') {
        result += '\n';
      } else if (child.tagName === 'DIV' || child.tagName === 'P') {
        if (result.length > 0) {
          result += '\n';
        }
        const inner = serializeDomNodeWithTokens(child);
        result += inner === '\n' ? '' : inner;
      } else {
        result += serializeDomNodeWithTokens(child);
      }
    }
  }
  return result;
}

export function createPastedTextChipElement(
  text: string,
  label: string
): HTMLSpanElement {
  const metrics = measurePastedText(text);
  const chip = document.createElement('span');
  chip.setAttribute('data-astryx-token', '');
  chip.setAttribute('data-astryx-token-value', text);
  chip.setAttribute('data-astryx-token-source-length', String(text.length));
  chip.setAttribute('data-astryx-restored-token', '');
  chip.dataset.tokenKind = PASTED_TEXT_TOKEN_KIND;
  chip.dataset.pastedTextToken = '';
  chip.dataset.pastedLineCount = String(metrics.lineCount);
  chip.dataset.pastedCharCount = String(metrics.charCount);
  chip.contentEditable = 'false';
  chip.tabIndex = 0;
  chip.setAttribute('aria-label', label);

  const iconHost = document.createElement('span');
  iconHost.setAttribute('aria-hidden', 'true');
  iconHost.className = 'session-composer-token-icon inline-flex shrink-0';
  iconHost.innerHTML = pastedTextIconMarkup();

  const labelEl = document.createElement('span');
  labelEl.className =
    'session-composer-token-label truncate font-medium tabular-nums';
  labelEl.textContent = label;

  chip.append(iconHost, labelEl);
  return chip;
}

function removeTrailingTokenSpacer(chip: HTMLElement): void {
  let following = chip.nextSibling;
  while (following?.nodeType === Node.TEXT_NODE) {
    const next = following.nextSibling;
    const text = following.textContent ?? '';
    const withoutSpacer = text.replace(/^[\u00A0\u200B\uFEFF]+/, '');
    if (withoutSpacer === text) break;
    if (withoutSpacer) {
      following.textContent = withoutSpacer;
      break;
    }
    following.remove();
    following = next;
  }
}

export function insertPastedTextChipAtSelection(
  editor: HTMLElement,
  text: string,
  label: string
): PastedChipUndoEntry | null {
  if (!text) return null;
  prepareEmptyComposerForTokenInsert(editor);
  editor.focus();

  const selection = window.getSelection();
  if (!selection) return null;

  let range: Range;
  if (
    selection.rangeCount > 0 &&
    editor.contains(selection.getRangeAt(0).commonAncestorContainer)
  ) {
    range = selection.getRangeAt(0);
  } else {
    range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  let replacedText = '';
  if (!range.collapsed) {
    replacedText = serializeDomNodeWithTokens(range.cloneContents());
    range.deleteContents();
  }

  const chip = createPastedTextChipElement(text, label);
  range.insertNode(chip);

  const spacer = document.createTextNode('\u00A0');
  chip.after(spacer);

  const nextRange = document.createRange();
  nextRange.setStartAfter(spacer);
  nextRange.collapse(true);
  selection.removeAllRanges();
  selection.addRange(nextRange);

  return {
    chip,
    spacer,
    replacedText,
    valueAfterInsert: null,
  };
}

export function expandPastedTextChip(
  editor: HTMLElement,
  chip: HTMLElement
): Text | null {
  if (!chip.isConnected || !editor.contains(chip)) return null;
  const raw = chip.dataset.astryxTokenValue ?? '';
  removeTrailingTokenSpacer(chip);
  const textNode = document.createTextNode(raw);
  chip.replaceWith(textNode);

  editor.focus();
  const selection = window.getSelection();
  if (selection) {
    const range = document.createRange();
    range.setStart(textNode, textNode.length);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  return textNode;
}

export function removePastedTextChip(
  editor: HTMLElement,
  chip: HTMLElement
): boolean {
  if (!chip.isConnected || !editor.contains(chip)) return false;
  const parent = chip.parentNode;
  if (!parent) return false;
  const index = Array.from(parent.childNodes).indexOf(chip);
  removeTrailingTokenSpacer(chip);
  chip.remove();

  editor.focus();
  const selection = window.getSelection();
  if (selection) {
    const range = document.createRange();
    range.setStart(
      parent,
      Math.max(0, Math.min(index, parent.childNodes.length))
    );
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  return true;
}

export function findPastedTextChipBeforeCaret(
  editor: HTMLElement,
  range: Range
): HTMLElement | null {
  if (!range.collapsed) return null;
  const { startContainer, startOffset } = range;

  if (startContainer.nodeType === Node.TEXT_NODE) {
    const prev = startContainer.previousSibling;
    if (!isPastedTextTokenElement(prev) || !editor.contains(prev)) {
      return null;
    }
    if (startOffset === 0) {
      return prev;
    }
    const text = startContainer.textContent ?? '';
    if (startOffset === text.length && /^[\u00A0\u200B\uFEFF]+$/.test(text)) {
      return prev;
    }
    return null;
  }

  if (startContainer instanceof HTMLElement && startOffset > 0) {
    const prev = startContainer.childNodes[startOffset - 1];
    if (isPastedTextTokenElement(prev) && editor.contains(prev)) {
      return prev;
    }
    if (
      prev?.nodeType === Node.TEXT_NODE &&
      /^[\u00A0\u200B\uFEFF]+$/.test(prev.textContent ?? '') &&
      isPastedTextTokenElement(prev.previousSibling) &&
      editor.contains(prev.previousSibling)
    ) {
      return prev.previousSibling;
    }
  }

  return null;
}

export function undoPastedTextChipInsert(
  editor: HTMLElement,
  entry: PastedChipUndoEntry
): boolean {
  const { chip, replacedText } = entry;
  if (!chip.isConnected || !editor.contains(chip)) return false;
  const parent = chip.parentNode;
  if (!parent) return false;
  const index = Array.from(parent.childNodes).indexOf(chip);
  removeTrailingTokenSpacer(chip);

  if (replacedText) {
    const restored = document.createTextNode(replacedText);
    chip.replaceWith(restored);
    editor.focus();
    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      range.setStart(restored, restored.length);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    return true;
  }

  chip.remove();
  editor.focus();
  const selection = window.getSelection();
  if (selection) {
    const range = document.createRange();
    range.setStart(
      parent,
      Math.max(0, Math.min(index, parent.childNodes.length))
    );
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  return true;
}
