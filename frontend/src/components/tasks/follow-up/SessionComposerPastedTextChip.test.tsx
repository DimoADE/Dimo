import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import { SessionComposerInput } from './SessionComposerInput';
import { formatSessionComposerCommand } from './sessionComposerStructuredTokens';
import { requestComposerTokenInsert } from '@/lib/composerInsert';
import * as clipboardUtils from '@/utils/clipboard';

function renderControlledComposer({
  initialValue = '',
  onChangeSpy,
  onSubmit = vi.fn(),
}: {
  initialValue?: string;
  onChangeSpy?: (next: string) => void;
  onSubmit?: (text: string) => boolean | void;
} = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  function Harness() {
    const [value, setValue] = useState(initialValue);
    return (
      <SessionComposerInput
        value={value}
        onChange={(next) => {
          onChangeSpy?.(next);
          setValue(next);
        }}
        onSubmit={onSubmit}
        onAttachImages={vi.fn()}
      />
    );
  }

  return render(
    <QueryClientProvider client={queryClient}>
      <Harness />
    </QueryClientProvider>
  );
}

function getEditor(): HTMLDivElement {
  const surface = screen.getByTestId('session-composer-editor');
  return surface.querySelector('[contenteditable="true"]') as HTMLDivElement;
}

function pastePlainText(editor: HTMLElement, text: string) {
  fireEvent.paste(editor, {
    clipboardData: {
      files: [],
      getData: (type: string) => (type === 'text/plain' ? text : ''),
    },
  });
}

describe('SessionComposerInput pasted-text chip & paste performance', () => {
  it('keeps short pastes inline and avoids duplicate onChange emission', () => {
    const onChangeSpy = vi.fn();
    const execCommand = vi.fn((command: string, _ui: boolean, text: string) => {
      if (command !== 'insertText') return false;
      const editor = getEditor();
      editor.appendChild(document.createTextNode(text));
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    });
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      writable: true,
      value: execCommand,
    });

    try {
      renderControlledComposer({ initialValue: 'hello', onChangeSpy });
      const editor = getEditor();
      pastePlainText(editor, ' world');

      expect(execCommand).toHaveBeenCalledWith('insertText', false, ' world');
      expect(editor.querySelector('[data-pasted-text-token]')).toBeNull();
      expect(onChangeSpy).toHaveBeenCalledTimes(1);
      expect(onChangeSpy).toHaveBeenCalledWith('hello world');
    } finally {
      Reflect.deleteProperty(document, 'execCommand');
    }
  });

  it('auto-folds multi-line pastes (>= 10 lines) into a chip and submits exact raw text', () => {
    const onSubmit = vi.fn();
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      writable: true,
      value: execCommand,
    });

    const longMultiline = Array.from(
      { length: 12 },
      (_, idx) => `log line ${idx + 1}: [INFO] status=ok`
    ).join('\n');

    try {
      renderControlledComposer({ onSubmit });
      const editor = getEditor();
      pastePlainText(editor, longMultiline);

      expect(execCommand).not.toHaveBeenCalled();
      const chip = editor.querySelector<HTMLElement>(
        '[data-pasted-text-token]'
      );
      expect(chip).not.toBeNull();
      expect(chip?.dataset.tokenKind).toBe('pasted_text');
      expect(chip?.dataset.pastedLineCount).toBe('12');
      expect(chip?.dataset.astryxTokenValue).toBe(longMultiline);

      fireEvent.keyDown(editor, { key: 'Enter' });
      expect(onSubmit).toHaveBeenCalledWith(longMultiline);
    } finally {
      Reflect.deleteProperty(document, 'execCommand');
    }
  });

  it('auto-folds long single-line pastes (>= 1000 chars) into a chip', () => {
    const longSingleLine = 'x'.repeat(1200);
    renderControlledComposer();
    const editor = getEditor();

    pastePlainText(editor, longSingleLine);

    const chip = editor.querySelector<HTMLElement>('[data-pasted-text-token]');
    expect(chip).not.toBeNull();
    expect(chip?.dataset.pastedLineCount).toBe('1');
    expect(chip?.dataset.pastedCharCount).toBe('1200');
    expect(chip?.dataset.astryxTokenValue).toBe(longSingleLine);
  });

  it('opens a truncated preview card on click and supports Copy, Expand to single TextNode, and Remove', async () => {
    const copySpy = vi
      .spyOn(clipboardUtils, 'writeTextToClipboard')
      .mockResolvedValue(true);

    const hugeText = Array.from(
      { length: 60 },
      (_, idx) => `line-${idx + 1}-${'a'.repeat(40)}`
    ).join('\n');

    try {
      renderControlledComposer();
      const editor = getEditor();
      pastePlainText(editor, hugeText);

      const chip = editor.querySelector<HTMLElement>(
        '[data-pasted-text-token]'
      )!;
      expect(chip).not.toBeNull();

      fireEvent.click(chip);

      const preview = await screen.findByTestId('pasted-text-token-preview');
      const snippetPre = preview.querySelector('pre');
      expect(snippetPre?.textContent?.length).toBeLessThan(hugeText.length);
      expect(snippetPre?.textContent).toContain('…');

      fireEvent.click(screen.getByTestId('pasted-text-token-copy'));
      await waitFor(() => {
        expect(copySpy).toHaveBeenCalledWith(hugeText);
      });

      fireEvent.click(screen.getByTestId('pasted-text-token-expand'));
      expect(editor.querySelector('[data-pasted-text-token]')).toBeNull();
      expect(editor.querySelectorAll('br')).toHaveLength(0);
      expect(editor.textContent).toBe(hugeText);
      expect(screen.queryByTestId('pasted-text-token-preview')).toBeNull();

      // Paste again and verify Remove action
      pastePlainText(editor, hugeText);
      const chip2 = editor.querySelector<HTMLElement>(
        '[data-pasted-text-token]'
      )!;
      fireEvent.click(chip2);
      await screen.findByTestId('pasted-text-token-preview');
      fireEvent.click(screen.getByTestId('pasted-text-token-remove'));
      expect(editor.querySelector('[data-pasted-text-token]')).toBeNull();
    } finally {
      copySpy.mockRestore();
    }
  });

  it('undoes a newly pasted chip with Ctrl+Z and deletes it in one Backspace', () => {
    const onChangeSpy = vi.fn();
    const longText = Array.from({ length: 12 }, (_, idx) => `row ${idx}`).join(
      '\n'
    );

    renderControlledComposer({ onChangeSpy });
    const editor = getEditor();
    pastePlainText(editor, longText);
    expect(editor.querySelector('[data-pasted-text-token]')).not.toBeNull();

    // Ctrl+Z immediately undoes the folded paste chip
    fireEvent.keyDown(editor, { key: 'z', ctrlKey: true });
    expect(editor.querySelector('[data-pasted-text-token]')).toBeNull();
    expect(editor.textContent).toBe('');

    // Paste again and delete in a single Backspace right after the chip
    pastePlainText(editor, longText);
    expect(editor.querySelector('[data-pasted-text-token]')).not.toBeNull();
    fireEvent.keyDown(editor, { key: 'Backspace' });
    expect(editor.querySelector('[data-pasted-text-token]')).toBeNull();
  });

  it('copies full raw text when selection intersects a pasted-text chip', () => {
    const longText = Array.from({ length: 11 }, (_, idx) => `item-${idx}`).join(
      '\n'
    );
    renderControlledComposer();
    const editor = getEditor();
    pastePlainText(editor, longText);

    const selection = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);

    const setData = vi.fn();
    fireEvent.copy(screen.getByTestId('session-composer-input-surface'), {
      clipboardData: { setData },
    });

    expect(setData).toHaveBeenCalledWith('text/plain', `${longText}\u00A0`);
  });

  it('preserves folded pasted-text chips when structured @file tokens are inserted alongside them', () => {
    const longText = Array.from(
      { length: 15 },
      (_, idx) => `stack frame ${idx}: at fn (src/app.ts:${idx})`
    ).join('\n');
    const fileToken = formatSessionComposerCommand({
      type: '@',
      key: 'App.tsx',
      value: 'src/App.tsx',
    });

    renderControlledComposer();
    const editor = getEditor();
    pastePlainText(editor, longText);
    expect(editor.querySelector('[data-pasted-text-token]')).not.toBeNull();

    act(() => {
      requestComposerTokenInsert({
        value: fileToken,
        label: '@App.tsx',
      });
    });

    const pastedChip = editor.querySelector<HTMLElement>(
      '[data-pasted-text-token]'
    );
    expect(pastedChip).not.toBeNull();
    expect(pastedChip?.dataset.astryxTokenValue).toBe(longText);
    expect(
      editor.querySelector('[data-astryx-token][data-token-kind="file"]')
    ).not.toBeNull();
  });
});
