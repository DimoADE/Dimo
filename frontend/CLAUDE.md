# Frontend Styling & UI Guidelines

## Source of Truth

[`../DESIGN.md`](../DESIGN.md) is the single source of truth for visual design: macOS Tahoe two-layer opaque surfaces, color tokens, typography ramp, tiered semantic corner radii, motion, and accessibility rules.

## CSS Architecture

All routes mount inside `LegacyDesignScope` (`.legacy-design`), which scopes the active Tahoe token layer and Tailwind theme (`tailwind.legacy.config.js`).

**Key CSS files:**

- `src/styles/legacy/index.css` — primary app-design token layer, Tailwind base, and shadcn/ui target (`components.json`).
- `src/styles/fonts.css` — `--type-*` typography ramp and font stacks.
- `src/styles/conversation.css` — conversation timeline styling.
- `src/styles/file-tree.css` — file tree styling.
- `src/styles/diff-style-overrides.css` — diff/syntax styling (`data-theme='dark'` retained for `@git-diff-view`).
- `src/styles/dockview-ayu.css` — Dockview theme injected via `?raw`.

## Theme & Token Rules

Dark/light mode toggles via `.dark` on the root element.

- Use CSS variables (`--surface-*`, `--text-*`, `--border-*`, `--shadow-*`, `--background`, `--foreground`, `--muted`, etc.) or Tailwind token classes for all product colors.
- Both chrome (`--surface-topbar`, `--surface-sidebar`) and content (`--surface-card-strong`, `--surface-dialog`, `--surface-popover`) are **opaque** with identical resolved hex across macOS, Windows, and Linux.
- Avoid local palettes or hard-coded surface hex values. Only syntax colors, terminal ANSI colors, annotation pens, and brand marks use explicit literals (tracked in `src/styles/colorLiterals.test.ts`).

## Component Styling & Radius Rules

```tsx
// Grouped content surfaces
<section className="settings-surface rounded-lg text-foreground" />

// Popovers and dialogs
<div className="dialog-surface text-popover-foreground" />
```

- **Tiered semantic corner radii** (`src/styles/legacy/index.css`):
  - `--radius-inner` (`rounded-sm`): `6px` (`0.375rem`) — compact inner items.
  - `--radius-element` / `--radius` (`rounded-md`): `10px` (`0.625rem`) — buttons, inputs, selects.
  - `--radius-container` (`rounded-lg`): `12px` (`0.75rem`) — cards, grouped lists, panels, sidebar, dialogs, popovers.
  - `--radius-page` (`rounded-3xl`): `28px` (`1.75rem`) — chat/page shells.
  - `--radius-full` (`rounded-full`): `9999px` — true circles, avatars, switches, status pills.
- **Raised controls**: Secondary/outline buttons and native selects use `.raised-control` (light fill + 1px hairline, no drop shadow) rather than re-declaring local borders or fills.
- **Single control frame**: Every search field, input, select, or composite control has exactly one element owning its background, border, radius, shadow, and focus ring. Keep layout/label wrappers visually transparent; when a custom wrapper owns the frame, make the nested native `<input>` transparent, borderless, and shadowless.
- **Startup overlay focus isolation**: While first-run onboarding is active, `StartupOverlayContext` marks background workspace siblings `inert`.

## Astryx Primitives (`@astryxdesign/*`)

Chat composer, richtext, and selected UI primitives use `@astryxdesign/core` and `@astryxdesign/richtext` integrated directly into Dimo's Tahoe token layer (`src/styles/legacy/index.css`).

- CLI inspection: `pnpm exec astryx search "<query>"`, `pnpm exec astryx component <Name>`, `pnpm exec astryx docs <topic>`.
- Follow Dimo's token layer (`DESIGN.md` + `src/styles/legacy/index.css`) as authoritative; do not import standalone Astryx reset/global theme stylesheets that override Dimo's `.legacy-design` tokens.
- Prefer dense rows (`Table`, list rows) over card-wrapped lists, use badges for counts only, and avoid inline `style={{...}}` or arbitrary hex utilities when a token class exists.
