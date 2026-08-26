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
npm test           # pure logic, plus PDF encryption verified against pdf.js
npm run verify     # check + test + build + built-page contract check
npm run sync:pdfjs # copy pdf.js runtime assets into public/ (runs on build)
```

## Layout

```
src/
  data/
    tools.ts         single source of truth for the tools index, switcher, sitemap
  layouts/
    BaseLayout.astro head/SEO/header/footer shell
    ToolLayout.astro per-tool chrome: breadcrumb, title, tool switcher
  components/
    Dropzone.astro   file picker + drag-drop + paste surface
  lib/
    color/convert.ts color parsing into sRGB (used by the QR generator)
    contrast/wcag.ts WCAG 2.1 luminance + contrast ratio
    img/raster.ts    canvas decode/resize/encode for the image tools
    pdf/pdfjs.ts     lazy pdf.js loader, asset paths, password handling
    qr/qr.ts         QR matrix, SVG/canvas rendering, WiFi/vCard payloads
    ui/clipboard.ts  shared copy + toast
    ui/download.ts   blob download + ZIP packing (fflate)
    ui/dropzone.ts   wiring for Dropzone.astro
    ui/files.ts      filenames, byte formatting, page-range parsing
    ui/limits.ts     input size and canvas-pixel ceilings
    pdf/pdflib.ts    shared @cantoo/pdf-lib access, encryption detection
    pdf/protect.ts   AES-256 encryption and permissions
    pdf/unlock.ts    password removal by rebuilding the document
    pdf/compress.ts  image recompression and page flattening
    docx/blocks.ts   mammoth HTML -> block model (pure, no DOM)
    docx/layout.ts   line breaking, pagination, tables (pure, injected measurer)
    docx/topdf.ts    .docx -> PDF, tying mammoth + layout + pdf-lib together
    docx/wordxml.ts  reads the appearance mammoth discards, straight from the XML
  pages/
    index.astro      landing page
    tools/           one file per tool — the URL is the filename
    sitemap.xml.ts   generated from tools.ts, excludes coming-soon entries
scripts/
  sync-pdfjs.mjs     copies pdf.js CMaps/fonts/wasm into public/pdfjs
  test-tools.mjs     assertions for files, raster, QR, color, limits, compression, docx
  test-pdf.mjs       encryption, compression and .docx→PDF verified with pdf.js (runs in CI)
  test-dom.mjs       checks built HTML against the JS that drives it
public/
  pdfjs/             GENERATED + gitignored — see scripts/sync-pdfjs.mjs
```

## Adding a tool

1. Add an entry to `src/data/tools.ts` (`status: 'coming-soon'` renders a disabled preview card).
2. Create `src/pages/tools/<slug>.astro` wrapping `<ToolLayout slug="<slug>">`.

The index grid, the tool switcher, and the sitemap all pick it up automatically.

Keep heavy dependencies inside the page that needs them (`import()` inside the tool's
`<script>`), so the QR generator never ships a PDF library.

## Deployment

Pushing to `master` or `main` runs `.github/workflows/deploy.yml`, which builds and publishes
`dist/`.

**One-time setup:** in the repo's *Settings → Pages*, set **Source** to **GitHub Actions**.
Without that, Pages keeps serving the old root `index.html` from the branch and ignores the build.

## Notes

- `build.sourcemap` is off on purpose. Shipping sourcemaps publishes your original source
  alongside the bundle.
- The colour parsing and WCAG math that survive in `lib/color` and `lib/contrast` exist only for
  the QR generator, which refuses a foreground/background pair a scanner cannot separate. They are
  still checked against known WCAG pairs (`#767676` on white = 4.54). Run `npm test`.
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
- `src/lib/pdf/pdflib.ts` carries a measured table of how @cantoo/pdf-lib behaves across the
  three encryption shapes (none / owner-only / user password). An owner-only file opens on an
  EMPTY-STRING password, not on no password, and `ignoreEncryption` loads the structure while
  leaving content streams encrypted — so it must never be used to read a document.
- Unlocking rebuilds the document with `copyPages`. That is the only approach that actually
  drops `/Encrypt`: saving after `load({password})` leaves the reference in the xref dictionary,
  and clearing `context.security` or `trailerInfo.Encrypt` has no effect. The cost is that
  bookmarks, form fields and attachments do not survive, which the UI states.
- `compress-pdf` takes its image encoder as an argument rather than importing one, so the same
  code path runs under canvas in the browser and under sharp in `scripts/test-pdf.mjs`. That is
  what lets CI verify the promise that recompression leaves text byte-identical.
- Word→PDF keeps the text as real text rather than rasterising, so it stays selectable and
  searchable. It is not a Word layout engine: line breaks will not match Word, because Word
  measures with Calibri and Cambria and neither can be redistributed. Font colours, highlighting,
  headers, footers, footnotes, explicit page breaks, columns and vertically merged cells are not
  carried over either, and a paragraph mixing sizes takes its first size. The page says all of
  this rather than implying a visual clone.
- The built-in PDF fonts are WinAnsi only, so Latin-1 accents work but CJK, Devanagari and Arabic
  do not. Those characters are detected up front and reported, never dropped in silence. Shipping
  an OFL Unicode TTF would fix it — Fontsource only publishes woff2, which fontkit cannot embed.
- `docx/blocks.ts` treats unknown tags as transparent AND turns stray text into a paragraph.
  Losing content without a trace is the worst failure a document converter can have.
- Word→PDF reads appearance from `word/document.xml` itself, because mammoth is a *semantic*
  converter and deliberately drops it: alignment (`w:jc`), font size (`w:sz`), indents (`w:ind`),
  tab stops (`w:tabs`) and page setup (`w:sectPr`). A right-aligned tab stop makes the text after
  it END on the stop, which is how a CV gets its dates flush to the margin.
- That second pass correlates by TEXT, not position: properties attach to a block only when its
  text matches the paragraph in the XML. If mammoth merged or split something, the rest is simply
  not applied — it degrades to plain output instead of confidently formatting the wrong paragraph.
  The whole pass sits in a catch, since it is an enhancement and must never break a conversion
  that already worked. `styled` / `unstyled` in the result report the split.
- Reading `<w:p>` text for that correlation must exclude `<w:pPr>`. The tab-stop DEFINITIONS in
  there are `<w:tab>` elements too, indistinguishable by tag name from real tab characters, and
  counting them prefixed a spurious tab to exactly the paragraphs whose properties matter most.
- Input limits live in `src/lib/ui/limits.ts`. Everything runs in the visitor's tab, so passing
  the memory ceiling kills the tab rather than raising an error — files are screened before being
  decoded, and an oversized page is skipped with a suggested scale rather than taken on.

## Roadmap

All eight tools are live: QR generator, image converter, image→PDF, PDF→JPG, compress PDF,
protect PDF, unlock PDF, Word→PDF.

The three colour tools (color converter, contrast checker, palette collection) were removed. The
colour parsing and WCAG ratio helpers they shared stayed, trimmed to what the QR generator uses.

Next: possibly PDF→Word — but see the note below before building it.

An earlier version of this file claimed the three PDF security tools needed `qpdf` compiled to
WASM plus a `coi-serviceworker` shim for `crossOriginIsolated`. That turned out to be wrong.
`@cantoo/pdf-lib` — a maintained MIT fork of pdf-lib — provides AES-256 encryption and
password-protected loading directly, so there is no WASM, no COOP/COEP shim, and no forced
reload anywhere in this project.
