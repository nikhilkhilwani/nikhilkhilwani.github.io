/**
 * Every word of portfolio copy lives here, so the pages are pure presentation
 * and there is exactly one file to edit when something changes.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TO FILL IN — the four spots marked `TODO` below are empty on purpose.
 *
 * Nothing here was invented. Roles, dates, employers and certifications are
 * claims about a real person that only you can make, so `experience` and
 * `certifications` ship as empty arrays and their pages render an honest
 * "being written" state rather than placeholder text that could go live by
 * accident. Fill the arrays in and the pages populate themselves.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export interface SocialLink {
  label: string;
  href: string;
  /** Shown when the link is the primary contact route. */
  handle?: string;
}

export interface ExperienceEntry {
  company: string;
  position: string;
  /** Free text so "2023 — Present" and "Jun 2021 — Aug 2022" both work. */
  duration: string;
  location?: string;
  summary?: string;
  /** One line per thing you actually did. Keep them concrete. */
  highlights?: string[];
  stack?: string[];
}

export interface ProjectEntry {
  name: string;
  blurb: string;
  /** Live URL, internal or external. */
  href?: string;
  repo?: string;
  stack: string[];
  year?: string;
  /** Pulled out as the lead project on the projects page. */
  featured?: boolean;
}

export interface CertificationEntry {
  name: string;
  issuer: string;
  /** e.g. "Mar 2024". Omit if you would rather not date it. */
  issued?: string;
  /** Verification link, if the issuer gives you one. */
  credentialUrl?: string;
}

export interface SkillGroup {
  label: string;
  items: string[];
}

export const profile = {
  name: 'Nikhil Khilwani',
  /** One line, shown under your name on the home page. */
  headline: 'I build small, fast, private tools for the web.',
  /** TODO: add your city if you want it shown. Empty string hides it. */
  location: '',
  email: 'khilwaninikhil22@gmail.com',
};

export const socials: SocialLink[] = [
  { label: 'Email', href: `mailto:${profile.email}`, handle: profile.email },
  { label: 'GitHub', href: 'https://github.com/nikhilkhilwani', handle: '@nikhilkhilwani' },
  { label: 'LinkedIn', href: 'https://www.linkedin.com/in/nikhilkhilwani', handle: 'in/nikhilkhilwani' },
];

/**
 * About page body. These paragraphs describe work that exists in this
 * repository, so they are true as written.
 *
 * TODO: add a paragraph about your background — where you studied, what you do
 * now, what you want to do next. That part is yours to write.
 */
export const about: string[] = [
  'I like software that does one thing, does it immediately, and does not ask for anything in return. Most of what I build starts as a small annoyance in my own day and ends as a page that fixes it.',
  'The tools on this site are the clearest example. Every one of them runs entirely inside your browser — files are read, converted and handed back without a single byte leaving your device. There is no server to trust, no account to make, and nothing to delete afterwards, because nothing was ever collected.',
  'That constraint is the interesting part. Encrypting a PDF, re-compressing the images inside it, or laying out a Word document as real selectable text are all things normally handed to a backend. Doing them client-side means working with the actual file formats, and getting the edge cases right rather than hoping the happy path holds.',
];

/**
 * Technologies genuinely used in this repository — safe to show as-is.
 * TODO: extend with the rest of what you work in.
 */
export const skills: SkillGroup[] = [
  { label: 'Languages', items: ['TypeScript', 'JavaScript', 'HTML', 'CSS'] },
  { label: 'Web', items: ['Astro', 'Web Workers', 'Canvas', 'File & Blob APIs', 'Responsive CSS'] },
  { label: 'Document formats', items: ['PDF (pdf-lib, pdf.js)', 'OOXML / .docx', 'Image codecs', 'ZIP (fflate)'] },
  { label: 'Practice', items: ['Accessibility', 'Automated testing', 'GitHub Actions', 'Static hosting'] },
];

/** TODO: add your roles, newest first. See ExperienceEntry above for the shape. */
export const experience: ExperienceEntry[] = [];

/** TODO: add your certifications, newest first. */
export const certifications: CertificationEntry[] = [];

export const projects: ProjectEntry[] = [
  {
    name: 'Browser-only file toolbox',
    blurb:
      'Eight tools that convert, compress, encrypt and unlock PDFs and images without uploading anything. All the work happens in the tab: PDFs are parsed and rewritten with pdf-lib and rendered with pdf.js, images are re-encoded through canvas, and .docx files are laid out as real, selectable PDF text rather than screenshots of pages.',
    href: '/tools',
    stack: ['TypeScript', 'Astro', 'pdf-lib', 'pdf.js', 'mammoth', 'Canvas'],
    featured: true,
  },
  {
    name: 'This site',
    blurb:
      'A static portfolio built with Astro and deployed straight to GitHub Pages by Actions. No client framework, no tracking, and no runtime beyond the few kilobytes each tool needs. The layout logic that the tools depend on is covered by unit, integration and rendered-page test suites that run before anything ships.',
    repo: 'https://github.com/nikhilkhilwani/nikhilkhilwani.github.io',
    stack: ['Astro', 'TypeScript', 'GitHub Actions'],
  },
];

/** Empty sections are hidden rather than shown as gaps. */
export const hasExperience = experience.length > 0;
export const hasCertifications = certifications.length > 0;
