# nikhilkhilwani.github.io

Personal site + a growing set of free, browser-only tools. Built with [Astro](https://astro.build)
and deployed to GitHub Pages by GitHub Actions.

Every tool runs entirely client-side. No files are uploaded, there is no backend, and there are
no accounts — which is also why there are no usage limits.

## Commands

```sh
npm install
npm run dev        # local dev server, http://localhost:4321
npm run build      # static build into dist/
npm run preview    # serve the built dist/
npm run check      # astro + TypeScript diagnostics
npm test           # color/contrast math + file, QR, and page-range assertions
npm run verify     # check + test + build + built-page contract check
npm run palettes   # regenerate src/data/palettes.ts
npm run sync:pdfjs # copy pdf.js runtime assets into public/ (runs on build)
```

## Layout

```
src/
  data/
    tools.ts         single source of truth for the tools index, switcher, sitemap
    palettes.ts      GENERATED — see scripts/gen-palettes.mjs
  layouts/
    BaseLayout.astro head/SEO/header/footer shell
    ToolLayout.astro per-tool chrome: breadcrumb, title, tool switcher
  components/
    Dropzone.astro   file picker + drag-drop + paste surface
  lib/
    color/convert.ts sRGB / HSL / HSV / CMYK / OKLCH conversion + parsing
    contrast/wcag.ts WCAG 2.1 luminance, ratio, compliance, auto-fix
    img/raster.ts    canvas decode/resize/encode for the image tools
    pdf/pdfjs.ts     lazy pdf.js loader, asset paths, password handling
    qr/qr.ts         QR matrix, SVG/canvas rendering, WiFi/vCard payloads
    ui/clipboard.ts  shared copy + toast
    ui/download.ts   blob download + ZIP packing (fflate)
    ui/dropzone.ts   wiring for Dropzone.astro
    ui/files.ts      filenames, byte formatting, page-range parsing
  pages/
    index.astro      landing page
    tools/           one file per tool — the URL is the filename
    sitemap.xml.ts   generated from tools.ts, excludes coming-soon entries
scripts/
  gen-palettes.mjs   seeded OKLCH palette generator
  sync-pdfjs.mjs     copies pdf.js CMaps/fonts/wasm into public/pdfjs
  test-color.mjs     assertions for the color + contrast math
  test-tools.mjs     assertions for files, raster, and QR logic
  test-dom.mjs       checks built HTML against the JS that drives it
public/
  pdfjs/             GENERATED + gitignored — see scripts/sync-pdfjs.mjs
```

## Adding a tool

1. Add an entry to `src/data/tools.ts` (`status: 'coming-soon'` renders a disabled preview card).
2. Create `src/pages/tools/<slug>.astro` wrapping `<ToolLayout slug="<slug>">`.

The index grid, the tool switcher, and the sitemap all pick it up automatically.

Keep heavy dependencies inside the page that needs them (`import()` inside the tool's
`<script>`), so a color tool never ships a PDF library.

## Deployment

Pushing to `master` or `main` runs `.github/workflows/deploy.yml`, which builds and publishes
`dist/`.

**One-time setup:** in the repo's *Settings → Pages*, set **Source** to **GitHub Actions**.
Without that, Pages keeps serving the old root `index.html` from the branch and ignores the build.

## Notes

- `build.sourcemap` is off on purpose. Shipping sourcemaps publishes your original source
  alongside the bundle.
- Palette data is generated from a seeded PRNG, so re-running `npm run palettes` reproduces the
  same 132 palettes. Change the seed in `scripts/gen-palettes.mjs` to get a different set.
- The color and contrast math is checked against published reference values (Ottosson's OKLab
  figures, and known WCAG pairs such as `#767676` on white = 4.54). Run `npm test`.
- `scripts/test-dom.mjs` runs against `dist/` after a build. The tool pages talk to their markup
  by id, which TypeScript cannot check, so it verifies that every id-shaped string literal in a
  page's own JavaScript matches an id in that page's HTML — plus id uniqueness and that every
  `label[for]` and `aria-*` reference resolves.
- `public/pdfjs/` is generated, not committed. pdf.js fetches CMaps, standard fonts, and its
  JBIG2/JPX WASM decoders at render time; serving them from our own origin is what keeps
  PDF→JPG working offline. That is ~3.8 MB of output, all of it lazily fetched.
- pdf.js v6 hangs teardown off `doc.loadingTask.destroy()`, not `doc.destroy()`, and wants
  `canvas` in the render call rather than only `canvasContext`.
- Images bound for a PDF are embedded as-is when they are already JPEG or PNG, and re-encoded
  through a canvas otherwise — pdf-lib can embed nothing else.

## Roadmap

Live: color converter, contrast checker, palette collection, QR generator, image converter,
image→PDF, PDF→JPG.

Planned: compress PDF, protect PDF, unlock PDF.

The three PDF security tools need `qpdf` compiled to WASM, which requires
`crossOriginIsolated`. GitHub Pages cannot set the COOP/COEP headers that normally provides, so
those pages will need a `coi-serviceworker`-style shim that injects the headers client-side —
loaded only on those pages, since first activation forces a reload.
