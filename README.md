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
npm test           # color / contrast math assertions
npm run palettes   # regenerate src/data/palettes.ts
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
  lib/
    color/convert.ts sRGB / HSL / HSV / CMYK / OKLCH conversion + parsing
    contrast/wcag.ts WCAG 2.1 luminance, ratio, compliance, auto-fix
    ui/clipboard.ts  shared copy + toast
  pages/
    index.astro      landing page
    tools/           one file per tool — the URL is the filename
    sitemap.xml.ts   generated from tools.ts, excludes coming-soon entries
scripts/
  gen-palettes.mjs   seeded OKLCH palette generator
  test-color.mjs     assertions for the color + contrast math
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

## Roadmap

Live: color converter, contrast checker, palette collection.

Planned: QR generator, image converter, image→PDF, PDF→JPG, compress PDF, protect PDF, unlock PDF.

The three PDF security tools need `qpdf` compiled to WASM, which requires
`crossOriginIsolated`. GitHub Pages cannot set the COOP/COEP headers that normally provides, so
those pages will need a `coi-serviceworker`-style shim that injects the headers client-side —
loaded only on those pages, since first activation forces a reload.
