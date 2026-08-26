/**
 * Static contract check over the BUILT site (run after `npm run build`).
 *
 * The tool pages are plain DOM scripts talking to markup by id. TypeScript
 * cannot catch a typo in `getElementById('pj-run')`, and there is no test
 * runner with a DOM here — so this walks the real output instead and verifies:
 *
 *   1. ids are unique within a page
 *   2. every label[for] / aria-controls / aria-labelledby / aria-describedby
 *      points at an id that exists on that page
 *   3. every id-shaped string literal in the JavaScript a page loads (following
 *      static and dynamic imports) matches an id in that page's HTML
 *   4. every class name assigned at RUNTIME has at least one unscoped CSS rule.
 *      Astro appends [data-astro-cid-…] to each selector in a page's <style>,
 *      and document.createElement() nodes never carry that attribute — so a
 *      scoped rule silently does not apply and the element renders unstyled.
 *
 * (3) is the one that earns its keep: it is exactly the failure that would
 * otherwise ship as a dead button.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';

const DIST = 'dist';

/** Literals that look like an id by shape but are a class or token. */
const NOT_IDS = new Set(['sr-only', 'ui-monospace', 'no-store', 'no-cache', 'x-ms']);

/**
 * Only chunks built from our own modules are scanned for id literals.
 * Third-party bundles are full of id-shaped strings that are nothing of the
 * kind — pdf.js alone contributes "no-repeat", "iso-8859-1", and
 * "non-scaling-stroke" — and scanning them produces pure noise.
 *
 * The allowlist is derived from src/ rather than hardcoded, so a new shared
 * module is covered the moment it exists. Page entry chunks are matched
 * separately by Astro's naming pattern.
 */
async function ourChunkStems() {
  const stems = new Set();
  for (const dir of ['src/lib', 'src/data', 'src/components']) {
    for (const file of await walk(dir).catch(() => [])) {
      stems.add(basename(file).replace(/\.[^.]+$/, ''));
    }
  }
  return stems;
}

const isOurChunk = (path, stems) => {
  const name = basename(path);
  if (name.includes('astro_type_script')) return true;
  return stems.has(name.split('.')[0]);
};

/** id-ish: short lowercase prefix, hyphen, then more. Matches our convention. */
const ID_SHAPE = /^[a-z]{2,3}-[a-z0-9-]{2,}$/;

let fail = 0;
let checks = 0;

const problem = (msg) => {
  console.log(`FAIL ${msg}`);
  fail++;
};

async function walk(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(path)));
    else found.push(path);
  }
  return found;
}

const OUR_STEMS = await ourChunkStems();

const all = await walk(DIST);
const htmlFiles = all.filter((f) => f.endsWith('.html'));
if (!htmlFiles.length) {
  console.log('FAIL no HTML in dist/ — run `npm run build` first');
  process.exit(1);
}

/** Every string literal in a JS file, single/double/backtick with no interpolation. */
function stringLiterals(js) {
  const out = new Set();
  for (const re of [/"([^"\\\n]{1,64})"/g, /'([^'\\\n]{1,64})'/g, /`([^`\\\n$]{1,64})`/g]) {
    for (const match of js.matchAll(re)) out.add(match[1]);
  }
  return out;
}

/** Static + dynamic import specifiers pointing at sibling chunks. */
function importedChunks(js) {
  const out = new Set();
  for (const re of [
    /from\s*["']([^"']+\.m?js)["']/g,
    /import\s*\(\s*["']([^"']+\.m?js)["']\)/g,
    /import\s*["']([^"']+\.m?js)["']/g,
  ]) {
    for (const match of js.matchAll(re)) out.add(match[1]);
  }
  return out;
}

const jsCache = new Map();
async function readJs(path) {
  if (!jsCache.has(path)) {
    jsCache.set(
      path,
      readFile(path, 'utf8').catch(() => null),
    );
  }
  return jsCache.get(path);
}

/** Follows imports from `entries`, returning every reachable JS source. */
async function reachableJs(entries) {
  const seen = new Set();
  const queue = [...entries];
  const sources = [];

  while (queue.length) {
    const path = queue.pop();
    if (!path || seen.has(path)) continue;
    seen.add(path);

    const js = await readJs(path);
    if (js === null) continue;
    sources.push({ path, js });

    for (const spec of importedChunks(js)) {
      // Chunks reference each other relatively, and Astro emits them flat.
      const resolved = spec.startsWith('/')
        ? join(DIST, spec)
        : join(dirname(path), spec.replace(/^\.\//, ''));
      queue.push(resolved);
    }
  }
  return sources;
}

for (const htmlPath of htmlFiles.sort()) {
  const html = await readFile(htmlPath, 'utf8');
  const route = `/${htmlPath.replace(/\\/g, '/').replace(/^dist\//, '').replace(/index\.html$/, '')}`;

  /* --- 1. ids unique -------------------------------------------------- */
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const idSet = new Set(ids);
  checks++;
  if (ids.length !== idSet.size) {
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    problem(`${route} has duplicate id(s): ${[...new Set(dupes)].join(', ')}`);
  }

  /* --- 2. references resolve ------------------------------------------ */
  const refs = [
    ...[...html.matchAll(/<label[^>]*\sfor="([^"]+)"/g)].map((m) => ['label[for]', m[1]]),
    ...[...html.matchAll(/\saria-controls="([^"]+)"/g)].map((m) => ['aria-controls', m[1]]),
    ...[...html.matchAll(/\saria-labelledby="([^"]+)"/g)].map((m) => ['aria-labelledby', m[1]]),
    ...[...html.matchAll(/\saria-describedby="([^"]+)"/g)].map((m) => ['aria-describedby', m[1]]),
  ];
  for (const [kind, value] of refs) {
    // aria-labelledby may list several ids.
    for (const id of value.trim().split(/\s+/)) {
      checks++;
      if (!idSet.has(id)) problem(`${route} ${kind}="${id}" has no matching element`);
    }
  }

  /* --- 3. id-shaped literals in the page's JS exist ------------------- */
  const entries = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((src) => src.startsWith('/'))
    .map((src) => join(DIST, src));

  if (!entries.length) continue;

  const sources = await reachableJs(entries);
  const missing = new Map();

  for (const { path, js } of sources) {
    if (!isOurChunk(path, OUR_STEMS)) continue;
    for (const literal of stringLiterals(js)) {
      if (!ID_SHAPE.test(literal) || NOT_IDS.has(literal)) continue;
      checks++;
      if (!idSet.has(literal)) {
        if (!missing.has(literal)) missing.set(literal, basename(path));
      }
    }
  }

  for (const [id, where] of missing) {
    problem(`${route} script references #${id} (in ${where}) but no such id is in the HTML`);
  }

  /* --- 4. runtime-assigned classes must have an unscoped rule ---------- */
  // Astro rewrites every selector in a page's <style> to
  // `.foo[data-astro-cid-xxxx]`. Nodes built with document.createElement never
  // carry that attribute, so such a rule never matches them and the element
  // renders with browser defaults. This catches that silently-broken case.
  let css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
  for (const href of [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)].map((m) => m[1])) {
    if (!href.startsWith('/')) continue;
    css += '\n' + ((await readFile(join(DIST, href), 'utf8').catch(() => '')) || '');
  }

  const runtimeClasses = new Set();
  for (const { path, js } of sources) {
    if (!isOurChunk(path, OUR_STEMS)) continue;
    for (const re of [
      /\.className\s*=\s*["']([^"']+)["']/g,
      /classList\.add\(\s*["']([^"']+)["']/g,
    ]) {
      for (const m of js.matchAll(re)) {
        for (const cls of m[1].split(/\s+/)) if (cls) runtimeClasses.add(cls);
      }
    }
  }

  for (const cls of runtimeClasses) {
    const esc = cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const unscoped = new RegExp('\\.' + esc + '(?![\\w-])(?!\\[data-astro-cid)').test(css);
    const scoped = new RegExp('\\.' + esc + '(?![\\w-])\\[data-astro-cid').test(css);
    checks++;
    if (scoped && !unscoped) {
      problem(
        `${route} .${cls} is assigned at runtime but every CSS rule for it is ` +
          `Astro-scoped — createElement nodes lack [data-astro-cid], so it renders unstyled`,
      );
    }
  }

  const scanned = sources.filter((s) => isOurChunk(s.path, OUR_STEMS)).length;
  console.log(
    `ok   ${route.padEnd(30)} ${idSet.size} ids · ${scanned}/${sources.length} chunk(s) · ${refs.length} refs · ${runtimeClasses.size} runtime classes`,
  );
}

console.log(`\n${checks} assertions, ${fail} failed`);
process.exit(fail ? 1 : 0);
