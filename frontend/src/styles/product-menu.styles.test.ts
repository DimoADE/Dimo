import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

const STYLESHEET = resolve(process.cwd(), 'src/styles/legacy/index.css');

function declarationsFor(
  selector: string
): Record<string, { value: string; important: boolean }> {
  const css = readFileSync(STYLESHEET, 'utf8');
  const declarations: Record<string, { value: string; important: boolean }> =
    {};
  parse(css).walkRules((rule: Rule) => {
    const normalized = rule.selector.replace(/\s+/g, ' ').trim();
    if (normalized !== selector) return;
    rule.walkDecls((declaration) => {
      declarations[declaration.prop] = {
        value: declaration.value
          .replace(/\s+/g, ' ')
          .replace(/\(\s+/g, '(')
          .replace(/\s+\)/g, ')')
          .trim(),
        important: declaration.important,
      };
    });
  });
  return declarations;
}

describe('product option menus', () => {
  it('paints context menus and selector menus with the same opaque surface', () => {
    const context = declarationsFor('.product-context-menu');
    const selector = declarationsFor(
      ".legacy-design [popover]:has([role='listbox']) > div"
    );
    const hovered = declarationsFor(
      ".legacy-design [popover]:has([role='listbox']:not(.astryx-trigger-menu)) [role='option']:hover, .legacy-design [popover]:has([role='listbox']:not(.astryx-trigger-menu)) [role='option']:focus-visible"
    );
    const selected = declarationsFor(
      ".legacy-design [popover]:has([role='listbox']:not(.astryx-trigger-menu)) [role='option'][aria-selected='true']"
    );
    const option = declarationsFor(
      ".astryx-select-option:hover, .astryx-select-option[data-active='true']"
    );
    const optionSelected = declarationsFor(
      ".astryx-select-option[aria-selected='true']"
    );

    expect(context.background?.value).toBe('var(--surface-popover)');
    expect(context['box-shadow']?.value).toBe('none');
    expect(context['backdrop-filter']?.value).toBe('none');
    expect(selector.background?.value).toBe('var(--surface-popover)');
    expect(selector['box-shadow']?.value).toBe('none');
    expect(selector['backdrop-filter']?.value).toBe('none');
    expect(hovered.background?.value).toBe('hsl(var(--accent))');
    expect(hovered.color?.value).toBe('hsl(var(--accent-foreground))');
    expect(selected.background?.value).toBe('transparent');
    expect(selected['font-weight']?.value).toBe('500');
    expect(option.background?.value).toBe('hsl(var(--accent))');
    expect(optionSelected.background?.value).toBe('transparent');
    expect(declarationsFor('.branch-selector-menu').background).toBeUndefined();
  });

  it('lets the inner listbox own the trigger-menu frame so the popover stays invisible', () => {
    const popover = declarationsFor(
      ".legacy-design [popover]:has([role='listbox'])"
    );
    const inner = declarationsFor(
      ".legacy-design [popover]:has([role='listbox']) > div"
    );
    const composerPopover = declarationsFor(
      '.legacy-design .session-composer-editor [popover]:has(.astryx-trigger-menu)'
    );

    expect(popover.background?.value).toBe('transparent');
    expect(popover.border?.value).toBe('none');
    expect(popover.padding?.value).toBe('0');
    expect(popover.overflow?.value).toBe('visible');
    expect(popover['box-shadow']?.value).toBe('none');
    expect(inner.overflow?.value).toBe('auto');
    expect(inner['border-radius']?.value).toBe('var(--radius)');
    expect(composerPopover.background?.value).toBe('transparent');
    expect(composerPopover.overflow?.value).toBe('visible');
    expect(composerPopover.border?.value).toBe('none');
    expect(composerPopover['box-shadow']?.value).toBe('none');
    const composerInner = declarationsFor(
      '.legacy-design .session-composer-editor [popover]:has(.astryx-trigger-menu) > div'
    );
    expect(composerInner.width?.value).toBe('100%');
    expect(composerInner.overflow?.value).toBe('auto');
    expect(composerInner['box-shadow']?.value).toBe('none');
    expect(composerInner['border-radius']?.value).toBe('var(--radius)');
  });

  it('keeps slash and dollar command rows on a compact single line', () => {
    const commandOption = declarationsFor(
      ".legacy-design .session-composer-editor .astryx-trigger-menu [role='option']:has([data-composer-trigger-kind='slash']), .legacy-design .session-composer-editor .astryx-trigger-menu [role='option']:has([data-composer-trigger-kind='dollar'])"
    );
    const commandDescription = declarationsFor(
      ".legacy-design .session-composer-editor .astryx-trigger-menu [data-composer-trigger-kind='slash'] .composer-trigger-description, .legacy-design .session-composer-editor .astryx-trigger-menu [data-composer-trigger-kind='dollar'] .composer-trigger-description"
    );

    expect(commandOption['min-height']?.value).toBe('28px');
    expect(commandOption.padding?.value).toBe('4px 8px');
    expect(commandDescription['font-size']?.value).toBe(
      'var(--trigger-menu-font-size)'
    );
  });

  it('hides the @ reference tab scrollbar while keeping overflow for tab switching', () => {
    const tabs = declarationsFor('.legacy-design .composer-at-reference-tabs');
    const menu = declarationsFor(
      '.legacy-design .composer-at-reference-menu.composer-status-surface'
    );

    expect(tabs['overflow-x']?.value).toBe('auto');
    expect(tabs['scrollbar-width']?.value).toBe('none');
    expect(menu.position?.value).toBe('absolute');
    expect(menu.left?.value).toBe('0');
    expect(menu.right?.value).toBe('0');
  });

  it('tucks the @ card under the composer shell so the bottom corners disappear', () => {
    const body = declarationsFor('.legacy-design .session-composer-body');
    const menu = declarationsFor(
      '.legacy-design .composer-at-reference-menu.composer-status-surface'
    );

    const baseTokens = declarationsFor('.legacy-design');
    const shell = declarationsFor('.composer-shell');
    const statusSurface = declarationsFor('.composer-status-surface');
    const stackedStatusLayers = declarationsFor(
      '.conversation-status-dock:has( .composer-status-row + .composer-status-row )::before, .conversation-status-dock:has( .composer-status-row + .composer-status-row + .composer-status-row )::after'
    );

    expect(baseTokens['--_radius-composer']?.value).toBe('1.25rem');
    expect(shell.border?.value).toBe('1px solid var(--border-strong)');
    expect(shell['border-radius']?.value).toBe(
      'var(--radius-composer, var(--radius-container, var(--radius)))'
    );
    expect(statusSurface['border-radius']?.value).toBe(
      'var(--radius-composer, var(--radius-container, var(--radius)))'
    );
    expect(stackedStatusLayers['border-radius']?.value).toBe(
      'var(--radius-composer, var(--radius-container, var(--radius)))'
    );
    expect(body['border-radius']?.value).toBe(
      'var(--radius-composer, var(--radius-container, var(--radius)))'
    );
    expect(menu.bottom?.value).toBe(
      'calc(100% - var(--radius-composer, var(--radius-container, var(--radius))))'
    );
    expect(menu['padding-bottom']?.value).toBe(
      'var(--radius-composer, var(--radius-container, var(--radius)))'
    );
    expect(Number.parseInt(menu['z-index']?.value ?? '', 10)).toBeLessThan(10);
    expect(menu['border-radius']?.value).toBe(
      'var(--radius-composer, var(--radius-container, var(--radius))) var(--radius-composer, var(--radius-container, var(--radius))) 0 0'
    );

    const atOptionActive = declarationsFor(
      ".legacy-design .composer-at-reference-option:hover, .legacy-design .composer-at-reference-option:focus-visible, .legacy-design .composer-at-reference-option[aria-selected='true'], .legacy-design .composer-at-reference-option[data-active='true']"
    );
    expect(atOptionActive.background?.value).toBe('hsl(var(--accent))');
    expect(atOptionActive.color?.value).toBe('hsl(var(--accent-foreground))');

    const triggerOptionActive = declarationsFor(
      ".legacy-design .session-composer-editor .astryx-trigger-menu [role='option']:hover, .legacy-design .session-composer-editor .astryx-trigger-menu [role='option']:focus-visible, .legacy-design .session-composer-editor .astryx-trigger-menu [role='option'][aria-selected='true'], .legacy-design .session-composer-editor .astryx-trigger-menu [role='option'][data-active='true']"
    );
    expect(triggerOptionActive.background?.value).toBe('hsl(var(--accent))');
    expect(triggerOptionActive.color?.value).toBe(
      'hsl(var(--accent-foreground))'
    );
  });

  it('stacks the @ card above an expanded attachment drawer', () => {
    const drawer = declarationsFor(
      '.legacy-design .session-composer-attachment-drawer'
    );
    const menu = declarationsFor(
      '.legacy-design .composer-at-reference-menu.composer-status-surface'
    );

    expect(drawer.position?.value).toBe('relative');
    expect(Number.parseInt(drawer['z-index']?.value ?? '', 10)).toBe(1);
    expect(Number.parseInt(menu['z-index']?.value ?? '', 10)).toBeGreaterThan(
      1
    );
  });

  it('encloses the composer body, top cockpit dock, and bottom footer inside a wider outer frame', () => {
    const frame = declarationsFor('.composer-cockpit-frame');
    const activeFrame = declarationsFor(
      '.composer-cockpit-frame:has(.composer-cockpit-dock, .composer-cockpit-footer)'
    );
    const activeCore = declarationsFor(
      '.composer-cockpit-frame:has(.composer-cockpit-dock, .composer-cockpit-footer) .composer-cockpit-core'
    );
    const dock = declarationsFor('.composer-cockpit-dock');
    const tabbar = declarationsFor('.composer-cockpit-tabbar');
    const panel = declarationsFor('.composer-cockpit-panel');
    const childrenList = declarationsFor('.composer-cockpit-children-list');
    const footer = declarationsFor('.composer-cockpit-footer');

    expect(frame['--composer-cockpit-inset']?.value).toBe('6px');
    expect(frame.overflow?.value).toBe('visible');
    expect(activeFrame['margin-inline']?.value).toBe(
      'calc(-1 * var(--composer-cockpit-inset))'
    );
    expect(activeFrame['border-radius']?.value).toBe(
      'var(--composer-cockpit-radius)'
    );
    expect(activeFrame.background?.value).toBe(
      'color-mix(in srgb, var(--text-strong) 5%, var(--surface-card))'
    );
    expect(activeCore['padding-inline']?.value).toBe(
      'var(--composer-cockpit-inset)'
    );
    expect(dock.position?.value).toBe('relative');
    expect(Number.parseInt(dock['z-index']?.value ?? '', 10)).toBeLessThan(10);
    expect(dock.background?.value).toBe('transparent');
    expect(tabbar.background?.value).toBe('transparent');
    expect(panel['max-height']?.value).toBe('176px');
    expect(childrenList['max-height']?.value).toBe('139px');
    expect(childrenList['overflow-y']?.value).toBe('auto');
    expect(footer.display?.value).toBe('flex');
    expect(footer['justify-content']?.value).toBe('space-between');
  });

  it('restores the composer send button fill over ghost button resets', () => {
    const button = declarationsFor(
      '.legacy-design button.composer-primary-action.astryx-button'
    );

    expect(button['background-color']?.value).toBe('hsl(var(--foreground))');
    expect(button['background-color']?.important).toBe(true);
    expect(button.color?.value).toBe('hsl(var(--background))');
    expect(button['border-radius']?.value).toBe('999px');
    expect(button.width?.value).toBe('30px');
    expect(button.height?.value).toBe('30px');
  });
});
