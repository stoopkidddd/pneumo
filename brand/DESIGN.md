# Pneumo brand system

## Direction

Pneumo uses the approved Dispatch mark with the Switchboard palette and type. The idea is retro pneumatic-tube office mail: a ribbed capsule moves confidently between personal devices, with forward lean and motion bars supplying speed and a little playfulness. It must read as routing and delivery, not healthcare.

Do not introduce lungs, crosses, ECG lines, clinical teal, hospital language, or pill imagery. Never remove the ribs and motion bars in a way that makes the mail capsule read as medicine. The visual voice is tactile, ordered, direct, and compact; it is not sterile or clinical.

## Color tokens

`brand/tokens.json` is authoritative. The seven Switchboard colors are preserved exactly: `canvas` became `background`, `ink` became `text`, `muted` became `text-muted`, `onAccent` became `accent-contrast`, and `outline` became `border`; `surface` and `accent` retain their names and values. The raised, status, and focus roles are derived additions.

| Role | Light | Dark | Use |
| --- | --- | --- | --- |
| `background` | `#F2F3F5` | `#10141C` | App and page canvas. |
| `surface` | `#FFFFFF` | `#1A202B` | Inputs, grouped rows, and ordinary contained regions. |
| `surface-raised` | `#FCFCFD` | `#232A37` | Menus, transient notices, and elevated overlays; pair with `shadow`, because color alone does not communicate elevation. |
| `text` | `#151922` | `#F4F6FA` | Primary copy and icons on neutral surfaces. |
| `text-muted` | `#4E5665` | `#B5BDCB` | Secondary copy, metadata, placeholder text, and disabled labels. |
| `accent` | `#1947C7` | `#8CA9FF` | Primary action fills, links, active-route icons, the mark on neutral surfaces, and focus rings. |
| `accent-contrast` | `#FFFFFF` | `#111831` | The only text, icon, or mark color on an `accent` fill. |
| `border` | `#737B89` | `#707B8E` | Dividers, input outlines, and component boundaries. |
| `success` | `#0D6B3B` | `#6FD59C` | Success text and icons on neutral surfaces only. |
| `danger` | `#B42318` | `#FF8A84` | Error or destructive text and icons on neutral surfaces only. |
| `focus-ring` | `#1947C7` | `#8CA9FF` | Keyboard focus outline. It intentionally equals `accent`. |

### Allowed color pairs

- `text`, `text-muted`, `accent`, `success`, and `danger` may be foregrounds on any of `background`, `surface`, or `surface-raised` in the same theme.
- `accent-contrast` is used on `accent`, and only that pair is approved for text, icons, or the mark on an accent fill.
- `accent` may be a text/icon foreground on any neutral surface or a fill with `accent-contrast` content.
- `border` may separate any two neutral regions. It is not a text color.
- `focus-ring` may surround a control on any neutral surface. Use a 2 px ring with a 2 px transparent offset so the neutral surface remains between the ring and an accent-filled control; the ring is never directly adjacent to the same-color fill.
- `success` and `danger` are foreground-only status colors on neutral surfaces. Do not use them as fills, tinted panels, badges, or decorative fields. Pair status color with an icon and explicit text so color is never the only signal.
- Do not invent translucent color mixtures. If a new pair is needed, measure it and add a named token rather than changing opacity at the call site.

## Contrast

Ratios below use WCAG 2.x relative luminance with sRGB linearization and are rounded to two decimals. Text foregrounds require at least 4.5:1. Borders, focus indicators, and other graphical objects require at least 3:1. The accent is held to the stronger 4.5:1 target when used as text or an icon.

### Light theme

| Foreground | On `background` `#F2F3F5` | On `surface` `#FFFFFF` | On `surface-raised` `#FCFCFD` | Requirement |
| --- | ---: | ---: | ---: | ---: |
| `text` `#151922` | 15.84 | 17.59 | 17.15 | 4.5 |
| `text-muted` `#4E5665` | 6.65 | 7.39 | 7.20 | 4.5 |
| `accent` `#1947C7` | 6.83 | 7.59 | 7.40 | 4.5 |
| `success` `#0D6B3B` | 5.94 | 6.60 | 6.43 | 4.5 |
| `danger` `#B42318` | 5.92 | 6.57 | 6.41 | 4.5 |
| `border` `#737B89` | 3.84 | 4.27 | 4.16 | 3.0 |
| `focus-ring` `#1947C7` | 6.83 | 7.59 | 7.40 | 3.0 |

### Dark theme

| Foreground | On `background` `#10141C` | On `surface` `#1A202B` | On `surface-raised` `#232A37` | Requirement |
| --- | ---: | ---: | ---: | ---: |
| `text` `#F4F6FA` | 17.04 | 15.10 | 13.31 | 4.5 |
| `text-muted` `#B5BDCB` | 9.75 | 8.64 | 7.62 | 4.5 |
| `accent` `#8CA9FF` | 8.11 | 7.18 | 6.33 | 4.5 |
| `success` `#6FD59C` | 10.25 | 9.08 | 8.01 | 4.5 |
| `danger` `#FF8A84` | 8.10 | 7.17 | 6.32 | 4.5 |
| `border` `#707B8E` | 4.31 | 3.82 | 3.37 | 3.0 |
| `focus-ring` `#8CA9FF` | 8.11 | 7.18 | 6.33 | 3.0 |

| Theme | Approved accent pair | Ratio | Requirement |
| --- | --- | ---: | ---: |
| Light | `accent-contrast` `#FFFFFF` on `accent` `#1947C7` | 7.59 | 4.5 |
| Dark | `accent-contrast` `#111831` on `accent` `#8CA9FF` | 7.70 | 4.5 |

The mark uses `accent` on neutral surfaces and `accent-contrast` on accent surfaces, so its graphical contrast also exceeds 3:1 in both themes.

## Typography

Chivo SemiBold 600 is the display voice for the wordmark and headings. Public Sans Regular 400 is the web interface face. Both are distributed under the SIL Open Font License 1.1. The redistribution license texts live beside the web fonts as `Chivo-OFL.txt` and `PublicSans-OFL.txt`; their approved originals remain in `brand/directions/b/fonts/`.

The token `file` fields are filenames, not paths. The web copies live at:

- `apps/web/src/assets/fonts/chivo-600.woff2`
- `apps/web/src/assets/fonts/public-sans-400.woff2`

Self-host both WOFF2 files and declare only the supplied weights; do not synthesize bold or substitute a display face. Chivo is for `display`, `title`, and `heading`. Public Sans is for `body`, `label`, `caption`, controls, and data. Keep prose to 65–75 characters per line and do not tighten tracking below `-0.04em`.

Android uses `FontFamily.Default` for interface text instead of bundling Public Sans. This preserves native rendering, script coverage, and platform accessibility while avoiding another app font payload. The outlined wordmark carries Chivo where branding is required, so Android does not need Chivo as a runtime font.

| Step | Size / line height | Face | Use |
| --- | --- | --- | --- |
| `caption` | 12 / 16 px | Public Sans 400 | Timestamps and terse metadata; never primary instructions. |
| `label` | 14 / 20 px | Public Sans 400 | Field labels, buttons, and compact controls. |
| `body` | 16 / 24 px | Public Sans 400 | Default copy, input values, and list-row content. |
| `heading` | 20 / 28 px | Chivo 600 | Component and section headings. |
| `title` | 28 / 36 px | Chivo 600 | Screen titles and important empty-state titles. |
| `display` | 40 / 48 px | Chivo 600 | Sparse brand-led moments, not routine app chrome. |

## Spacing, shape, depth, and motion

All spacing and radii are pixel values on the web and density-independent values where mapped to Android.

| Spacing | Value | Use |
| --- | ---: | --- |
| `none` | 0 | Intentional reset only. |
| `xs` | 4 | Icon-to-label and tight metadata gaps. |
| `sm` | 8 | Related inline items. |
| `md` | 12 | Compact control padding and field internals. |
| `lg` | 16 | Standard control padding and row insets. |
| `xl` | 24 | Component separation. |
| `2xl` | 32 | Section separation. |
| `3xl` | 48 | Major layout breaks. |

| Radius | Value | Use |
| --- | ---: | --- |
| `sm` | 6 | Inputs and compact controls. |
| `md` | 10 | Buttons, menus, and grouped regions. |
| `lg` | 14 | Elevated overlays and large contained regions. |
| `pill` | 999 | Small tags or compact segmented controls only; never cards or page sections. |

`shadow.light` is `0 8px 24px rgba(21, 25, 34, 0.12)` and `shadow.dark` is `0 8px 24px rgba(0, 0, 0, 0.36)`. Use the theme shadow only with `surface-raised`; ordinary surfaces use a border or a shadow, never both.

| Motion | Duration | Use |
| --- | ---: | --- |
| `fast` | 120 ms | Press, hover, and focus feedback. |
| `standard` | 200 ms | Menus and local state changes. |
| `deliberate` | 320 ms | A single dispatch or route transition where motion explains movement. |

Motion should suggest a capsule being dispatched: short, directional, and settled with an ease-out curve. Do not animate every row or repeat decorative entrances. Under `prefers-reduced-motion: reduce`, remove travel and use an immediate state change or a short non-moving fade.

## Components

### Buttons

- Primary: `accent` fill, `accent-contrast` label/icon, `md` radius, 44 px minimum web target and 48 dp Android target.
- Secondary: neutral `surface`, `text`, and a 1 px `border`; do not add a shadow.
- Tertiary or link action: `accent` foreground on a neutral surface with a visible underline for inline links.
- Destructive: neutral surface with `danger` text and icon. Do not make a danger-filled button.
- Pressed state removes elevation and may translate by 1 px; loading keeps the button width stable and retains an accessible action name. Disabled buttons use `text-muted`, keep a neutral boundary, and do not rely on low opacity.

### Inputs

Use `surface`, `text`, a 1 px `border`, `sm` radius, and at least a 44 px web / 48 dp Android target. Labels remain visible; placeholders use `text-muted` and never replace labels. Focus uses a 2 px `focus-ring` outline with 2 px offset. Error text and its icon use `danger`, while the field boundary remains `border`; describe the problem and recovery in text. Success is announced only when useful, with `success` text/icon and equivalent semantics.

### List rows

Rows sit directly on one `surface`, use `lg` horizontal insets, and are separated by a 1 px `border` divider rather than individual cards. Use `body` for the primary line, `label` or `caption` plus `text-muted` for metadata, and a minimum 48 px row height. Preserve a clear selected/pressed state without shifting layout; an accent icon plus text is preferable to an accent wash.

### Notifications

In-product transient notifications use `surface-raised` and the theme shadow, with `text` for the message and an optional `success` or `danger` icon and status phrase. Status colors never fill the container. Important errors do not auto-dismiss, and all notices are announced at the appropriate live-region priority. Android system notifications use the dedicated 24 dp single-color notification asset, not the full-color launcher mark.

### Empty states

Use a concise `title`, one useful body sentence, and at most one primary action. The approved mark may appear up to 48 px; do not invent a decorative illustration, fake data, or medical metaphor. Explain what is absent and the action that creates or receives the first item.

### Interaction states and accessibility

Every interactive component defines default, hover where applicable, pressed, focus-visible, disabled, loading, error, and success states. Empty and offline content states are explicit at the containing-surface level. Never communicate state by color alone: pair it with text, shape, iconography, or programmatic semantics. Preserve text zoom and reflow, expose names and states to assistive technology, use logical focus order, and keep keyboard focus visible. Selection, caret, link underline, and browser-native controls use the same token roles rather than unthemed defaults.

## Mark and icon use

Use `brand/mark-small.svg` from 16 px through 32 px, including the favicon and the 24 dp notification icon. Its upright silhouette, one rib, and pixel-aligned bars replace the fine rotated details only at small sizes. Use the full `brand/mark.svg` at 48 px and above. Generic interface icons use 16 px for dense inline metadata, 20 px for standard controls, and 24 px for prominent actions. Align vector edges to the pixel grid at the rendered size and use one consistent optical stroke per size.

Define `X` as the rendered width of the square mark. Keep at least `0.25X` clear space on every side of the standalone mark and the outer bounds of the lockup. Preserve the authored mark-to-wordmark gap inside `brand/lockup.svg`. For the wordmark alone, clear space is at least half its rendered height on every side. Minimum digital widths are 16 px for the small mark, 48 px for the full mark, 80 px for the wordmark, and 280 px for the lockup. Favicons and operating-system icon canvases use their dedicated authored insets instead of this surrounding-layout rule.

The Android adaptive source canvas is 108 dp. Keep the launcher foreground mark within the central 66 dp safe circle, with approximately 58 dp maximum mark extent. The 24 dp notification icon uses the simplified small-mark silhouette and a transparent background. Let the operating system apply launcher masks; do not pre-mask, add a containing badge, distort the mark, recolor individual ribs, or change its forward lean.

## Source and deterministic export

Edit sources, never generated copies:

- Tokens and validation: `brand/tokens.json`, `brand/tokens.schema.json`
- Identity SVGs: `brand/mark.svg`, `brand/mark-small.svg`, `brand/wordmark.svg`, `brand/lockup.svg`
- Android vector/SVG sources: `brand/android/`
- Web font sources: `apps/web/src/assets/fonts/chivo-600.woff2` and `apps/web/src/assets/fonts/public-sans-400.woff2`

Run `mise run brand:export` from the repository root. It validates the token source and generates:

- `apps/web/src/styles/tokens.css`, with `--color-ROLE`, `--font-display`, `--font-ui`, `--font-size-SCALE`, `--line-height-SCALE`, `--space-NAME`, `--radius-NAME`, `--shadow-raised`, and `--motion-NAME` variables.
- `apps/android/app/src/main/java/dev/pneumo/app/ui/theme/BrandColors.kt`, with `Light` and `Dark` objects and PascalCase fields for every color role.
- `brand/favicon.svg`, `brand/favicon.ico`, `brand/icon-192.png`, `brand/icon-512.png`, `brand/icon-maskable-512.png`, `brand/apple-touch-icon.png`, and `brand/og-image.png`, plus matching web public copies.
- Android drawable vectors, adaptive-icon XML in `mipmap-anydpi/` (minSdk 26), notification resources, and launcher PNGs at mdpi 48, hdpi 72, xhdpi 96, xxhdpi 144, and xxxhdpi 192 pixels. Both adaptive icons include the monochrome layer; Android versions before 33 ignore that layer. Legacy PNGs have rounded-square or circular transparent corners, while adaptive backgrounds remain full bleed.

Export is reproducible: it uses only committed local sources, fixed dimensions and mappings, stable property order, and fixed optimizer/rasterizer versions; it performs no network access, embeds no timestamps, and emits byte-identical outputs for unchanged inputs.

The notification drawable is a delivered resource API, even before the Android notification lane consumes it. `brand/android/keep.xml` exports to `res/raw/brand_keep.xml` so resource shrinking retains it without disabling unused-resource lint. App theme wiring and runtime font changes are separate screen-lane work.

## Verification

Run `mise run check:brand` to check source formatting, the strict token schema, all 50 permitted text/UI contrast pairs, required source files, and regenerated assets against git. Add new generated outputs to git before this check; untracked outputs fail explicitly. `mise run check` includes the brand lane alongside the existing lanes.

Committed visual evidence:

- `evidence/small-marks-1x.png`: actual 16 px favicon PNG and 24 px Android-vector raster, shown without scaling at browser device-pixel ratio 1 on light and dark surfaces.
- `evidence/favicon-16.png` and `evidence/notification-24.png`: the exact-size rasters used in that inspection. Their open interiors, single rib, and two motion bars remain distinct.
- `evidence/launcher-api34.png`: the installed debug APK's full-mark adaptive icon, labeled Pneumo in the Pixel 6 API 34 app drawer.

The export smoke checked PNG dimensions, the ICO's 16/32/48 px entries, all five Android densities, unchanged approved font bytes, rejection of four malformed token contracts, and byte-identical repeated export. The adaptive foreground's opaque-pixel radius is 26.32 dp, inside the 33 dp safe-circle radius. `check:android` passes, including unchanged Roborazzi baselines.
