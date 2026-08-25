import type { APIRoute } from 'astro';
import { availableTools, toolPath } from '../data/tools';

// Hand-rolled rather than pulling in @astrojs/sitemap: the route list is already
// in one place, and coming-soon tools must stay out of it.
export const GET: APIRoute = ({ site }) => {
  const base = (site ?? new URL('https://nikhilkhilwani.github.io')).origin;
  const paths = ['/', '/tools', ...availableTools.map((t) => toolPath(t.slug))];
  const today = new Date().toISOString().slice(0, 10);

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${paths
  .map(
    (p) => `  <url>
    <loc>${base}${p}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>${p === '/' ? '1.0' : p === '/tools' ? '0.9' : '0.8'}</priority>
  </url>`,
  )
  .join('\n')}
</urlset>
`;

  return new Response(body, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
};
