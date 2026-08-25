import { defineConfig } from 'astro/config';

// User site, served from the domain root — no `base` path needed.
export default defineConfig({
  site: 'https://nikhilkhilwani.github.io',
  // Emits tools/color-converter/index.html, so /tools/color-converter is a real
  // URL GitHub Pages can serve directly. No 404.html router hack required.
  build: { format: 'directory' },
  vite: {
    // Explicitly off: shipping sourcemaps publishes your original source next to
    // the bundle. Astro already defaults to false; this is here so nobody turns
    // it on without reading this comment.
    build: { sourcemap: false },
  },
});
