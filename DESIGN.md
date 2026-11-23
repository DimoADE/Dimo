---
name: Dimo
description: Local-first AI coding-agent orchestration workspace, dressed as a native macOS Tahoe app.
register: product
platform: Electron desktop (React 19 + Tailwind + Radix). macOS Tahoe is the visual target; Windows and Linux resolve the exact same opaque tokens.
colors:
  # One user-configurable accent, reserved for state (selected / focused / primary / live).
  primary: "#1B1B1B"
  primary-foreground: "#ffffff"
  primary-control-foreground: "#ffffff"
  switch-checked-track: "var(--text-strong)"
  switch-checked-thumb: "var(--surface-raised-control)"
  dark-switch-checked-track: "hsl(var(--primary))"
  dark-switch-checked-thumb: "hsl(var(--primary-foreground))"
  # Astryx neutral surfaces. Opaque, and the same hex on macOS, Windows, and Linux.
  shell-bg: "#f4f4f4"
  content-bg: "#ffffff"
  panel-bg: "#ffffff"
  popover-bg: "#ffffff"
  control-bg: "#0000000d"
  raised-control-bg: "#ffffff"
  raised-control-hover: "#f5f5f5"
  active-bg: "#e5e5e5"
  text-strong: "#171717"
  text-primary: "#171717"
  text-muted: "#525252"
  border-subtle: "#00000014"
  border-strong: "#d4d4d4"
  success: "#86b300"
  warning: "#f2ae49"
  destructive: "#f51818"
  dark-primary: "#E7EBEF"
  dark-primary-foreground: "#0E1319"
  dark-shell-bg: "#1b1b1b"
  dark-content-bg: "#262626"
  dark-panel-bg: "#262626"
  dark-text-strong: "#fafafa"
  dark-border-subtle: "#ffffff1a"
materials:
  # Chrome and content are opaque. Blur never changes the resolved color.
  glass-titlebar: "opaque var(--surface-topbar), #f4f4f4 light / #1b1b1b dark"
  glass-sidebar: "opaque var(--surface-sidebar), the same hex as the title bar"
  glass-popover: "opaque var(--surface-popover), #ffffff light / #262626 dark"
  dark-glass-fill: "opaque #1b1b1b, the same hex across platforms"
  dark-highlight: "moonlight hsl(210 30% 80% / 0.12)"
  dialog-surface: "opaque #ffffff in light mode; opaque #262626 in dark mode"
  content-surface: "opaque #ffffff in light mode; opaque #262626 in dark mode"
  reduce-transparency-fallback: "fills are already opaque, so dropping blur does not change the color"
typography:
  display:
    fontFamily: "var(--font-ui)"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.55
    letterSpacing: "-0.01em"
  headline:
    fontFamily: "var(--font-ui)"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "-0.01em"
  title:
    fontFamily: "var(--font-ui)"
    fontSize: "0.875rem"
    fontWeight: 600
    lineHeight: 1.43
    letterSpacing: "0"
  body:
    fontFamily: "var(--font-ui)"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.43
    letterSpacing: "0"
  callout:
    fontFamily: "var(--font-ui)"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.38
    letterSpacing: "0"
  label:
    fontFamily: "var(--font-ui)"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.33
    letterSpacing: "0"
  caption:
    fontFamily: "var(--font-ui)"
    fontSize: "0.6875rem"
    fontWeight: 400
    lineHeight: 1.27
    letterSpacing: "0"
  micro:
    fontFamily: "var(--font-ui)"
    fontSize: "0.625rem"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "0"
  mono:
    fontFamily: "IBM Plex Mono, Noto Emoji, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0"
rounded:
  none: "4px"
  inner: "6px"
  control: "10px"
  card: "12px"
  panel: "12px"
  sidebar: "12px"
  page: "28px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
motion:
  curve: "ease-out (cubic ~0.22, 1, 0.36, 1); no bounce, no elastic"
  duration: "120-180ms for state, 200-260ms for surface reveal"
  reduced-motion: "crossfade or instant; never gate content visibility on a transition"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-control-foreground}"
    shadow: "0 1px 1px #0d121c14, 0 2px 4px #0d121c1a"
    rounded: "{rounded.control}"
    padding: "0 14px"
    height: "32px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text-muted}"
    rounded: "{rounded.control}"
    padding: "0 10px"
    height: "32px"
  button-secondary:
    backgroundColor: "{colors.raised-control-bg}"
    hoverBackgroundColor: "{colors.raised-control-hover}"
    border: "1px solid {colors.border-subtle}"
    shadow: "none"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "32px"
  button-destructive:
    backgroundColor: "{colors.error-muted}"
    textColor: "{colors.destructive}"
    border: "1px solid transparent"
    shadow: "none"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "32px"
  select-default:
    backgroundColor: "{colors.raised-control-bg}"
    border: "1px solid {colors.border-subtle}"
    shadow: "none"
    rounded: "{rounded.control}"
    padding: "0 10px"
    height: "32px"
  input-default:
    backgroundColor: "{colors.raised-control-bg}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.control}"
    padding: "0 10px"
    height: "32px"
  switch-default:
    checkedBackgroundColor: "{colors.switch-checked-track}"
    checkedThumbColor: "{colors.switch-checked-thumb}"
    darkCheckedBackgroundColor: "{colors.dark-switch-checked-track}"
    darkCheckedThumbColor: "{colors.dark-switch-checked-thumb}"
    rounded: "{rounded.pill}"
  card-default:
    backgroundColor: "{colors.panel-bg}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.card}"
    padding: "14px"
  sidebar-nav-row:
    rounded: "{rounded.control}"
    height: "36px"
    selectedBackground: "{colors.primary}  # accent fill, contrasting label"
---

# Design System: Dimo Tahoe

`DESIGN.md` is the single source of truth for frontend visual design in Dimo.

## 1. Overview & Two-Layer Model

**Creative North Star: "The Developer Flight Deck, built as a good Mac citizen."**

Dimo is a local engineering control surface for coordinating many agent sessions, worktrees, terminals, previews, and diffs without losing context. It combines the density and calm of a flight deck with a **native macOS Tahoe** finish rather than a generic web dashboard.

The visual contract is a two-layer model:

- A **navigation/controls layer** for the window frame: title bar, sidebars, status bar, and tab strip use opaque `#f4f4f4` in light mode and `#1b1b1b` in dark mode. The working page inside that frame stays `#ffffff` / `#1b1b1b`.
- A **content layer** of crisp, **opaque grouped surfaces** (inset lists, cards, editors, menus, dialogs, and toasts): `#ffffff` in light mode and `#262626` in dark mode. Hierarchy comes from this single surface step and from grouping.

Dimo runs on Electron (React 19 + Tailwind + Radix), delivering native visual behavior through the tokenized shell classes in `frontend/src/styles/legacy/index.css` (`--surface-*`, `.settings-sidebar`, `.settings-surface`, `.workspace-topbar`). Reduced transparency drops blur while preserving the exact same hex. On Windows and Linux, custom title-bar controls sit on the right where macOS traffic lights sit on the left.

**Key characteristics:**

- Dense information, quiet surfaces, visible state.
- Both chrome and content surfaces stay opaque across all platforms.
- One user-configurable accent (default Ink `#1B1B1B` in light, Pearl Ink `#E7EBEF` in dark), reserved exclusively for selected, focused, primary, or live states.
- Light mode is the primary working scene; dark mode uses the matching Astryx roles (`#1b1b1b` body, `#262626` lifted surface). Ayu colors stay on semantic status, syntax, and terminal output.
- Hierarchy is expressed by grouping and spacing; remove any background, border, or internal rule added solely for emphasis.

## 2. Materials & Layering

Decide which layer a surface belongs to before styling it.

### The Navigation/Controls Layer

Opaque Astryx frame color. Reserved for chrome that frames content across macOS, Windows, and Linux.

- **Title bar** (`.settings-titlebar`, `.workspace-topbar`): `--surface-topbar`, 1px hairline beneath. Light `#f4f4f4`, dark `#1b1b1b`. Unified with the window; the whole strip is a drag region. The tab strip uses the same color while the active tab matches the page color.
- **Sidebar** (`.settings-sidebar`): a rounded, inset floating panel on the frame color, full hairline border, `12px` (`--radius-container`) corners. Content scrolls independently beside it.
- **Popovers and menus**: opaque `--surface-popover` (`#ffffff` / `#262626`) with popover shadow.
- **Dialogs and toasts**: opaque `--surface-dialog` (`#ffffff` light / `#262626` dark) with identical hex across platforms.

### The Content Layer — Opaque Grouped Surfaces

Everything users read, edit, or scan uses opaque panels:

- **Inset grouped lists / cards** (`.settings-surface`): solid `--surface-card-strong`, 1px outer hairline, `12px` (`--radius-container`) corners, flat at rest (no drop shadow). Rows inside one card are separated by spacing, not internal rules; a row gains elevation only while dragged or actively hovered.
- **Editors, tables, conversation, file tree, diffs**: opaque content background with hairline seams.

### Named Rules

- **The Two-Layer Rule.** Name a surface's layer before styling it. Chrome uses the frame hex; content, menus, and dialogs use the surface hex. Both are opaque.
- **The Opaque Dialog Rule.** Every modal implementation resolves its visible surface through `--surface-dialog`.
- **The Same-Hex Rule.** macOS, Windows, and Linux resolve the exact same opaque color for every role.
- **The Reduce-Transparency Rule.** Dropping blur keeps the exact same fill and hairline so the UI remains unchanged with transparency off.
- **The Decoration-Budget Rule.** Delete any background or border added purely for emphasis; express hierarchy through grouping, spacing, or the accent.

## 3. Color & Accent

A restrained, system-adaptive neutral palette with one user-configurable accent and compact semantic status colors.

### Accent

- **Ink** (`--primary`, `#1B1B1B`): default light accent for selected sidebar rows, focus rings, primary buttons, active navigation, live state, and drag targets, paired with a contrasting control foreground (`#ffffff`).
- **Pearl Ink** (`--primary` in dark, `#E7EBEF`): default dark accent paired with `#0E1319` foreground. Custom accents configured in Settings → Appearance preserve hue and adjust lightness for readable contrast.

### Semantic Status

- **Ayu Green** — success, passed checks, healthy terminal.
- **Ayu Amber** — warning, queued, pending; attention without danger.
- **Error Red** — destructive actions, failures, deleted diff state, irreversible warnings.

Session lifecycle colors share `--session-status-*` across lists, canvas nodes, and collaboration: gray for not started, blue for in progress, amber for review or confirmation, green for done, and red exclusively for errors. Pair colors with labels or spinners so color is never the sole cue.

### Neutrals

- **Frame** — title bar, tab strip, sidebars, and status bar: light `#f4f4f4`, dark `#1b1b1b`.
- **Page** — working surface inside the frame (session list, file tree, main canvas): light `#ffffff`, dark `#1b1b1b`.
- **User message** — sent chat bubble: light `#f4f4f4`, dark `#262626`.
- **Surface** — panels, cards, dialogs, popovers, and inputs: light `#ffffff`, dark `#262626`.
- **Settings window** — page and title bar stay on the page color; setting groups use `#f4f4f4` in light and `#262626` in dark. The floating navigation container uses a subtle vertical wash (`#e6e6e6` → `#ffffff` → `#e6e6e6` light; `#262626` → `#1b1b1b` dark).
- **Control wash** — hover and pressed overlays: light `#0000000d` / `#0000001a`, dark `#ffffff0d` / `#ffffff1a`.
- **Ink** — primary text `#171717` / `#fafafa`; secondary text `#525252` / `#a3a3a3`.
- **Hairline** — `#00000014` / `#ffffff1a`; emphasized borders `#d4d4d4` / `#525252`.

### Color Themes

Settings → Appearance selects one light theme and one dark theme across equal built-in, user, and plugin themes:

- **Role contract.** A theme defines `{ id, label, scheme, colors }` keyed by the 31 roles in `THEME_COLOR_ROLES` (`packages/plugin-sdk/src/theme.ts`). Only `background` and `foreground` are required; `compileTheme.ts` derives remaining roles.
- **Roles, not tokens.** Themes set roles; the compiler emits public CSS tokens into a single `<style data-dimo-color-theme>` scoped to `.legacy-design` (including `prefers-contrast: more`). Components read tokens and never branch on the active theme.
- **Accent override & contrast gate.** An explicit Appearance accent overrides the theme accent in both schemes. Body, secondary, and terminal text below 4.5:1 contrast block saving.
- **Theme-invariant colors.** `--qr-paper`, `--document-paper`, `--media-letterbox`, and `--effort-well*` stay fixed across themes.
- **Export = plugin entry.** Exported theme JSON matches a plugin `themes[]` entry directly.

**Rules:** Literal colors belong only in `src/styles/legacy/index.css` (exceptions: brand marks, avatars, annotation pens, terminal ANSI palette tracked in `src/styles/colorLiterals.test.ts`).

## 4. Typography

Dimo uses native SF Pro on macOS and bundled Inter Variable for Latin UI on Windows and Linux (for crisp Chromium antialiased rendering). Chinese follows system faces: PingFang SC on macOS, Microsoft YaHei on Windows, Noto Sans CJK on Linux (no bundled CJK slices, enforced by `check-bundle-budget.mjs`). Monospace content uses the user-configurable code font.

All steps map to `--type-*` tokens in `frontend/src/styles/fonts.css`:

| Role | Size | Token | Utility | Use |
| --- | --- | --- | --- | --- |
| Display | 600 / 1.125rem | `--type-display` | `text-xl` | App titles, welcome and dense page headers only. |
| Headline | 600 / 1rem | `--type-headline` | `text-lg` | Panel titles, major settings sections, top-level status. |
| Title | 600 / 0.875rem | `--type-body` | `text-base` | Card titles, list-item titles, dialog headings. |
| Body | 400 / 0.875rem | `--type-body` | `text-base` | Conversation text, README and document prose (65–75ch; Chinese line-height 1.7). |
| Callout | 400 / 0.8125rem | `--type-callout` | `text-md` | Menus, tables, code blocks, quoted messages. |
| Label | 500 / 0.75rem | `--type-label` | `text-sm` | Controls, UI copy, list content, settings descriptions. |
| Caption | 400 / 0.6875rem | `--type-caption` | `text-xs` | Metadata, timestamps, helper text, menu descriptions. |
| Micro | 500 / 0.625rem | `--type-micro` | `text-2xs` | Counters and badges inside fixed chrome. Never sentences. |
| Mono | 400 / 0.75rem | `--font-mono` | `font-mono` | Paths, terminal output, code references, branch names, structured logs. |

Trigger and suggestion menus default to compact scale (`Label` for item labels, `Caption` for descriptions). Numeric readouts and first-run headings may step to `1.25rem`, `1.5rem`, or `2rem`. Collaboration contact and message names use `15px / 600`.

### Named Rules

- **The Compact Scale Rule.** Product UI uses a fixed compact scale (no viewport-scaled typography).
- **The One-Ramp Rule.** Use only ramp steps (`400`, `500`, `600`, `700` weights); text stops at `0.625rem`.
- **The System-CJK Weight Rule.** Microsoft YaHei ships Regular and Bold only (`font-synthesis: off`), so never separate two Chinese roles by `400` vs `500` alone — pair with a size or tone step.
- **The Tight-Display Rule.** Display and headline tiers use `-0.01em` tracking; body and below stay at `0`.
- **The Label-Honesty Rule.** Metadata stays at label/caption size rather than being promoted to fill space.

## 5. Elevation, Corners & Motion

### Elevation

Resting surfaces are flat with a 1px hairline. Shadows are reserved for true floating layers:

- **Shell Shadow**: floating sidebar, project rail, loading shells.
- **Popover Shadow**: dialogs, menus, command surfaces.
- **Card Shadow**: grouped `.settings-surface` cards and elevated list items, kept very subtle.
- **Composer Shadow**: persistent follow-up composer slightly lifted from its panel.
- Dark elevation relies on lifted surface contrast (`#262626` over `#1b1b1b`) and moonlight hairlines over heavy drop shadows.

### Corners (Astryx Tiered Semantic Radius Scale)

- **Inner controls / compact items** (`--radius-inner`, `rounded-sm`): `6px` (`0.375rem`).
- **Interactive elements / controls** (buttons, inputs, selects, nav rows — `--radius-element`, `--radius`, `rounded-md`): `10px` (`0.625rem`).
- **Containers** (cards, grouped lists, panels, sidebar, dialogs, popovers — `--radius-container`, `rounded-lg`): `12px` (`0.75rem`).
- **Page / chat shell** (`--radius-page`, `--radius-chat`, `rounded-3xl`): `28px` (`1.75rem`).
- **Status pills / avatars / switches / segmented controls** (`--radius-full`, `rounded-full`): `9999px`.

Semantic radius tokens are the single source of truth; local numeric radii and `calc(var(--radius) - Npx)` derivations are disallowed.

### Motion

Ease-out curves (no bounce or elastic), `120–180ms` for state changes and `200–260ms` for surface reveals. Honor `prefers-reduced-motion` with crossfade or instant transitions, and never gate content visibility on off-screen animations.

### Named Rules

- **The Flat-At-Rest Rule.** Cards and panels are flat unless floating above another layer.
- **The Lift-On-Float Rule.** Shadow strength tracks elevation: hairline at rest, subtle card shadow when grouped-floating, shell/popover shadow only for overlays.

## 6. Components

### Title Bar / Window Chrome

Opaque frame strip (`#f4f4f4` light / `#1b1b1b` dark), full drag region, 1px hairline beneath. Keep it sparse: app mark + title, primary actions tinted, secondary actions demoted. Windows/Linux place custom traffic-light controls on the right; macOS owns the left.

### Sidebar

Rounded inset panel (`12px` container corners) on the frame color. Rows never reflow on hover. Selection uses an accent-filled `10px` rounded row with a contrasting label. Navigation rows may carry a small colored app-icon badge (reserved for navigation, never content).

### Toolbars

Group items by function and frequency; tint only the primary action and move secondary actions to an overflow menu. Avoid custom per-button backgrounds or fusing text buttons tightly against icon buttons.

### Inset Grouped Lists & Cards

Opaque `.settings-surface` card with quiet header and spacing-separated rows (leading label, trailing control), `12px` (`--radius-container`) corners, `12px` dense / `16px` comfortable padding, no internal divider hairlines between sibling rows.

### Controls

- **Switch**: Ink track with contrasting thumb in light mode; resolved accent fill with contrasting thumb in dark mode. Pair switches with clear state labels.
- **Secondary / outline buttons and selects**: opaque `#ffffff` light / `#262626` dark, 1px hairline border, no drop shadow, `10px` (`--radius-element`) radius, `32px` height.
- **Inputs / fields**: opaque surface, 1px hairline, `10px` (`--radius-element`) radius, `32px` compact height, low-opacity accent focus ring, Error Red state paired with an explicit text explanation.
- **Single Control Frame Rule**: Every search field, input, select, or composite control has exactly one element owning its background, border, radius, and focus ring. Ancestor wrappers remain visually transparent; nested native `<input>` elements inside custom frames are transparent, borderless, and shadowless.

### Iconography

Use crisp single-weight line icons (`lucide`) aligned to the type baseline. Render brand agent marks in their brand color (`AgentTypeIcon`); monochrome glyphs inherit `currentColor`.

### Signature Surfaces

The **Composer Shell** (grounded, always-available action surface) and **Agent Bar** (compact full-width paged row of equal-size icons; selected agent shows its name beside its icon; add and refresh follow the last icon of every page; edge chevrons flip pages including during drag) stay visually prominent over quieter surrounding controls.

### Collaboration Space Contact List

UI copy labels bots **助手 / Bot** and groups **群组 / Group** (for backend member/seat identity, see [`docs/architecture.md#collaboration-member-identity`](docs/architecture.md#collaboration-member-identity)):

- **List shape.** Flat when no contact groups exist; once any group exists, ungrouped items sit under a frontend-only **未分组** section.
- **Row layout.** Unified flat two-line grid for DMs and groups: `36px` avatar, bold name + timestamp on line 1, ellipsized preview + unread count on line 2, no card border or segmented filter chrome. Group names append `(N)` for bot count.
- **Group avatar.** Stacked bot faces tilted `-12°` counter-clockwise gazing up-right with thin white silhouette outlines. Untagged groups render stacked faces only; tagged groups add a single tag-colored ring with no background fill.
- **Tab title.** Group-opened bot tabs read `群组名 · 助手名`; DM tabs read the bot name only.

## 7. Accessibility

- **Labels:** Every icon-only control carries an `aria-label`/title. Convey state with icon + text + color — never color alone.
- **Keyboard:** Full keyboard operability, visible focus rings, standard editing shortcuts preserved, and command palette alongside menus.
- **Contrast:** Body text ≥ 4.5:1, large text ≥ 3:1; strengthen hairlines under `prefers-contrast: more`.
- **Reduced transparency / motion:** Opaque fills stay identical when blur is disabled; motion degrades to crossfade/instant.
- **Localization:** Layouts accommodate bilingual (zh-CN / en) copy without truncating meaning at default width.

## 8. Do's and Don'ts

### Do

- Name a surface's layer before styling it: frame hex for chrome, lifted surface hex for content — both opaque and identical across platforms.
- Use tokenized shell classes in `frontend/src/styles/legacy/index.css` before introducing custom Tailwind utilities.
- Keep controls compact and consistent: `32px` control height, `10px` control radius (`--radius-element`), and `12px` container radius (`--radius-container`).
- Express hierarchy through grouping, spacing, and outer hairlines; delete purely decorative chrome.
- Keep hover states geometrically stable (color, shadow, or tiny transform only; never change size, border width, or wrapping).

### Don't

- Paint content or chrome with translucent mixes or platform-specific fallback hexes.
- Draw full-width dividers between section headers and content or between sibling rows inside a card.
- Use generic AI-SaaS clichés: oversized promo cards, decorative gradients, ornamental glass panels, hero metrics, or hype copy.
- Use the accent as decorative fill, or use side-stripe borders `> 1px`, gradient text, or `background-clip: text` in product UI.
- Invent local palettes with `gray-*`, `bg-white`, `text-white`, or hard-coded hex values where tokens exist.
- Crowd toolbars or let hover/selection rely on color alone.
