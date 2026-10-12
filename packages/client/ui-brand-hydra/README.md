---
description: "The Hydra brand plugin: the sidebar mark and name, the blank-session hero mark, and the Hydra palette and assets of this private build."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-brand-hydra

## Summary

`ui-brand-hydra` fills the Web client's three brand slots with the Hydra identity: a front-facing dragon's face with sweeping horns and amber eyes in the sidebar rail and before the blank-session headline, and the `Hydra` name beside the expanded mark. The mark is an original drawing, not the film studio's logo, and replaces `ui-brand-official` in the `dsh-web-app` bundle. It is the shared `HydraLogo` primitive, filled in the current text color, so it follows every theme; the name comes from this plugin's locale dictionary. The palette lives in `ui-theme`, the favicon and install manifest in `apps/web/public`.

## Table of Contents

- [Use this package](#use-this-package)
- [Palette](#palette)
- [Assets](#assets)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The `dsh-web-app` bundle mounts the row `ui-brand-hydra`. To restore the official mark, disable this row and enable `ui-brand-official` in a profile patch. The browser tab title is separate: the client build reads `DSH_CLIENT_TITLE` (set to `Hydra` in `scripts/client-build-environment.ts`).

There is no configuration.

-----

<a id="palette"></a>
## Palette

`ui-theme`'s `design-platform.css` keeps the token names of the design system and changes their values: the `--dsw-static-deepseek-*` scale is now the Hydra red scale, so every module that referenced the old blue (chat gradient, file-type icons, the ongoing state dot) follows without edits, and a `--dsw-static-venom-*` scale plus `--dsw-alias-brand-highlight` carry the lime accent. Contrast is checked by `packages/client/ui-theme/tests/hydra-palette.client.spec.ts`.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--dsw-alias-brand-primary` | `rgb(185, 28, 28)` red-700 | `rgb(248, 113, 113)` red-400 | Primary button fill, brand accents |
| `--dsw-alias-brand-text` | `rgb(153, 27, 27)` red-800 | `rgb(252, 165, 165)` red-300 | Brand-colored text |
| `--dsw-alias-link` | red-700 | red-300 | Links (AA against the base background in both) |
| `--dsw-alias-button-primary-hover` | red-800 | red-300 | Primary button hover |
| `--dsw-alias-label-primary-bluish` | `rgb(100, 20, 20)` | `rgb(254, 202, 202)` | Formerly the blue-tinted primary label |
| `--dsw-alias-interactive-bg-*` | red at 6, 12, 16 percent | red at 16, 24 percent | Hover and active washes; the active wash with a 2px brand inset bar marks the open session and the open Settings section |
| `--dsh-ember-glow`, `-halo`, `-stroke`, `-ring` | red-700 at 10, 30, 55, 12 percent | red-500 at 22, 45, 16 percent; stroke red-400 at 55 | Hero glow and mark halo, composer focus stroke and ring |
| `--dsw-alias-brand-highlight` | `rgb(247, 173, 49)` amber-400 | same | The dragon's eye, non-text highlights only |
| `--dsw-static-deepseek-50…900` | red 50…900 | same | Legacy scale name, red values |

Light keeps the white canvas with the cool `--dsw-static-neutral-bluish-*` scale; its text ladder is secondary `rgb(74, 79, 86)`, tertiary `rgb(103, 108, 115)`, and caption `rgb(138, 143, 150)`, and the palette spec holds secondary and tertiary at 4.5:1 or more on every text surface and caption hints at 3:1. Dark sits on black: the dark sheet overrides `--dsw-static-neutral-bluish-750…1000` and `--dsw-static-neutral-800…900` to a scale from `rgb(42, 42, 44)` down to `rgb(0, 0, 0)`, so the base canvas is `rgb(7, 7, 8)` and the layers above it `rgb(16, 16, 17)`, `rgb(21, 21, 22)`, and `rgb(30, 30, 31)`.

The blank-session hero shows the mark at 56px in an ember halo over an ember glow that breathes on a 6-second cycle; the eyes (`data-part="pupil"` in `HydraLogo`) brighten every 4 seconds, and hovering the mark flares it. All of it stops when the viewer asks for reduced motion (`HeroShell.module.css` in `ui-conversation`).

A running turn shows the `HydraLogo` face at 18px in brand red before its "The dragon is thinking…" label (`巨龙思考中…` in Chinese), its eyes brightening from amber to gold under a pulsing ember halo. Each Think row leads with the same face in the row's ink, and while its reasoning streams the face turns brand red and its eyes glow the same way. The brightest eye color is the `--dsh-dragon-eye-glow` token; under reduced motion nothing moves.

-----

<a id="assets"></a>
## Assets

| Asset | Location | Notes |
|---|---|---|
| Mark | `packages/client/ui-primitives/src/HydraLogo.tsx` | `HydraLogo`, plus `HYDRA_LOGO_FACE`, `HYDRA_LOGO_RIDGE`, `HYDRA_LOGO_EYES`, `HYDRA_LOGO_PUPILS`, and `HYDRA_LOGO_NOSTRILS` for composers |
| Favicon | `apps/web/public/favicon.svg` | Same geometry, red-700 strokes and head (red-400 under dark color scheme), amber eye |
| Install manifest | `apps/web/public/manifest.webmanifest` | `name` and `short_name` Hydra, `theme_color` `#b91c1c` |
| Page meta | `apps/web/index.html` | `theme-color` `#b91c1c`, title Hydra |
| Hero fallback | `packages/client/ui-conversation/src/client/skeleton/EmptyHero.tsx` | `HydraLogo` at 56px when no hero occupant is mounted |
| Sidebar fallback | `packages/client/ui-sidebar/src/client/SidebarRoot.tsx` | `HydraLogo` at 24px when no mark occupant is mounted |
| Thinking dragon | `packages/client/ui-chat/src/client/chat/ChatView.tsx` | `HydraLogo` at 18px beside the running-turn label, eyes glowing |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Host half: inert `apply` so the Loader row exists |
| [`src/client/index.ts`](src/client/index.ts) | Registers the `brand-hydra` dictionary and the three slot occupants once their holes are declared |
| [`src/client/Brand.tsx`](src/client/Brand.tsx) | The mark, hero mark, and name components over `HydraLogo` |
| [`src/client/locales.ts`](src/client/locales.ts) | zh and en dictionaries (one key: `name`) |

Slots: `sidebar.brand.mark` and `sidebar.brand.name` (declared by `ui-sidebar`), `conversation.hero.brand.mark` (declared by `ui-conversation`).

No invariant companion is published because the package only registers a dictionary and three slot occupants, and the `dsh-client-ui-renderer` companion already checks each `slots/changed` dispatch against its slot registry.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package contributes browser presentation only.

#### KV Cache effect

Independent: nothing here reaches a model request.

## Known Limitations and Deferred Work

- **Tab title is build-time** — `DSH_CLIENT_TITLE` is baked into the client bundle; changing the brand at runtime does not rename the tab.
- **Desktop app name unchanged** — `apps/desktop` carries no product-name field of its own; its window title follows the web title, and the installer name still comes from the package name.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
