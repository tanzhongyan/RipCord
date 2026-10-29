---

type: design
status: draft
---

# RipCord Design

Owner decisions are in spec 0008 S3. This file is the source for tokens, assets and copy. Change it before changing the UI.

## Identity and voice

RipCord cancels subscriptions for people, under a mandate they sign. It should feel like a careful clerk, not a growth app: calm, exact and plain.

- Say what happens, then what the user does next. "We emailed Singtel. We'll check your next bill on 3 March."
- Name limits and costs up front. Never hide the S$1.99 or the refund rule.
- Use sentence case and contractions. No exclamation marks, no "seamless", "effortless", "simply" or "just".
- RipCord speaks as "we". The user is "you". The agent never says "I" outside chat.

## Logo

| Asset    | File               | Use                                                                                                                                                                                         |
| -------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mark A   | `public/mark.svg`  | Header home link with the wordmark; landing hero; empty states. Two round strokes in `currentColor`: a rope broken in the middle, left tip rising, right tip dipping. No blade or scissors. |
| Mark C   | `src/app/icon.svg` | Favicon and app icon: mark A in white on a coral rounded square                                                                                                                             |
| Wordmark | Text, not an image | Lowercase `ripcord` in Geist 500, letter-spacing −0.02em, beside mark A                                                                                                                     |

Both marks have one colour, so they work in light and dark. Minimum mark A width is 20 px; below that, use mark C.

## Browser and share assets

- `icon.svg` (mark C); `favicon.ico` 32 px generated from it; `apple-icon.png` 180 px (mark C, square, no transparency).
- `opengraph-image` 1200×630: paper background, mark A in ink with the right half in coral, `ripcord` and the tagline in Geist.
- Tab title template: `%s · RipCord`. The landing title is "RipCord · Cancel subscriptions without the phone calls".

## Colour tokens

Coral `#D85A30` passes 3:1 only, so it is for the mark, large graphics and focus rings. Coral text and coral fills with text use `#B4461F`. Buttons are ink by default; coral is the one accent per view.

| Token pair                         | Light                 | Dark                  | Contrast (light / dark)      |
| ---------------------------------- | --------------------- | --------------------- | ---------------------------- |
| `background` / `foreground`        | `#FAF8F3` / `#1B1F2A` | `#14171F` / `#F2EFE8` | 15.5 / 15.6                  |
| `card` / `card-foreground`         | `#FFFFFF` / `#1B1F2A` | `#1C2029` / `#F2EFE8` | 16.6 / 14.2                  |
| `muted-foreground` on `background` | `#6B6F7A`             | `#A3A7B1`             | 4.7 / 7.4                    |
| `primary` / `primary-foreground`   | `#1B1F2A` / `#FAF8F3` | `#F2EFE8` / `#14171F` | 15.5 / 15.6                  |
| `accent` / `accent-foreground`     | `#B4461F` / `#FFFFFF` | `#E8774F` / `#14171F` | 5.5 / 6.1                    |
| `cut` (graphics only)              | `#D85A30`             | `#E8774F`             | 3.7 / 6.1 against background |

`destructive`, `border` and `ring` come from the template defaults, tuned so the contrast check added in plan T1 passes. Status colours (success, warning) take one hue each and always pair with a text label.

## Type

- Geist for all text and Geist Mono for amounts, case IDs, mandate references and codes. Both are OFL-1.1 and already loaded.
- Scale: 14 body (small), 16 body, 20 h3, 24 h2, 36/48 h1 (mobile/desktop). Line height 1.6 for body and 1.15 for headings.
- Weights: 400 and 500 only, plus 600 for the h1.

## Icons

`lucide-react`, 16 or 20 px, stroke 1.75. Icons support a label; they never replace one.

## Signature element

The rope break:

- **Landing:** a full-width divider between sections. It is a straight line that breaks with the A-mark curl.
- **Case page:** the progress line runs through the lifecycle steps and snaps (left tip up, right tip down, coral) at `SUCCEEDED`.
  - `FAILED` and `WITHDRAWN` show a muted, unbroken line.
  - `DISPUTED` shows the snap with a warning label.

Use it nowhere else.

## Layout

- Landing: max width 1080 px, 16 px side gutter on mobile, sections 96 px apart on desktop and 64 px on mobile.
- App: sidebar of 240 px, becoming a slide-out menu below `md` (768 px); content max width 960 px.
- Breakpoints are Tailwind's defaults. Base classes target 375 px; `sm`, `md` and `lg` add layout. Full-height layouts use `dvh`, and fixed bars pad with the safe-area insets.
- Radius 10 px for cards and 8 px for controls. Borders are 1 px. Shadows only on popovers and dialogs.

## Avoid

Purple or blue gradients, glassmorphism, glowing blobs, emoji, stock photos, fake testimonials or logos, counters of made-up users, "AI-powered" badges, dark landing with light app, centred walls of text.

## Licences

| Asset                | Source                                   | SPDX        |
| -------------------- | ---------------------------------------- | ----------- |
| Geist, Geist Mono    | <https://github.com/vercel/geist-font>   | OFL-1.1     |
| Lucide icons         | <https://github.com/lucide-icons/lucide> | ISC         |
| Mark A, mark C       | Drawn for RipCord                        | Owner's own |
| shadcn/ui components | <https://github.com/shadcn-ui/ui>        | MIT         |
