# Pikugo

Turn a handful of photos into a smooth **wiggle animation** (animated WebP), entirely in the browser.

Pick the point that should stay still in each photo. Pikugo aligns the photos on those points, frames the
result the way you choose, and encodes an animated WebP on your device. Nothing is uploaded and there is no
server: the site is a static bundle hosted on GitHub Pages.

## Features

- **Focus editor**: click to set each photo's focal point. Hover to magnify, use onion skin to overlay the
  previous photo under your cursor, and use the keyboard (`←`/`→` to switch photos, `Shift`+arrows to nudge).
- **Frame delay**: 20–5000 ms per frame (default 100 ms), with presets, plus **Loop** or **Bounce** playback.
- **Framing options**
  - **Crop to overlap**: keep only the area every photo covers, so frames never show empty corners.
  - **Layer with transparency**: keep every pixel. Areas a photo doesn't cover become transparent.
  - **Aspect ratio**: presets (1:1, 4:5, 4:3, 3:2, 16:9, 9:16) or any custom `W:H` / decimal.
  - **Focus position**: *Auto* centres the subject as far as the photos allow. *Fixed* pins it to a chosen
    spot in the frame (3×3 snap grid, X/Y sliders, or drag the frame in the preview).
- **Live preview**: an animated canvas showing the output frame, the area all photos share, each photo's
  edges and the cropped-away parts. Hovering or focusing any option previews it before you apply it.
- **Output**: longest-edge limit and quality, with the size, duration and coverage shown before encoding.
- **Fast encoding**: frames are drawn on an `OffscreenCanvas` in a Web Worker, compressed with the browser's
  native WebP encoder, and muxed into an animated WebP. If OffscreenCanvas isn't available, it falls back to
  the main thread.

Encoding needs a browser that can produce WebP from a canvas (current Chrome, Edge and Firefox). Safari can
*display* the result but can't *encode* WebP, and Pikugo says so when that happens.

## Development

Requires Node.js 22.12+ (CI uses the version in [`.nvmrc`](.nvmrc)).

```bash
npm install
npm run dev          # local dev server with hot reload
npm run build        # typecheck + production build into dist/
npm run preview      # serve the production build
```

### Tests

```bash
npm test                  # unit tests (Vitest + jsdom)
npm run test:coverage     # unit tests with coverage gates on the core logic
npx playwright install chromium   # one-off: download the browser for e2e tests
npm run test:e2e          # end-to-end tests against the production build (needs `vite build` first)
npm run check             # everything CI runs
```

- **Unit tests** (`tests/`) cover the layout maths, the WebP container reader/writer, option parsing and the
  encode pipeline (with a fake canvas).
- **End-to-end tests** (`e2e/`) drive the real app in Chromium: they generate animations, decode the bytes,
  and check frame count, per-frame delay, dimensions, the alpha flag and that the browser can display the
  result.

> **Windows note:** `npm test` goes through [`scripts/vitest.mjs`](scripts/vitest.mjs), which upper-cases
> the drive letter of the working directory. VS Code terminals often start in `c:\…`, which makes Vitest
> load twice and fail every suite with `Cannot read properties of undefined (reading 'config')`.

## Project layout

```
index.html                 Page markup (Vite entry)
public/                    Static files copied as-is (favicon)
src/
  main.ts                  Bootstraps the app
  core/                    Pure, DOM-free logic (fully unit tested)
    geometry.ts            Frame layout: crop/layer, aspect ratio, anchored focus
    options.ts             Option model, defaults, validation, frame sequence
    plan.ts                Combines layout, scaling and sequence into an encode plan
    webp.ts                RIFF/WebP chunk reader and animated WebP muxer
    format.ts              Display formatting helpers
  render/
    encode-core.ts         Draw + encode + mux pipeline shared by worker and main thread
    encode.worker.ts       OffscreenCanvas encoder running in a Web Worker
    encoder.ts             Picks worker or main-thread encoding
    protocol.ts            Worker message types
  ui/                      DOM components (focus editor, filmstrip, options, preview, …)
  styles/                  CSS: design tokens (light/dark), components, layout, CSS-drawn art
  assets/icons/            SVG icons, inlined into the CSS bundle as data URIs
tests/                     Vitest unit tests
e2e/                       Playwright end-to-end tests
.github/workflows/         CI and GitHub Pages deployment
```

## How the framing works

Each photo *i* has size *wᵢ × hᵢ* and focal point *(fxᵢ, fyᵢ)*. Measured from the focal point, it extends
`fxᵢ` to the left, `wᵢ − fxᵢ` to the right, and similarly vertically.

- **Crop** uses the *smallest* extent on each side across all photos (their intersection), then shrinks the
  frame to fit the aspect ratio and anchor.
- **Layer** uses the *largest* extent on each side (their union), then grows the frame to fit the aspect
  ratio and anchor. In layer mode a fixed anchor is kept at least 5% from the edges, since pinning the focus
  exactly on an edge would need an infinitely large frame.

Every photo is then drawn so its focal point lands on the frame's shared focal point.

## Deployment

[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) runs on every push and pull request:
typecheck → unit tests with coverage → build → Playwright tests. Pushes to the repository's default branch
then publish `dist/` to GitHub Pages.

One-time setup: in the repository on GitHub, open **Settings → Pages** and set **Source** to
**GitHub Actions**. The build uses relative asset paths, so it works at `https://<user>.github.io/<repo>/`
without any configuration.
