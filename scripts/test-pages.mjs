/**
 * Site-wide contract check over the BUILT site (run after `npm run build`).
 *
 * test-dom.mjs verifies the interactive tool pages talk to their own markup
 * correctly. This one covers the things that span pages, where the failure is
 * a dead link or a page that quietly does not exist:
 *
 *   1. every internal href on every page resolves to a page that was built
 *   2. every header nav link resolves, and the nav is present on every page
 *   3. the current page is marked exactly once, on the right link
 *   4. sitemap.xml and the built routes agree in both directions
 *   5. every page has a non-empty title, description and canonical
 *   6. no editorial placeholder leaked into rendered output
 *   7. a section with no data renders its empty state rather than a bare gap
 *
 * (1) and (4) are the ones that earn their keep: adding a page and forgetting
 * the sitemap, or linking a page that was never created, both ship silently.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

const DIST = 'dist';

/** Pages that must exist and be reachable from the header. */
const NAV = ['/about', '/experience', '/projects', '/certifications', '/tools'];

/**
 * Words that mean "I have not written this yet". If one of these reaches
 * rendered HTML, placeholder copy is live on the site.
 *
 * Deliberately narrow: matching the bare words "todo" or "your" would fire on
 * ordinary prose ("your browser", "your device"), so each pattern is anchored
 * to a shape that only appears in scaffolding.
 */
const PLACEHOLDERS = [
  /\bTODO\b/,
  /\bFIXME\b/,
  /\bLorem ipsum\b/i,
  /\bplaceholder text\b/i,
  /\bJob Title Here\b/i,
  /\bCompany Name\b/i,
  /\bAdd your\b/i,
  /\bReplace this\b/i,
  /\bXXX+\b/,
];

let fail = 0;
let checks = 0;

function problem(message) {
  console.log(`  FAIL ${message}`);
  fail++;
}

function check(ok, message) {
  checks++;
  if (!ok) problem(message);
  return ok;
}

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

/** '/about/index.html' -> '/about'; 'index.html' -> '/' */
const routeOf = (file) => {
  const rel = relative(DIST, file).split(sep).join('/');
  // 404.html sits at the dist root rather than in a directory, so both the
  // '<dir>/index.html' and the bare '<name>.html' shape have to collapse.
  const trimmed = rel
    .replace(/index\.html$/, '')
    .replace(/\.html$/, '')
    .replace(/\/$/, '');
  return trimmed === '' ? '/' : `/${trimmed}`;
};

/** Trailing slashes are cosmetic here — compare routes in one canonical form. */
const norm = (href) => {
  const path = href.split('#')[0].split('?')[0];
  const stripped = path.replace(/\/+$/, '');
  return stripped === '' ? '/' : stripped;
};

const files = await walk(DIST);
const htmlFiles = files.filter((f) => f.endsWith('.html'));
const routes = new Set(htmlFiles.map(routeOf));

/** Non-page assets an href may legitimately point at. */
const assets = new Set(
  files.filter((f) => !f.endsWith('.html')).map((f) => '/' + relative(DIST, f).split(sep).join('/')),
);

console.log(`${htmlFiles.length} pages built\n`);

// 404.html is a GitHub Pages convention, reachable by no link.
const linkable = [...routes].filter((r) => r !== '/404');

// ---------------------------------------------------------------- per page
for (const file of htmlFiles.sort()) {
  const route = routeOf(file);
  const html = await readFile(file, 'utf8');
  const issuesBefore = fail;

  // --- head contract
  const title = html.match(/<title>([^<]*)<\/title>/)?.[1] ?? '';
  const desc = html.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? '';
  const canonical = html.match(/<link rel="canonical" href="([^"]*)"/)?.[1] ?? '';
  check(title.trim().length > 0, `${route} has an empty <title>`);
  check(desc.trim().length > 0, `${route} has an empty meta description`);
  check(
    canonical.startsWith('https://'),
    `${route} canonical is missing or not absolute (got "${canonical}")`,
  );

  // --- placeholder copy. Strip <script>, <style> and attributes first: only
  // text a visitor can actually read counts.
  const visible = html
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ');
  for (const pattern of PLACEHOLDERS) {
    check(
      !pattern.test(visible),
      `${route} shows placeholder copy matching ${pattern} — ` +
        `"${visible.match(pattern)?.[0]}" is live on the page`,
    );
  }

  // --- nav present and complete
  const nav = html.match(/<nav class="hdr__nav"[\s\S]*?<\/nav>/)?.[0];
  if (check(nav !== undefined, `${route} is missing the header nav`)) {
    for (const target of NAV) {
      check(
        nav.includes(`href="${target}"`),
        `${route} header nav has no link to ${target}`,
      );
    }

    // --- current page marked exactly once, on the right link
    const marked = [...nav.matchAll(/href="([^"]+)"[^>]*aria-current="page"/g)].map((m) => m[1]);
    const expected = NAV.find((n) => route === n || route.startsWith(`${n}/`));
    if (expected) {
      check(
        marked.length === 1 && marked[0] === expected,
        `${route} should mark ${expected} as the current nav item, marked ${JSON.stringify(marked)}`,
      );
    } else {
      check(
        marked.length === 0,
        `${route} is not a nav section but marks ${JSON.stringify(marked)} as current`,
      );
    }
  }

  // --- every internal link resolves
  const hrefs = [...html.matchAll(/href="(\/[^"]*)"/g)].map((m) => m[1]);
  for (const href of new Set(hrefs)) {
    const target = norm(href);
    check(
      routes.has(target) || assets.has(href),
      `${route} links to ${href}, which was not built`,
    );
  }

  if (fail === issuesBefore) {
    console.log(
      `ok   ${route.padEnd(28)} ${new Set(hrefs).size} internal link(s) · title "${title.slice(0, 34)}"`,
    );
  }
}

// ---------------------------------------------------------------- sitemap
const sitemapFailures = fail;
const sitemap = await readFile(join(DIST, 'sitemap.xml'), 'utf8');
const listed = new Set([...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => norm(new URL(m[1]).pathname)));

for (const route of linkable) {
  check(listed.has(route), `sitemap.xml does not list ${route}, which was built`);
}
for (const route of listed) {
  check(routes.has(route), `sitemap.xml lists ${route}, which was not built`);
}
if (fail === sitemapFailures) {
  console.log(`\nok   sitemap.xml${' '.repeat(21)} ${listed.size} url(s), agrees with the build`);
}

// ---------------------------------------------------------------- empty states
// Experience and certifications ship without data. Each must render its
// honest empty state — an empty <ol> would just be an unexplained gap.
const { experience, certifications } = await import('../src/data/profile.ts');
for (const [route, data] of [
  ['/experience', experience],
  ['/certifications', certifications],
]) {
  const html = await readFile(join(DIST, route.slice(1), 'index.html'), 'utf8');
  const hasEmptyState = /class="[^"]*\bempty\b/.test(html);
  const hasRows = /class="tl"/.test(html);
  if (data.length === 0) {
    check(hasEmptyState, `${route} has no entries but renders no empty state`);
    check(!hasRows, `${route} has no entries but still renders a list container`);
  } else {
    check(hasRows, `${route} has ${data.length} entries but renders no list`);
    check(!hasEmptyState, `${route} has entries but still shows the empty state`);
  }
}
console.log(`ok   empty states${' '.repeat(20)} match the data in profile.ts`);

console.log(`\n${checks} assertions, ${fail} failed`);
process.exit(fail ? 1 : 0);
