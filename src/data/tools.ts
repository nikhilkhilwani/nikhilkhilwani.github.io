export type ToolCategory = 'color' | 'image' | 'pdf';
export type ToolStatus = 'available' | 'coming-soon';

export interface ToolMeta {
  slug: string;
  title: string;
  /** Shown on the index card and used as the page's meta description. */
  description: string;
  /** Key into the ICONS map in src/components/Icon.astro. */
  icon: string;
  status: ToolStatus;
  category: ToolCategory;
}

export const TOOL_CATEGORIES: { id: ToolCategory; label: string; blurb: string }[] = [
  { id: 'color', label: 'Color & Design', blurb: 'Convert, check, and collect color.' },
  { id: 'image', label: 'Image & QR', blurb: 'Reshape images without uploading them.' },
  { id: 'pdf', label: 'PDF', blurb: 'Convert, compress, and secure documents in-tab.' },
];

/**
 * Single source of truth for the /tools index, the tool switcher, and the
 * sitemap. Adding a tool = one entry here + one page in src/pages/tools/.
 * A 'coming-soon' entry renders a non-clickable preview card, so the roadmap
 * is visible without a dead link.
 */
export const tools: ToolMeta[] = [
  {
    slug: 'color-converter',
    title: 'Color Converter',
    description:
      'Convert a color between HEX, RGB, HSL, HSV, CMYK, OKLCH, and CSS named colors, live as you type.',
    icon: 'palette',
    status: 'available',
    category: 'color',
  },
  {
    slug: 'contrast-checker',
    title: 'Contrast Checker',
    description:
      'Check any pair of colors against WCAG 2.1 AA and AAA, preview real text, and auto-fix a failing pair.',
    icon: 'contrast',
    status: 'available',
    category: 'color',
  },
  {
    slug: 'palette-collection',
    title: 'Palette Collection',
    description:
      'Browse curated five-color palettes, filter by mood and hue, and copy any of them as CSS variables.',
    icon: 'swatch',
    status: 'available',
    category: 'color',
  },
  {
    slug: 'qr-generator',
    title: 'QR Code Generator',
    description: 'Generate QR codes for links, text, WiFi, and contact cards, and export as SVG or PNG.',
    icon: 'qr',
    status: 'available',
    category: 'image',
  },
  {
    slug: 'image-converter',
    title: 'Image Converter',
    description: 'Convert images between PNG, JPEG, and WebP with a quality dial. Nothing is uploaded.',
    icon: 'image',
    status: 'available',
    category: 'image',
  },
  {
    slug: 'image-to-pdf',
    title: 'Image to PDF',
    description: 'Combine and reorder images into a single PDF, entirely in your browser.',
    icon: 'file-out',
    status: 'available',
    category: 'pdf',
  },
  {
    slug: 'pdf-to-jpg',
    title: 'PDF to JPG',
    description: 'Render every page of a PDF to a JPG and download the set as a ZIP.',
    icon: 'file-image',
    status: 'available',
    category: 'pdf',
  },
  {
    slug: 'compress-pdf',
    title: 'Compress PDF',
    description: 'Shrink a PDF by recompressing its embedded images, leaving text and vectors sharp.',
    icon: 'minimize',
    status: 'coming-soon',
    category: 'pdf',
  },
  {
    slug: 'protect-pdf',
    title: 'Protect PDF',
    description: 'Add AES-256 password protection to a PDF without it ever leaving your device.',
    icon: 'lock',
    status: 'available',
    category: 'pdf',
  },
  {
    slug: 'unlock-pdf',
    title: 'Unlock PDF',
    description: 'Remove password protection from a PDF you already know the password for.',
    icon: 'unlock',
    status: 'coming-soon',
    category: 'pdf',
  },
];

export const availableTools = tools.filter((t) => t.status === 'available');

export const toolPath = (slug: string) => `/tools/${slug}`;

export const getTool = (slug: string) => tools.find((t) => t.slug === slug);

export const toolsByCategory = (id: ToolCategory) => tools.filter((t) => t.category === id);
