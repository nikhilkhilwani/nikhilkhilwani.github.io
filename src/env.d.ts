/// <reference types="astro/client" />

/**
 * Astro's client types cover asset imports but not Vite's `?url` suffix, which
 * pdf-to-jpg needs to hand pdf.js a real URL for its worker bundle.
 */
declare module '*?url' {
  const src: string;
  export default src;
}
