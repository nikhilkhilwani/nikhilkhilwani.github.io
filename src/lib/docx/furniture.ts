/**
 * Headers, footers and page numbers.
 *
 * These live in their own parts — word/header1.xml, word/footer1.xml — reached
 * through a relationship id in <w:sectPr>. mammoth converts only document.xml,
 * so none of it ever reached the pipeline and headers simply vanished.
 *
 * That means owning a small XML-to-Block reader here. It is deliberately a
 * subset: paragraphs, runs, alignment and tab stops, which is what page
 * furniture actually contains. A table or image in a header is not reproduced.
 *
 * Page numbers are substituted BEFORE parsing rather than after. A field's
 * cached value is whatever Word last wrote, so it cannot be trusted, and
 * rewriting the field into ordinary text keeps the run reader simple and means
 * the number is measured and aligned like any other text.
 */

import type { Block, Run } from './blocks.ts';
import type { Align, TabStop } from './wordxml.ts';
import { TWIP } from './wordxml.ts';

const twips = (value: string | undefined): number => (value ? (Number(value) || 0) * TWIP : 0);

const ALIGNMENTS: Record<string, Align> = {
  left: 'left',
  start: 'left',
  center: 'center',
  centre: 'center',
  right: 'right',
  end: 'right',
  both: 'justify',
  justify: 'justify',
};

const attrOf = (xml: string, tag: string, name = 'w:val'): string | undefined => {
  const el = new RegExp('<' + tag + '\\b[^>]*/?>').exec(xml)?.[0];
  if (!el) return undefined;
  return new RegExp(name + '\\s*=\\s*"([^"]*)"').exec(el)?.[1];
};

/** Which parts a section points at, and how far in from the page edge. */
export interface FurnitureRefs {
  /** Part names, e.g. "word/header1.xml". */
  header?: string;
  footer?: string;
  /** Used on page 1 when the section sets w:titlePg. */
  headerFirst?: string;
  footerFirst?: string;
  titlePg: boolean;
  /** Distance from the top edge of the page to the header, in points. */
  headerDistance: number;
  /** Distance from the bottom edge of the page to the footer, in points. */
  footerDistance: number;
}

/** rId -> part name, from word/_rels/document.xml.rels. */
export function readRelationships(relsXml: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rel of relsXml.match(/<Relationship\b[^>]*\/?>/g) ?? []) {
    const id = /Id\s*=\s*"([^"]*)"/.exec(rel)?.[1];
    const target = /Target\s*=\s*"([^"]*)"/.exec(rel)?.[1];
    if (!id || !target) continue;
    // Targets are relative to word/, and may be written with a leading path.
    const clean = target.replace(/^\.\//, '').replace(/^\/word\//, '');
    out.set(id, clean.startsWith('word/') ? clean : `word/${clean}`);
  }
  return out;
}

/** Reads the header/footer references out of the first section. */
export function readFurnitureRefs(documentXml: string, relsXml: string): FurnitureRefs {
  const rels = readRelationships(relsXml);
  const sect = /<w:sectPr\b[^>]*>[\s\S]*?<\/w:sectPr>/.exec(documentXml)?.[0] ?? '';

  const refs: FurnitureRefs = {
    titlePg: /<w:titlePg\b(?![^>]*w:val\s*=\s*"(?:0|false)")/.test(sect),
    headerDistance: 0,
    footerDistance: 0,
  };

  for (const ref of sect.match(/<w:(?:header|footer)Reference\b[^>]*\/?>/g) ?? []) {
    const kind = /<w:(header|footer)Reference/.exec(ref)?.[1];
    const type = /w:type\s*=\s*"([^"]*)"/.exec(ref)?.[1] ?? 'default';
    const id = /r:id\s*=\s*"([^"]*)"/.exec(ref)?.[1];
    const part = id ? rels.get(id) : undefined;
    if (!kind || !part) continue;

    if (kind === 'header') {
      if (type === 'first') refs.headerFirst = part;
      else if (type === 'default') refs.header = part;
    } else {
      if (type === 'first') refs.footerFirst = part;
      else if (type === 'default') refs.footer = part;
    }
    // "even" is ignored: it only applies with the evenAndOddHeaders setting,
    // and using it without that check would put it on every other page.
  }

  const pgMar = /<w:pgMar\b[^>]*\/?>/.exec(sect)?.[0] ?? '';
  refs.headerDistance = twips(/w:header\s*=\s*"([^"]*)"/.exec(pgMar)?.[1]) || 36;
  refs.footerDistance = twips(/w:footer\s*=\s*"([^"]*)"/.exec(pgMar)?.[1]) || 36;

  return refs;
}

/**
 * Rewrites PAGE and NUMPAGES fields into plain runs holding the real numbers.
 *
 * Both spellings appear in the wild: the compact <w:fldSimple>, and the
 * begin/instrText/separate/end run sequence. The cached value between
 * "separate" and "end" is dropped, because it is whatever the number happened
 * to be when the document was last saved.
 */
export function substituteFields(xml: string, page: number, total: number): string {
  const valueFor = (instr: string): string | null => {
    if (/\bNUMPAGES\b/i.test(instr)) return String(total);
    if (/\bPAGE\b/i.test(instr)) return String(page);
    return null;
  };

  let out = xml.replace(
    /<w:fldSimple\b[^>]*w:instr\s*=\s*"([^"]*)"[^>]*>[\s\S]*?<\/w:fldSimple>/g,
    (whole, instr: string) => {
      const value = valueFor(instr);
      return value === null ? whole : `<w:r><w:t>${value}</w:t></w:r>`;
    },
  );

  // A self-closing fldSimple carries no cached value.
  out = out.replace(/<w:fldSimple\b[^>]*w:instr\s*=\s*"([^"]*)"[^>]*\/>/g, (whole, instr: string) => {
    const value = valueFor(instr);
    return value === null ? whole : `<w:r><w:t>${value}</w:t></w:r>`;
  });

  // The run-sequence form. Matched from a "begin" fldChar to the next "end".
  out = out.replace(
    /<w:r\b[^>]*>(?:(?!<\/w:r>)[\s\S])*?<w:fldChar\b[^>]*w:fldCharType\s*=\s*"begin"[\s\S]*?<w:fldChar\b[^>]*w:fldCharType\s*=\s*"end"[^>]*\/?>\s*<\/w:r>/g,
    (whole) => {
      const instr = [...whole.matchAll(/<w:instrText\b[^>]*>([\s\S]*?)<\/w:instrText>/g)]
        .map((m) => m[1])
        .join(' ');
      const value = valueFor(instr);
      return value === null ? whole : `<w:r><w:t>${value}</w:t></w:r>`;
    },
  );

  return out;
}

/** Runs of one paragraph, with the direct formatting furniture actually uses. */
function readRuns(paragraphXml: string): Run[] {
  const body = paragraphXml.replace(/<w:pPr\b[\s\S]*?<\/w:pPr>/g, '');
  const runs: Run[] = [];

  for (const run of body.match(/<w:r\b[^>]*>[\s\S]*?<\/w:r>/g) ?? []) {
    const rPr = /<w:rPr\b[^>]*>([\s\S]*?)<\/w:rPr>/.exec(run)?.[1] ?? '';

    let text = '';
    for (const token of run.match(/<w:t\b[^>]*>[\s\S]*?<\/w:t>|<w:tab\b[^>]*\/?>|<w:br\b[^>]*\/?>/g) ?? []) {
      if (token.startsWith('<w:tab')) text += '\t';
      else if (token.startsWith('<w:br')) text += '\n';
      else {
        const inner = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/.exec(token);
        if (inner) {
          text += inner[1]
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&apos;/g, "'")
            .replace(/&amp;/g, '&');
        }
      }
    }
    if (!text) continue;

    const on = (tag: string) =>
      new RegExp('<' + tag + '\\b(?![^>]*w:val\\s*=\\s*"(?:0|false)")').test(rPr);

    const entry: Run = { text };
    if (on('w:b')) entry.bold = true;
    if (on('w:i')) entry.italic = true;
    if (on('w:u')) entry.underline = true;
    if (on('w:strike')) entry.strike = true;

    const color = attrOf(rPr, 'w:color');
    if (color && /^[0-9a-fA-F]{6}$/.test(color)) entry.color = color.toUpperCase();

    const sz = attrOf(rPr, 'w:sz');
    if (sz) {
      const points = (Number(sz) || 0) / 2;
      if (points >= 4 && points <= 200) entry.size = points;
    }

    const vertAlign = attrOf(rPr, 'w:vertAlign');
    if (vertAlign === 'superscript') entry.script = 'super';
    else if (vertAlign === 'subscript') entry.script = 'sub';

    runs.push(entry);
  }

  return runs;
}

export interface FurnitureBlock {
  block: Block;
  align: Align;
  tabs: TabStop[];
}

/**
 * Parses a header or footer part into paragraph blocks, with the page numbers
 * already substituted.
 *
 * Tab stops matter more here than anywhere else: the standard three-part header
 * is "left<tab>centre<tab>right", and without the stops it collapses into one
 * run of text.
 */
export function parseFurniture(xml: string, page: number, total: number): FurnitureBlock[] {
  const resolved = substituteFields(xml, page, total);
  const out: FurnitureBlock[] = [];

  // Only the top-level body paragraphs. A paragraph inside a table would be
  // parsed here too, which is wrong but harmless: its text still shows.
  for (const paragraph of resolved.match(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g) ?? []) {
    const runs = readRuns(paragraph);
    if (!runs.length) continue;

    const pPr = /<w:pPr\b[^>]*>([\s\S]*?)<\/w:pPr>/.exec(paragraph)?.[1] ?? '';
    const jc = attrOf(pPr, 'w:jc');
    const align: Align = (jc && ALIGNMENTS[jc]) || 'left';

    const tabs: TabStop[] = [];
    for (const tab of pPr.match(/<w:tab\b[^>]*\/?>/g) ?? []) {
      const pos = /w:pos\s*=\s*"([^"]*)"/.exec(tab)?.[1];
      const val = /w:val\s*=\s*"([^"]*)"/.exec(tab)?.[1] ?? 'left';
      if (pos === undefined || val === 'clear') continue;
      const kind = val === 'right' || val === 'center' || val === 'decimal' ? val : 'left';
      tabs.push({ pos: twips(pos), align: kind });
    }
    tabs.sort((a, b) => a.pos - b.pos);

    out.push({ block: { kind: 'paragraph', runs }, align, tabs });
  }

  return out;
}
