/**
 * Writing a .docx.
 *
 * A .docx is a ZIP of XML parts. Reading one is hard because Word emits every
 * legal variation; writing one is comparatively easy because we choose exactly
 * one. This module produces the smallest package Word, LibreOffice and Google
 * Docs all accept, and nothing more.
 *
 * Three unit systems, and mixing them up is the classic way to produce a file
 * that opens but looks wrong:
 *
 *   - font sizes are in HALF-points, so 11pt is `w:sz w:val="22"`
 *   - indents and spacing are in TWIPS, one twentieth of a point
 *   - image extents are in EMU, 12700 to the point
 *
 * Everything here is pure: blocks in, named byte parts out, ready for fflate.
 */

import type { Block, Span } from '../pdf/textitems.ts';

export interface ImageBlock {
  kind: 'image';
  image: { data: Uint8Array; mime: string; width: number; height: number };
}

export interface PageBreakBlock {
  kind: 'pagebreak';
}

export type DocBlock = Block | ImageBlock | PageBreakBlock;

export interface DocxOptions {
  /** Page size in points. Defaults to A4 portrait. */
  pageWidth?: number;
  pageHeight?: number;
  /** Page margin in points. */
  margin?: number;
  /** Base font family for the whole document. */
  font?: string;
  /** Body size in points, used for the Normal style. */
  bodySize?: number;
}

const TWIPS_PER_POINT = 20;
const EMU_PER_POINT = 12700;

const twips = (points: number) => Math.round(points * TWIPS_PER_POINT);
const halfPoints = (points: number) => Math.max(2, Math.round(points * 2));
const emu = (points: number) => Math.round(points * EMU_PER_POINT);

/**
 * XML text escaping.
 *
 * The five predefined entities, plus something easy to miss: XML 1.0 forbids
 * most control characters outright, and a PDF can legitimately hand us one.
 * Word rejects the whole file if a single one survives, so they are dropped
 * rather than escaped — an escaped control character is still illegal.
 */
const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

export function escapeXml(text: string): string {
  let out = '';
  for (const character of text) {
    const code = character.codePointAt(0);
    if (code === undefined) continue;
    // XML 1.0 permits tab, newline and return, then U+0020 upward. Every other
    // control character is illegal even when escaped, so it is dropped rather
    // than encoded — one survivor makes Word reject the whole document.
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) continue;
    if (code === 0xfffe || code === 0xffff) continue;
    out += ENTITIES[character] ?? character;
  }
  return out;
}

/** One run of text with its formatting. */
export function runXml(span: Span, _font?: string): string {
  // The schema fixes the order of these: rFonts, then b, then i, then sz.
  // Word tolerates a wrong order, LibreOffice mostly does, and a strict
  // validator rejects the file outright -- so it is worth getting right.
  const properties: string[] = [];
  // The PDF's own family, when it could be recovered. Falling back to the
  // document default is what made every conversion arrive in one typeface.
  const family = span.family || (span.mono ? 'Courier New' : '');
  if (family) {
    const safe = escapeXml(family);
    properties.push(`<w:rFonts w:ascii="${safe}" w:hAnsi="${safe}" w:cs="${safe}"/>`);
  }
  if (span.bold) properties.push('<w:b/>');
  if (span.italic) properties.push('<w:i/>');
  properties.push(`<w:sz w:val="${halfPoints(span.size)}"/>`);
  properties.push(`<w:szCs w:val="${halfPoints(span.size)}"/>`);

  // xml:space="preserve" is mandatory: without it Word collapses the leading
  // and trailing spaces that hold words apart across run boundaries.
  return (
    '<w:r>' +
    `<w:rPr>${properties.join('')}</w:rPr>` +
    `<w:t xml:space="preserve">${escapeXml(span.text)}</w:t>` +
    '</w:r>'
  );
}

const HEADING_STYLE = ['Heading1', 'Heading2', 'Heading3'];

function paragraphXml(block: Block, font?: string): string {
  const properties: string[] = [];

  if (block.kind === 'heading') {
    const level = Math.min(3, Math.max(1, block.level ?? 3));
    properties.push(`<w:pStyle w:val="${HEADING_STYLE[level - 1]}"/>`);
  }

  if (block.kind === 'list') {
    // numId 1 is the bullet definition, 2 the decimal one; see numberingXml.
    const numId = block.marker === 'number' ? 2 : 1;
    const depth = Math.min(2, Math.max(0, block.depth ?? 0));
    properties.push(`<w:numPr><w:ilvl w:val="${depth}"/><w:numId w:val="${numId}"/></w:numPr>`);
  } else if (block.indent && block.indent > 2) {
    properties.push(`<w:ind w:left="${twips(block.indent)}"/>`);
  }

  const runs = (block.spans ?? []).map((span) => runXml(span, font)).join('');
  const pPr = properties.length ? `<w:pPr>${properties.join('')}</w:pPr>` : '';
  return `<w:p>${pPr}${runs}</w:p>`;
}

/**
 * A table.
 *
 * `tblLayout fixed` with explicit `gridCol` widths is what stops Word from
 * re-flowing the columns to fit its own idea of the content, which would undo
 * the column positions recovered from the PDF.
 */
function tableXml(block: Block, options: Required<DocxOptions>): string {
  const rows = block.rows ?? [];
  if (!rows.length) return '';
  const columns = Math.max(...rows.map((row) => row.length));
  if (!columns) return '';

  const usable = options.pageWidth - options.margin * 2;
  const width = Math.floor(twips(usable) / columns);

  const grid = Array.from({ length: columns }, () => `<w:gridCol w:w="${width}"/>`).join('');

  const borders =
    '<w:tblBorders>' +
    ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map((side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>`)
      .join('') +
    '</w:tblBorders>';

  const body = rows
    .map((row) => {
      const cells = Array.from({ length: columns }, (_, index) => {
        const spans = row[index] ?? [];
        const runs = spans.length
          ? spans.map((span) => runXml(span, options.font)).join('')
          : '';
        // Every cell needs at least one paragraph or Word calls the file corrupt.
        return (
          '<w:tc>' +
          `<w:tcPr><w:tcW w:w="${width}" w:type="dxa"/></w:tcPr>` +
          `<w:p>${runs}</w:p>` +
          '</w:tc>'
        );
      }).join('');
      return `<w:tr>${cells}</w:tr>`;
    })
    .join('');

  return (
    '<w:tbl>' +
    '<w:tblPr>' +
    '<w:tblW w:w="0" w:type="auto"/>' +
    '<w:tblLayout w:type="fixed"/>' +
    borders +
    '</w:tblPr>' +
    `<w:tblGrid>${grid}</w:tblGrid>` +
    body +
    '</w:tbl>' +
    // A table may not be the last element in a body, and two adjacent tables
    // merge into one. An empty paragraph after each keeps both cases legal.
    '<w:p/>'
  );
}

function imageXml(block: ImageBlock, id: number, relationship: string): string {
  const width = emu(block.image.width);
  const height = emu(block.image.height);
  return (
    '<w:p><w:r><w:drawing>' +
    `<wp:inline distT="0" distB="0" distL="0" distR="0">` +
    `<wp:extent cx="${width}" cy="${height}"/>` +
    '<wp:effectExtent l="0" t="0" r="0" b="0"/>' +
    `<wp:docPr id="${id}" name="Picture ${id}"/>` +
    '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
    '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    `<pic:nvPicPr><pic:cNvPr id="${id}" name="Picture ${id}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${relationship}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    '<pic:spPr><a:xfrm><a:off x="0" y="0"/>' +
    `<a:ext cx="${width}" cy="${height}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>' +
    '</pic:pic></a:graphicData></a:graphic></wp:inline>' +
    '</w:drawing></w:r></w:p>'
  );
}

const DEFAULTS: Required<DocxOptions> = {
  pageWidth: 595.28,
  pageHeight: 841.89,
  margin: 56.7,
  font: 'Calibri',
  bodySize: 11,
};

export interface DocxParts {
  /** Path inside the package to its bytes, ready for fflate's zipSync. */
  files: Record<string, Uint8Array>;
}

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

/**
 * Builds every part of the package.
 *
 * The relationship ids are assigned here rather than by the caller so that
 * document.xml and document.xml.rels cannot disagree — a mismatch there is a
 * file that Word opens with a red X where the picture should be.
 */
export function buildDocx(blocks: DocBlock[], options: DocxOptions = {}): DocxParts {
  const settings: Required<DocxOptions> = { ...DEFAULTS, ...options };

  const media: { path: string; data: Uint8Array; extension: string }[] = [];
  const body: string[] = [];
  let imageId = 1;

  for (const block of blocks) {
    if (block.kind === 'pagebreak') {
      body.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
      continue;
    }
    if (block.kind === 'image') {
      const extension = block.image.mime === 'image/jpeg' ? 'jpg' : 'png';
      const path = `word/media/image${imageId}.${extension}`;
      media.push({ path, data: block.image.data, extension });
      // rId1 and rId2 are taken by styles and numbering.
      body.push(imageXml(block, imageId, `rId${imageId + 2}`));
      imageId++;
      continue;
    }
    if (block.kind === 'table') {
      body.push(tableXml(block, settings));
      continue;
    }
    body.push(paragraphXml(block, settings.font));
  }

  // A body must end with sectPr or Word treats the page setup as unspecified.
  const sectPr =
    '<w:sectPr>' +
    `<w:pgSz w:w="${twips(settings.pageWidth)}" w:h="${twips(settings.pageHeight)}"/>` +
    `<w:pgMar w:top="${twips(settings.margin)}" w:right="${twips(settings.margin)}" ` +
    `w:bottom="${twips(settings.margin)}" w:left="${twips(settings.margin)}" ` +
    'w:header="0" w:footer="0" w:gutter="0"/>' +
    '</w:sectPr>';

  const documentXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document ' +
    'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">' +
    `<w:body>${body.join('')}${sectPr}</w:body></w:document>`;

  const relationships = [
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>',
    ...media.map(
      (entry, index) =>
        `<Relationship Id="rId${index + 3}" ` +
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" ' +
        `Target="media/${entry.path.split('/').pop()}"/>`,
    ),
  ].join('');

  const extensions = new Set(media.map((entry) => entry.extension));
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    (extensions.has('png') ? '<Default Extension="png" ContentType="image/png"/>' : '') +
    (extensions.has('jpg') ? '<Default Extension="jpg" ContentType="image/jpeg"/>' : '') +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
    '</Types>';

  const rootRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>';

  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': encode(contentTypes),
    '_rels/.rels': encode(rootRels),
    'word/document.xml': encode(documentXml),
    'word/_rels/document.xml.rels': encode(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        relationships +
        '</Relationships>',
    ),
    'word/styles.xml': encode(stylesXml(settings)),
    'word/numbering.xml': encode(numberingXml()),
  };

  for (const entry of media) files[entry.path] = entry.data;

  return { files };
}

function stylesXml(options: Required<DocxOptions>): string {
  const heading = (id: number, size: number, before: number) =>
    `<w:style w:type="paragraph" w:styleId="Heading${id}">` +
    `<w:name w:val="heading ${id}"/><w:basedOn w:val="Normal"/>` +
    '<w:pPr>' +
    `<w:keepNext/><w:spacing w:before="${twips(before)}" w:after="${twips(before / 2)}"/>` +
    '<w:outlineLvl w:val="' + (id - 1) + '"/>' +
    '</w:pPr>' +
    `<w:rPr><w:b/><w:sz w:val="${halfPoints(size)}"/><w:szCs w:val="${halfPoints(size)}"/></w:rPr>` +
    '</w:style>';

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:docDefaults><w:rPrDefault><w:rPr>' +
    `<w:rFonts w:ascii="${escapeXml(options.font)}" w:hAnsi="${escapeXml(options.font)}"/>` +
    `<w:sz w:val="${halfPoints(options.bodySize)}"/><w:szCs w:val="${halfPoints(options.bodySize)}"/>` +
    '</w:rPr></w:rPrDefault>' +
    '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault>' +
    '</w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
    heading(1, options.bodySize * 1.8, 12) +
    heading(2, options.bodySize * 1.45, 10) +
    heading(3, options.bodySize * 1.2, 8) +
    '</w:styles>'
  );
}

/**
 * Two list definitions: bullets and decimals.
 *
 * Word will not render a numbered list from `numPr` alone — it needs an
 * abstract definition with a `numFmt` and a `lvlText`, and a concrete `num`
 * pointing at it. Omit numbering.xml and the list items appear as ordinary
 * paragraphs with no marker at all.
 */
function numberingXml(): string {
  // Word takes the bullet glyph and the numbering format per LEVEL. A
  // definition holding only ilvl 0 leaves every nested item unmarked, so all
  // three levels are declared even though most documents use one.
  const BULLETS = ['\u2022', 'o', '\u25aa'];
  const NUMBERS: [string, string][] = [
    ['decimal', '%1.'],
    ['lowerLetter', '%2.'],
    ['lowerRoman', '%3.'],
  ];

  const level = (ilvl: number, format: string, text: string, symbol?: string) =>
    `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/>` +
    `<w:numFmt w:val="${format}"/><w:lvlText w:val="${escapeXml(text)}"/><w:lvlJc w:val="left"/>` +
    `<w:pPr><w:ind w:left="${720 * (ilvl + 1)}" w:hanging="360"/></w:pPr>` +
    (symbol ? `<w:rPr><w:rFonts w:ascii="${symbol}" w:hAnsi="${symbol}" w:hint="default"/></w:rPr>` : '') +
    '</w:lvl>';

  const bullets = BULLETS.map((glyph, ilvl) =>
    level(ilvl, 'bullet', glyph, ilvl === 1 ? 'Courier New' : 'Symbol'),
  ).join('');
  const numbers = NUMBERS.map(([format, text], ilvl) => level(ilvl, format, text)).join('');

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:abstractNum w:abstractNumId="0">${bullets}</w:abstractNum>` +
    `<w:abstractNum w:abstractNumId="1">${numbers}</w:abstractNum>` +
    '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>' +
    '<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>' +
    '</w:numbering>'
  );
}
