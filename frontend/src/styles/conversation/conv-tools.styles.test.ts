import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

const STYLESHEET = resolve(
  process.cwd(),
  'src/styles/conversation/conv-tools.css'
);

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
        value: declaration.value,
        important: declaration.important,
      };
    });
  });
  return declarations;
}

describe('composer todo popover', () => {
  it('draws a bordered frame and hides the list scrollbar', () => {
    const popover = declarationsFor('.composer-todo-popover.tahoe-popover');
    const list = declarationsFor('.composer-todo-list');
    const webkit = declarationsFor('.composer-todo-list::-webkit-scrollbar');
    const nestedCard = declarationsFor(
      '.composer-todo-popover .conv-plan-card'
    );
    const streamCard = declarationsFor('.conv-plan-card');

    expect(popover.border?.value).toBe('1px solid var(--border-strong)');
    expect(popover.width?.value).toBe(
      'min(22rem, var(--radix-popper-anchor-width, calc(100vw - 24px)))'
    );
    expect(popover['max-width']?.value).toBe(
      'var(--radix-popper-anchor-width, calc(100vw - 24px))'
    );
    expect(popover.overflow?.value).toBe('hidden');
    expect(list.overflow?.value).toBe('auto');
    expect(list['scrollbar-width']?.value).toBe('none');
    expect(webkit.display?.value).toBe('none');
    expect(nestedCard.border?.value).toBe('0');
    expect(streamCard.border?.value).toBe(
      '1px solid var(--conv-border-subtle)'
    );
  });
});

describe('composer session popover', () => {
  it('caps height, scrolls sessions, and pins the new-session action', () => {
    const popover = declarationsFor('.composer-session-popover');
    const list = declarationsFor('.composer-session-list');
    const create = declarationsFor('.composer-session-new');

    expect(popover.display?.value).toBe('flex');
    expect(popover['flex-direction']?.value).toBe('column');
    expect(popover['max-height']?.value.replace(/\s+/g, ' ').trim()).toBe(
      'min( 24rem, var(--radix-dropdown-menu-content-available-height, calc(100dvh - 8rem)), calc(100dvh - 8rem) )'
    );
    expect(popover.overflow?.value).toBe('hidden');
    expect(list['min-height']?.value).toBe('0');
    expect(list.overflow?.value).toBe('auto');
    expect(create['flex-shrink']?.value).toBe('0');
  });
});

describe('conversation tool-call typography', () => {
  it('matches message-stream font, size, weight, and line-height', () => {
    const rules = declarationsFor('.astryx-chat-tool-calls');

    expect(rules['--font-family-body']?.value).toBe('var(--font-ui)');
    expect(rules['--font-family-code']?.value).toBe('var(--font-ui)');
    expect(rules['--text-supporting-size']?.value).toBe('13px');
    expect(rules['--text-supporting-weight']?.value).toBe('400');
    expect(rules['--text-supporting-leading']?.value).toBe('1.7');
    expect(rules['--font-weight-medium']?.value).toBe('400');
    expect(rules['font-family']?.value).toBe('var(--font-ui)');
    expect(rules['font-size']?.value).toBe('13px');
    expect(rules['font-weight']?.value).toBe('400');
    expect(rules['line-height']?.value).toBe('1.7');
  });

  it('matches stream prose size on the grouped tool-call summary', () => {
    const label = declarationsFor(
      ".dimo-tool-call-batch > [role='button'] > span:nth-child(2)"
    );
    const header = declarationsFor('.conv-activity-header');
    const fold = declarationsFor('.conv-collapsed-process-toggle');

    expect(label['--text-supporting-size']?.value).toBe('13px');
    expect(label['--text-supporting-leading']?.value).toBe('1.7');
    expect(header['font-size']?.value).toBe('13px');
    expect(header['line-height']?.value).toBe('1.7');
    expect(fold['font-size']?.value).toBe('13px');
    expect(fold['line-height']?.value).toBe('1.7');
    expect(label['white-space']?.value).toBe('nowrap');
    expect(label.overflow?.value).toBe('hidden');
    expect(label['min-width']?.value).toBe('0');
  });

  it('keeps mixed activity summaries on one clipped line', () => {
    const label = declarationsFor('.conv-activity-header > span');

    expect(label['white-space']?.value).toBe('nowrap');
    expect(label.overflow?.value).toBe('hidden');
    expect(label['min-width']?.value).toBe('0');
    expect(label.flex?.value).toBe('1');
  });

  it('uses UI sans fallback for Chinese artifact titles and legible code/terminal font sizes', () => {
    const title = declarationsFor('.conv-tool-artifact-title');
    const zhTitle = declarationsFor(':lang(zh) .conv-tool-artifact-title');
    const toolCode = declarationsFor('.conv-tool-code');
    const hitLoc = declarationsFor('.conv-tool-hit-loc');
    const toolTerminal = declarationsFor('.conv-tool-terminal-output');
    const streamTerminal = declarationsFor('.conv-terminal-output');

    expect(title['font-variant-numeric']?.value).toBe('tabular-nums');
    expect(zhTitle['font-family']?.value).toBe('var(--font-ui)');
    expect(toolCode['font-size']?.value).toBe('13px');
    expect(hitLoc['font-size']?.value).toBe('12px');
    expect(toolTerminal['font-size']?.value).toBe('12px');
    expect(streamTerminal['font-size']?.value).toBe('12px');
  });
});

describe('conversation tool-call fold spacing and hover', () => {
  it('restores Astryx spacing-2 around tool-call folds, not ungrouped rows', () => {
    const fold = declarationsFor(
      '.conv-activity-batch, .conv-assistant-body .astryx-chat-tool-calls.dimo-tool-call-batch'
    );

    expect(fold['margin-block-start']?.value).toBe('8px');
    expect(fold['margin-block-end']?.value).toBe('8px');
  });

  it('spaces thinking from neighboring kinds inside a nested fold, not tool from tool', () => {
    const thinkingGap = declarationsFor(
      '.conv-nested-scroll > * + .conv-thinking, .conv-nested-scroll > .conv-thinking + *'
    );

    expect(thinkingGap['margin-top']?.value).toBe('10px');
    expect(
      declarationsFor(
        '.conv-nested-scroll > .astryx-chat-tool-calls + .astryx-chat-tool-calls'
      )['margin-top']
    ).toBeUndefined();
  });

  it('keeps CallRow hover radius inside nested overflow panes', () => {
    const nested = declarationsFor('.conv-nested-scroll');
    const expanded = declarationsFor(
      ".astryx-chat-tool-calls [role='button'][aria-expanded='true'] + div"
    );
    const expandedInner = declarationsFor(
      ".astryx-chat-tool-calls [role='button'][aria-expanded='true'] + div > div"
    );

    expect(nested['padding-inline-start']?.value).toBe('4px');
    expect(nested['padding-inline-end']?.value).toBe('4px');
    expect(nested['margin-inline-start']?.value).toBe('-4px');
    expect(nested['margin-inline-end']?.value).toBe('-4px');
    expect(nested['overflow-x']?.value).toBe('hidden');
    expect(nested['overflow-y']?.value).toBe('auto');
    expect(expanded['padding-inline-start']?.value).toBe('4px');
    expect(expanded['padding-inline-start']?.important).toBe(true);
    expect(expanded['padding-inline-end']?.value).toBe('4px');
    expect(expanded['padding-inline-end']?.important).toBe(true);
    expect(expanded['margin-inline-start']?.value).toBe('-4px');
    expect(expanded['margin-inline-end']?.value).toBe('-4px');
    expect(expandedInner.overflow?.value).toBe('visible');
  });
});

function declarationsIn(
  relativePath: string,
  selector: string
): Record<string, { value: string; important: boolean }> {
  const css = readFileSync(resolve(process.cwd(), relativePath), 'utf8');
  const declarations: Record<string, { value: string; important: boolean }> =
    {};
  parse(css).walkRules((rule: Rule) => {
    const normalized = rule.selector.replace(/\s+/g, ' ').trim();
    if (normalized !== selector) return;
    rule.walkDecls((declaration) => {
      declarations[declaration.prop] = {
        value: declaration.value,
        important: declaration.important,
      };
    });
  });
  return declarations;
}

describe('conversation tool-chips typography, truncation, and slim scrollbar', () => {
  const CHIPS_CSS = 'src/styles/conversation/conv-tool-chips.css';
  const VARS_CSS = 'src/styles/conversation/conv-variables.css';
  const COMPONENTS_CSS = 'src/styles/conversation/conv-components.css';

  it('uses compact 13px muted typography, hover-only darkening, disclosure triangle, red error icon, and disabled viewport scroll anchoring', () => {
    const lightVars = declarationsIn(VARS_CSS, ':root, .legacy-design');
    const darkVars = declarationsIn(
      VARS_CSS,
      '.dark, .legacy-design.dark, .dark .legacy-design'
    );
    const header = declarationsIn(CHIPS_CSS, '.conv-tool-chips-header');
    const headerExpanded = declarationsIn(
      CHIPS_CSS,
      '.conv-tool-chips-header.is-expanded'
    );
    const headerIcon = declarationsIn(
      CHIPS_CSS,
      '.conv-tool-chips-header > .conv-tool-chips-header-icon'
    );
    const disclosureIcon = declarationsIn(
      CHIPS_CSS,
      '.conv-tool-chips-disclosure-icon'
    );
    const disclosureExpanded = declarationsIn(
      CHIPS_CSS,
      '.conv-tool-chips-header.is-expanded .conv-tool-chips-disclosure-icon'
    );
    const batch = declarationsIn(CHIPS_CSS, '.conv-tool-chips-batch');
    const viewport = declarationsIn(
      CHIPS_CSS,
      '.legacy-design .conv-tool-chips-viewport, .conv-tool-chips-viewport'
    );
    const foldToggleBase = declarationsIn(
      CHIPS_CSS,
      '.conv-collapsed-process-toggle'
    );
    const foldToggle = declarationsIn(
      CHIPS_CSS,
      '.conv-collapsed-process.is-expanded > .conv-collapsed-process-toggle'
    );
    const foldNested = declarationsIn(
      CHIPS_CSS,
      '.conv-collapsed-process.is-expanded .conv-nested-scroll'
    );
    const foldLastTools = declarationsIn(
      CHIPS_CSS,
      '.conv-collapsed-process.is-expanded .conv-nested-scroll > .dimo-turn-tool-calls:last-child'
    );
    const sliceTailTools = declarationsIn(
      CHIPS_CSS,
      '.conv-turn-row.is-fold-tail .conv-assistant-body > .dimo-turn-tool-calls'
    );
    const row = declarationsIn(CHIPS_CSS, '.conv-tool-chip-row');
    const rowExpanded = declarationsIn(
      CHIPS_CSS,
      '.conv-tool-chip-row.is-expanded'
    );
    const list = declarationsIn(CHIPS_CSS, '.conv-tool-chips-list');
    const iconSlot = declarationsIn(CHIPS_CSS, '.conv-tool-chip-icon-slot');
    const errorIconSlot = declarationsIn(
      CHIPS_CSS,
      '.conv-tool-chip-row.is-error .conv-tool-chip-icon-slot'
    );
    const kindIcon = declarationsIn(CHIPS_CSS, '.conv-tool-chip-kind-icon');
    const removedErrorBadge = declarationsIn(
      CHIPS_CSS,
      '.conv-tool-chip-error-badge'
    );

    expect(lightVars['--conv-tool-chip-text']?.value).toBeTruthy();
    expect(darkVars['--conv-tool-chip-text']?.value).toBeTruthy();

    expect(batch['margin-block']?.value).toBe('0');
    expect(batch['padding-bottom']?.value).toBe('0');
    expect(foldToggleBase.color?.value).toBe('var(--conv-tool-chip-text)');
    expect(foldToggleBase['font-size']?.value).toBe('13px');
    expect(foldToggleBase['line-height']?.value).toBe('1.55');

    expect(header.color?.value).toBe('var(--conv-tool-chip-text)');
    expect(header['font-family']?.value).toBe('var(--font-ui)');
    expect(header['font-size']?.value).toBe('13px');
    expect(header['line-height']?.value).toBe('1.55');
    expect(header['min-height']?.value).toBe('22px');
    expect(header.padding?.value).toBe('2px');
    expect(header.gap?.value).toBe('6px');
    expect(header['margin-inline']?.value).toBe('0');
    expect(headerExpanded.color).toBeUndefined();

    expect(headerIcon.width?.value).toBe('20px');
    expect(headerIcon.height?.value).toBe('20px');
    expect(disclosureIcon.width?.value).toBe('14px');
    expect(disclosureIcon.height?.value).toBe('14px');
    expect(disclosureExpanded.transform?.value).toBe('rotate(90deg)');

    expect(viewport['margin-top']?.value).toBe('0');
    expect(viewport['overflow-anchor']?.value).toBe('none');
    expect(foldToggle['padding-bottom']?.value).toBe('8px');
    expect(foldNested['margin-top']?.value).toBe('6px');
    expect(foldLastTools['margin-bottom']?.value).toBe('10px');
    expect(sliceTailTools['margin-bottom']?.value).toBe('10px');

    expect(row.color?.value).toBe('var(--conv-tool-chip-text)');
    expect(row['font-family']?.value).toBe('var(--font-ui)');
    expect(row['font-size']?.value).toBe('13px');
    expect(row['line-height']?.value).toBe('1.55');
    expect(row['min-height']?.value).toBe('22px');
    expect(row.gap?.value).toBe('6px');
    expect(row['margin-inline']?.value).toBe('0');
    expect(rowExpanded.color).toBeUndefined();

    const headerHover = declarationsIn(
      CHIPS_CSS,
      '.conv-tool-chips-header:hover'
    );
    const rowHover = declarationsIn(
      CHIPS_CSS,
      '.conv-tool-chip-row.is-expandable:hover'
    );

    expect(headerHover.background?.value).toBe('transparent');
    expect(headerHover.color?.value).toBe('var(--conv-text-primary)');
    expect(rowHover.background?.value).toBe('transparent');
    expect(rowHover.color?.value).toBe('var(--conv-text-primary)');

    expect(list.gap?.value).toBe('2px');
    expect(iconSlot.width?.value).toBe('20px');
    expect(iconSlot.height?.value).toBe('20px');
    expect(errorIconSlot.color?.value).toBe('var(--conv-tool-error)');
    expect(kindIcon.width?.value).toBe('14px');
    expect(kindIcon.height?.value).toBe('14px');
    expect(Object.keys(removedErrorBadge)).toEqual([]);
  });

  it('uses a 4px thumb-only WebKit scrollbar without track or arrow buttons and suppresses horizontal scroll on conversation logs', () => {
    const css = readFileSync(resolve(process.cwd(), CHIPS_CSS), 'utf8');
    const root = parse(css);
    const nonFallbackScrollbarProps: string[] = [];
    root.walkRules((rule: Rule) => {
      let insideSupportsFallback = false;
      let parent:
        | { type?: string; name?: string; parent?: unknown }
        | undefined = rule.parent ?? undefined;
      while (parent) {
        if (parent.type === 'atrule' && parent.name === 'supports') {
          insideSupportsFallback = true;
          break;
        }
        const next = parent.parent;
        parent =
          next && typeof next === 'object'
            ? (next as NonNullable<typeof parent>)
            : undefined;
      }
      if (insideSupportsFallback) return;
      rule.walkDecls((decl) => {
        if (
          decl.prop === 'scrollbar-color' ||
          (decl.prop === 'scrollbar-width' && decl.value === 'thin')
        ) {
          nonFallbackScrollbarProps.push(`${decl.prop}: ${decl.value}`);
        }
      });
    });
    expect(nonFallbackScrollbarProps).toEqual([]);

    const scrollbar = declarationsIn(
      CHIPS_CSS,
      '.legacy-design .conv-tool-chips-viewport::-webkit-scrollbar, .conv-tool-chips-viewport::-webkit-scrollbar'
    );
    const button = declarationsIn(
      CHIPS_CSS,
      '.legacy-design .conv-tool-chips-viewport::-webkit-scrollbar-button, .conv-tool-chips-viewport::-webkit-scrollbar-button'
    );
    const thumb = declarationsIn(
      CHIPS_CSS,
      '.legacy-design .conv-tool-chips-viewport::-webkit-scrollbar-thumb, .conv-tool-chips-viewport::-webkit-scrollbar-thumb'
    );
    const logs = declarationsIn(
      COMPONENTS_CSS,
      "[data-panel='conversation-logs'], [data-panel='child-conversation-logs']"
    );

    expect(scrollbar.width?.value).toBe('4px');
    expect(scrollbar.height?.value).toBe('0');
    expect(button.display?.value).toBe('none');
    expect(thumb['border-radius']?.value).toBe('9999px');
    expect(logs['overflow-x']?.value).toBe('hidden');
  });
});
