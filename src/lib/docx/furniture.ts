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

import type { Block, Cell, Run } from './blocks.ts';
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
  /** Distinct even-page parts, used only when settings.xml enables them. */
  headerEven?: string;
  footerEven?: string;
  /** True when word/settings.xml declares w:evenAndOddHeaders. */
  evenAndOdd: boolean;
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
export function readFurnitureRefs(
  documentXml: string,
  relsXml: string,
  settingsXml?: string,
): FurnitureRefs {
  const rels = readRelationships(relsXml);
  const sect = /<w:sectPr\b[^>]*>[\s\S]*?<\/w:sectPr>/.exec(documentXml)?.[0] ?? '';

  const refs: FurnitureRefs = {
    titlePg: /<w:titlePg\b(?![^>]*w:val\s*=\s*"(?:0|false)")/.test(sect),
    // Even-page parts are inert unless the document setting turns them on.
    // Honouring the reference without checking would put the even header on
    // every other page of a document that never asked for one.
    evenAndOdd: settingsXml
      ? /<w:evenAndOddHeaders\b(?![^>]*w:val\s*=\s*"(?:0|false)")/.test(settingsXml)
      : false,
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
      else if (type === 'even') refs.headerEven = part;
      else if (type === 'default') refs.header = part;
    } else {
      if (type === 'first') refs.footerFirst = part;
      else if (type === 'even') refs.footerEven = part;
      else if (type === 'default') refs.footer = part;
    }
  }

  // Recorded but unusable without the setting, so drop them here rather than
  // leaving a trap for the caller.
  if (!refs.evenAndOdd) {
    refs.headerEven = undefined;
    refs.footerEven = undefined;
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
/**
 * Resolves a drawing's relationship id to a data URI, or undefined if the part
 * is missing or in a format that cannot be embedded.
 */
export type ImageResolver = (relationshipId: string) => string | undefined;

export function parseFurniture(
  xml: string,
  page: number,
  total: number,
  images?: ImageResolver,
): FurnitureBlock[] {
  return parseParagraphBlocks(substituteFields(xml, page, total), images);
}

/**
 * Paragraphs, runs, alignment and tab stops out of any Word XML fragment.
 *
 * Shared by headers, footers and text boxes: all three are content mammoth
 * never sees, and all three are paragraph-shaped.
 */
export function parseParagraphBlocks(
  resolved: string,
  images?: ImageResolver,
): FurnitureBlock[] {
  const out: FurnitureBlock[] = [];

  // Tables are pulled out first and their paragraphs removed, so the paragraph
  // sweep below cannot also emit the cell text as loose lines. A header table
  // is how letterheads put a logo beside an address.
  let flow = resolved;
  const tables: { at: number; block: Block }[] = [];
  for (const tbl of resolved.match(/<w:tbl>[\s\S]*?<\/w:tbl>/g) ?? []) {
    const rows: Cell[][] = [];
    for (const tr of tbl.match(/<w:tr\b[^>]*>[\s\S]*?<\/w:tr>/g) ?? []) {
      const cells: Cell[] = [];
      for (const tc of tr.match(/<w:tc\b[^>]*>[\s\S]*?<\/w:tc>/g) ?? []) {
        const tcPr = /<w:tcPr\b[^>]*>([\s\S]*?)<\/w:tcPr>/.exec(tc)?.[1] ?? '';
        const vMerge = /<w:vMerge\b([^>]*)\/?>/.exec(tcPr);
        if (vMerge && !/w:val\s*=\s*"restart"/.test(vMerge[1])) continue;
        const span = Number(/<w:gridSpan\b[^>]*w:val\s*=\s*"(\d+)"/.exec(tcPr)?.[1] ?? '1');
        const runs: Run[] = [];
        for (const paragraph of tc.match(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g) ?? []) {
          runs.push(...readRuns(paragraph));
        }
        cells.push({ runs, span: Number.isFinite(span) && span >= 1 ? span : 1 });
      }
      if (cells.length) rows.push(cells);
    }
    if (rows.length) tables.push({ at: resolved.indexOf(tbl), block: { kind: 'table', rows } });
    flow = flow.replace(tbl, '');
  }

  for (const paragraph of flow.match(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g) ?? []) {
    // An inline logo, resolved through the part's own relationships.
    if (images) {
      for (const embed of paragraph.match(/<a:blip\b[^>]*r:embed\s*=\s*"([^"]*)"/g) ?? []) {
        const id = /r:embed\s*=\s*"([^"]*)"/.exec(embed)?.[1];
        const dataUri = id ? images(id) : undefined;
        if (!dataUri) continue;
        const extent = /<wp:extent\s+cx="(\d+)"\s+cy="(\d+)"/.exec(paragraph);
        const EMU_PER_PT = 914400 / 72;
        out.push({
          block: {
            kind: 'image',
            dataUri,
            ...(extent
              ? {
                  width: Number(extent[1]) / EMU_PER_PT,
                  height: Number(extent[2]) / EMU_PER_PT,
                }
              : {}),
          },
          align: 'left',
          tabs: [],
        });
      }
    }

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

  // Tables first: in a letterhead the table IS the header, and anything loose
  // sits under it.
  return [
    ...tables.map((entry) => ({ block: entry.block, align: 'left' as Align, tabs: [] })),
    ...out,
  ];
}

/** One text box's content and the text of the paragraph it is anchored in. */
export interface TextBox {
  blocks: FurnitureBlock[];
  /**
   * Plain text of the nearest preceding paragraph that had any, used to place
   * the content back near where it came from.
   */
  afterText: string;
}

/**
 * Text boxes, in document order.
 *
 * These are <w:txbxContent> inside an mc:AlternateContent drawing, and mammoth
 * emits nothing at all for them — so a template built out of text boxes
 * currently converts to a nearly empty PDF. Reproducing their absolute position
 * would need a floating-layout concept the engine does not have, so the content
 * is put into the flow instead: the wrong position, but present and readable,
 * which beats losing it.
 */
export function readTextBoxes(documentXml: string): TextBox[] {
  // The Fallback branch repeats the same content in VML, so drop it first or
  // every text box would be found twice.
  const primary = documentXml.replace(/<mc:Fallback>[\s\S]*?<\/mc:Fallback>/g, '');
  const out: TextBox[] = [];

  const boxPattern = /<w:txbxContent\b[^>]*>([\s\S]*?)<\/w:txbxContent>/g;
  let match: RegExpExecArray | null;
  while ((match = boxPattern.exec(primary)) !== null) {
    const blocks = parseParagraphBlocks(match[1]);
    if (!blocks.length) continue;

    // Everything before this box, with the box's own content removed so its
    // text cannot be mistaken for the surrounding paragraph's.
    const before = primary.slice(0, match.index).replace(/<w:txbxContent\b[^>]*>[\s\S]*?<\/w:txbxContent>/g, '');
    let afterText = '';
    for (const paragraph of before.match(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g) ?? []) {
      const text = (paragraph.match(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g) ?? [])
        .map((token) => /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/.exec(token)?.[1] ?? '')
        .join('')
        .trim();
      if (text) afterText = text;
    }

    out.push({ blocks, afterText });
  }

  return out;
}
