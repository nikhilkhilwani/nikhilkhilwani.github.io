/**
 * Fixture builders for the EXIF tool.
 *
 * The TIFF writer here is deliberately an INDEPENDENT implementation from the
 * reader under test: it lays out IFDs and a value heap from a declarative
 * description. If the reader and this writer agree, two separately-written
 * understandings of the format agree, which is worth much more than a
 * round-trip through shared code.
 */

import { zlibSync } from 'fflate';

/* -------------------------------------------------------------------------- */
/* TIFF / Exif writer                                                         */
/* -------------------------------------------------------------------------- */

export const TYPE = { BYTE: 1, ASCII: 2, SHORT: 3, LONG: 4, RATIONAL: 5, UNDEFINED: 7 };
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1 };

const countOf = (type, values) => {
  if (type === TYPE.ASCII) return values.length + 1; // trailing NUL
  if (type === TYPE.RATIONAL) return values.length / 2;
  if (type === TYPE.UNDEFINED || type === TYPE.BYTE) return values.length;
  return values.length;
};

function valueBytes(type, values, bigEndian) {
  if (type === TYPE.ASCII) {
    const out = new Uint8Array(values.length + 1);
    for (let i = 0; i < values.length; i++) out[i] = values.charCodeAt(i) & 0xff;
    return out;
  }
  if (type === TYPE.UNDEFINED || type === TYPE.BYTE) {
    return values instanceof Uint8Array ? values : new Uint8Array(values);
  }
  const unit = TYPE_SIZE[type];
  const count = countOf(type, values);
  const out = new Uint8Array(unit * count);
  const view = new DataView(out.buffer);
  if (type === TYPE.SHORT) {
    values.forEach((v, i) => view.setUint16(i * 2, v, !bigEndian));
  } else if (type === TYPE.LONG) {
    values.forEach((v, i) => view.setUint32(i * 4, v, !bigEndian));
  } else if (type === TYPE.RATIONAL) {
    for (let i = 0; i < count; i++) {
      view.setUint32(i * 8, values[i * 2], !bigEndian);
      view.setUint32(i * 8 + 4, values[i * 2 + 1], !bigEndian);
    }
  }
  return out;
}

/**
 * Builds a complete Exif/TIFF block.
 *
 * `spec` = { bigEndian, ifd0: [...], exif: [...], gps: [...], ifd1: [...],
 *            thumbnail: Uint8Array }
 * Each entry is { tag, type, values }. Pointer entries are added automatically.
 */
export function buildTiff(spec) {
  const bigEndian = spec.bigEndian !== false;
  const ifd0 = [...(spec.ifd0 ?? [])];
  const exif = [...(spec.exif ?? [])];
  const gps = [...(spec.gps ?? [])];
  const ifd1 = [...(spec.ifd1 ?? [])];
  const thumbnail = spec.thumbnail ?? null;

  // Pointers are entries too, so they must exist before sizes are computed.
  if (exif.length) ifd0.push({ tag: 0x8769, type: TYPE.LONG, values: [0], pointer: 'exif' });
  if (gps.length) ifd0.push({ tag: 0x8825, type: TYPE.LONG, values: [0], pointer: 'gps' });
  if (thumbnail) {
    ifd1.push({ tag: 0x0103, type: TYPE.SHORT, values: [6] }); // compression = JPEG
    ifd1.push({ tag: 0x0201, type: TYPE.LONG, values: [0], pointer: 'thumbOffset' });
    ifd1.push({ tag: 0x0202, type: TYPE.LONG, values: [thumbnail.length] });
  }

  // Tags must be written in ascending order within an IFD.
  const sort = (list) => list.sort((a, b) => a.tag - b.tag);
  sort(ifd0);
  sort(exif);
  sort(gps);
  sort(ifd1);

  const sizeOf = (list) => (list.length ? 2 + list.length * 12 + 4 : 0);

  const offsets = {};
  let at = 8;
  offsets.ifd0 = at;
  at += sizeOf(ifd0);
  if (ifd1.length) {
    offsets.ifd1 = at;
    at += sizeOf(ifd1);
  }
  if (exif.length) {
    offsets.exif = at;
    at += sizeOf(exif);
  }
  if (gps.length) {
    offsets.gps = at;
    at += sizeOf(gps);
  }

  // Overflow values and the thumbnail live past every IFD.
  const heap = [];
  let heapAt = at;
  const place = (bytes) => {
    const offset = heapAt;
    heap.push(bytes);
    heapAt += bytes.length;
    // TIFF wants values at even offsets.
    if (heapAt % 2) {
      heap.push(new Uint8Array(1));
      heapAt++;
    }
    return offset;
  };

  const emitted = new Map();
  for (const list of [ifd0, ifd1, exif, gps]) {
    for (const entry of list) {
      const bytes = valueBytes(entry.type, entry.values, bigEndian);
      emitted.set(entry, { bytes, offset: bytes.length > 4 ? place(bytes) : null });
    }
  }
  const thumbOffset = thumbnail ? place(thumbnail) : null;

  const total = heapAt;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  const u16 = (o, v) => view.setUint16(o, v, !bigEndian);
  const u32 = (o, v) => view.setUint32(o, v, !bigEndian);

  out[0] = bigEndian ? 0x4d : 0x49;
  out[1] = out[0];
  u16(2, 42);
  u32(4, offsets.ifd0);

  const writeIfd = (list, offset, next) => {
    if (!list.length) return;
    u16(offset, list.length);
    list.forEach((entry, i) => {
      const at = offset + 2 + i * 12;
      const { bytes, offset: heapOffset } = emitted.get(entry);
      u16(at, entry.tag);
      u16(at + 2, entry.type);
      u32(at + 4, countOf(entry.type, entry.values));

      let pointerValue = null;
      if (entry.pointer === 'exif') pointerValue = offsets.exif;
      if (entry.pointer === 'gps') pointerValue = offsets.gps;
      if (entry.pointer === 'thumbOffset') pointerValue = thumbOffset;

      if (pointerValue !== null) {
        u32(at + 8, pointerValue);
      } else if (heapOffset !== null) {
        u32(at + 8, heapOffset);
      } else {
        // Inline: left-aligned in the four value bytes.
        out.set(bytes, at + 8);
      }
    });
    u32(offset + 2 + list.length * 12, next);
  };

  writeIfd(ifd0, offsets.ifd0, offsets.ifd1 ?? 0);
  if (ifd1.length) writeIfd(ifd1, offsets.ifd1, 0);
  if (exif.length) writeIfd(exif, offsets.exif, 0);
  if (gps.length) writeIfd(gps, offsets.gps, 0);

  let cursor = at;
  for (const piece of heap) {
    out.set(piece, cursor);
    cursor += piece.length;
  }

  return out;
}

/** A representative Exif block: phone, place, moment, serial, thumbnail. */
export function richExif({ orientation = 6, withGps = true, withThumb = true } = {}) {
  const thumbnail = withThumb
    ? Uint8Array.from([0xff, 0xd8, 0xff, 0xd9, 0x54, 0x48, 0x55, 0x4d, 0x42])
    : null;
  return buildTiff({
    ifd0: [
      { tag: 0x010f, type: TYPE.ASCII, values: 'ACME' },
      { tag: 0x0110, type: TYPE.ASCII, values: 'Phone X100' },
      { tag: 0x0112, type: TYPE.SHORT, values: [orientation] },
      { tag: 0x0131, type: TYPE.ASCII, values: 'CameraOS 4.2' },
      { tag: 0x0132, type: TYPE.ASCII, values: '2026:03:14 09:26:53' },
      { tag: 0x013b, type: TYPE.ASCII, values: 'Nikhil Khilwani' },
    ],
    exif: [
      { tag: 0x9003, type: TYPE.ASCII, values: '2026:03:14 09:26:53' },
      { tag: 0x9011, type: TYPE.ASCII, values: '+05:30' },
      { tag: 0x829a, type: TYPE.RATIONAL, values: [1, 125] },
      { tag: 0x829d, type: TYPE.RATIONAL, values: [18, 10] },
      { tag: 0x920a, type: TYPE.RATIONAL, values: [52, 10] },
      { tag: 0xa431, type: TYPE.ASCII, values: 'SN-4417-99823' },
      { tag: 0xa434, type: TYPE.ASCII, values: 'Wide 26mm f/1.8' },
      {
        tag: 0x9286,
        type: TYPE.UNDEFINED,
        values: Uint8Array.from([
          ...'ASCII\0\0\0'.split('').map((c) => c.charCodeAt(0)),
          ...'holiday'.split('').map((c) => c.charCodeAt(0)),
        ]),
      },
      { tag: 0x927c, type: TYPE.UNDEFINED, values: new Uint8Array(64).fill(0x5a) },
    ],
    gps: withGps
      ? [
          { tag: 0x0001, type: TYPE.ASCII, values: 'N' },
          // 18° 55' 12.0" N
          { tag: 0x0002, type: TYPE.RATIONAL, values: [18, 1, 55, 1, 120, 10] },
          { tag: 0x0003, type: TYPE.ASCII, values: 'E' },
          // 72° 49' 30.0" E
          { tag: 0x0004, type: TYPE.RATIONAL, values: [72, 1, 49, 1, 300, 10] },
          { tag: 0x0006, type: TYPE.RATIONAL, values: [141, 10] },
          { tag: 0x001d, type: TYPE.ASCII, values: '2026:03:14' },
        ]
      : [],
    thumbnail,
  });
}

/* -------------------------------------------------------------------------- */
/* JPEG                                                                       */
/* -------------------------------------------------------------------------- */

const bytes = (...values) => Uint8Array.from(values.flat());
const str = (text) => Uint8Array.from([...text].map((c) => c.charCodeAt(0)));

/** Wraps a payload as an APPn or COM segment with a correct length. */
export function jpegSegment(marker, payload) {
  const length = payload.length + 2;
  const out = new Uint8Array(4 + payload.length);
  out[0] = 0xff;
  out[1] = marker;
  out[2] = (length >> 8) & 0xff;
  out[3] = length & 0xff;
  out.set(payload, 4);
  return out;
}

const concat = (pieces) => {
  const total = pieces.reduce((sum, piece) => sum + piece.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const piece of pieces) {
    out.set(piece, at);
    at += piece.length;
  }
  return out;
};

export const XMP_PACKET =
  '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>' +
  '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
  '<rdf:Description xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
  'xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/">' +
  '<xmp:CreatorTool>Lightroom 14.2</xmp:CreatorTool>' +
  '<photoshop:City>Mumbai</photoshop:City>' +
  '<dc:creator><rdf:Seq><rdf:li>Nikhil Khilwani</rdf:li></rdf:Seq></dc:creator>' +
  '</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';

/**
 * A structurally complete JPEG. The tables and entropy data are synthetic —
 * nothing here decodes it — but every framing byte, length and marker is real,
 * which is exactly what the walker and the rebuild are being tested on.
 *
 * The scan deliberately contains a stuffed FF00 and a restart marker, because
 * a naive "find the next FF" scan end would cut the image in half there.
 */
export function buildJpeg({
  exif = richExif(),
  xmp = XMP_PACKET,
  iptc = true,
  icc = true,
  comment = 'Shot on holiday',
  trailer = true,
} = {}) {
  const pieces = [bytes(0xff, 0xd8)];

  pieces.push(jpegSegment(0xe0, concat([str('JFIF'), bytes(0, 1, 2, 1, 0, 72, 0, 72, 0, 0)])));
  if (exif) pieces.push(jpegSegment(0xe1, concat([str('Exif'), bytes(0, 0), exif])));
  if (xmp) pieces.push(jpegSegment(0xe1, concat([str('http://ns.adobe.com/xap/1.0/'), bytes(0), str(xmp)])));
  if (icc) {
    pieces.push(
      jpegSegment(0xe2, concat([str('ICC_PROFILE'), bytes(0, 1, 1), new Uint8Array(120).fill(0x11)])),
    );
  }
  if (iptc) {
    // 8BIM block holding an IPTC IIM record: 2:80 is By-line.
    const iim = concat([
      str('8BIM'), bytes(0x04, 0x04), bytes(0, 0), bytes(0, 0, 0, 0x0e),
      bytes(0x1c, 0x02, 0x50, 0x00, 0x09), str('N Khilwani'),
    ]);
    pieces.push(jpegSegment(0xed, concat([str('Photoshop 3.0'), bytes(0), iim])));
  }
  if (comment) pieces.push(jpegSegment(0xfe, str(comment)));

  // Minimal-but-real framing for the image itself.
  pieces.push(jpegSegment(0xdb, concat([bytes(0), new Uint8Array(64).fill(0x10)])));
  pieces.push(jpegSegment(0xc0, bytes(8, 0, 16, 0, 16, 1, 1, 0x11, 0)));
  pieces.push(jpegSegment(0xc4, concat([bytes(0x00), new Uint8Array(16).fill(0), bytes(0)])));
  pieces.push(jpegSegment(0xda, bytes(1, 1, 0, 0, 63, 0)));

  // Entropy data: a stuffed FF, a restart marker, and ordinary bytes.
  pieces.push(bytes(0x3a, 0x91, 0xff, 0x00, 0x2c, 0xff, 0xd0, 0x7e, 0x1b, 0xff, 0x00, 0x44));

  pieces.push(bytes(0xff, 0xd9));
  if (trailer) {
    // What a phone appends: a whole second image indexed by MPF.
    pieces.push(concat([str('APPENDED'), bytes(0xff, 0xd8, 0xff, 0xd9)]));
  }
  return concat(pieces);
}

const jpegTables = () => [
  jpegSegment(0xdb, concat([bytes(0), new Uint8Array(64).fill(0x10)])),
  jpegSegment(0xc4, concat([bytes(0x00), new Uint8Array(16).fill(0), bytes(0)])),
];

const jpegScan = () => bytes(0x3a, 0x91, 0xff, 0x00, 0x2c, 0xff, 0xd0, 0x7e, 0x1b);

const jfif = () => jpegSegment(0xe0, concat([str('JFIF'), bytes(0, 1, 1, 0, 0, 1, 0, 1, 0, 0)]));

/**
 * What a messaging app sends: re-encoded, with every metadata segment gone and
 * only the JFIF density header left. A tool reporting "clean" here is correct,
 * and the fixture exists so that claim is provable rather than assumed.
 */
export function buildStrippedJpeg() {
  return concat([
    bytes(0xff, 0xd8),
    jfif(),
    ...jpegTables(),
    jpegSegment(0xc0, bytes(8, 0, 16, 0, 16, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1)),
    jpegSegment(0xda, bytes(3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0)),
    jpegScan(),
    bytes(0xff, 0xd9),
  ]);
}

/**
 * A progressive JPEG: SOF2 and several scans, with a Huffman table appearing
 * between two of them. Every scan has to be found, or a rebuild truncates the
 * image at the first one.
 */
export function buildProgressiveJpeg({ exif = richExif({ orientation: 6 }) } = {}) {
  return concat([
    bytes(0xff, 0xd8),
    jfif(),
    ...(exif ? [jpegSegment(0xe1, concat([str('Exif'), bytes(0, 0), exif]))] : []),
    ...jpegTables(),
    jpegSegment(0xc2, bytes(8, 0, 16, 0, 16, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1)),
    jpegSegment(0xda, bytes(1, 1, 0, 0, 5, 0)),
    jpegScan(),
    jpegSegment(0xc4, concat([bytes(0x10), new Uint8Array(16).fill(0), bytes(0)])),
    jpegSegment(0xda, bytes(1, 1, 0, 6, 63, 2)),
    jpegScan(),
    jpegSegment(0xda, bytes(2, 2, 0, 3, 0, 1, 63, 0)),
    jpegScan(),
    bytes(0xff, 0xd9),
  ]);
}

/**
 * Exif sitting behind other APP segments, with the two markers whose signatures
 * carry NO terminating NUL: Adobe's APP14 colour transform, which must be kept,
 * and APP12 'Ducky', which holds camera settings and must go.
 */
export function buildLateExifJpeg({ exif = richExif({ orientation: 8 }) } = {}) {
  return concat([
    bytes(0xff, 0xd8),
    jfif(),
    jpegSegment(0xec, concat([str('Ducky'), bytes(0, 1, 0, 4)])),
    jpegSegment(0xee, concat([str('Adobe'), bytes(0x64, 0x00, 0x00, 0, 0, 0)])),
    ...(exif ? [jpegSegment(0xe1, concat([str('Exif'), bytes(0, 0), exif]))] : []),
    ...jpegTables(),
    jpegSegment(0xc0, bytes(8, 0, 16, 0, 16, 1, 1, 0x11, 0)),
    jpegSegment(0xda, bytes(1, 1, 0, 0, 63, 0)),
    jpegScan(),
    bytes(0xff, 0xd9),
  ]);
}

/* -------------------------------------------------------------------------- */
/* PNG — genuinely valid and decodable                                        */
/* -------------------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(data) {
  let c = -1;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

export function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(str(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** A real 2x2 RGB PNG with metadata chunks around it. */
export function buildPng({
  exif = richExif({ orientation: 8 }),
  text = true,
  itxt = true,
  ztxt = true,
  time = true,
  icc = true,
} = {}) {
  const width = 2;
  const height = 2;

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  // 10..12 = compression, filter, interlace, all zero

  // Two scanlines, each prefixed with its filter byte.
  const raw = new Uint8Array((1 + width * 3) * height);
  const pixels = [
    [0xd0, 0x21, 0x40],
    [0x18, 0x9a, 0x33],
  ];
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      raw.set(pixels[(x + y) % 2], row + 1 + x * 3);
    }
  }

  const pieces = [bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), pngChunk('IHDR', ihdr)];

  if (icc) {
    pieces.push(pngChunk('iCCP', concat([str('sRGB'), bytes(0, 0), zlibSync(new Uint8Array(64).fill(7))])));
  }
  if (text) pieces.push(pngChunk('tEXt', concat([str('Software'), bytes(0), str('GIMP 3.0')])));
  if (itxt) {
    pieces.push(
      pngChunk('iTXt', concat([str('XML:com.adobe.xmp'), bytes(0, 0, 0), bytes(0), bytes(0), str(XMP_PACKET)])),
    );
  }
  if (ztxt) {
    pieces.push(pngChunk('zTXt', concat([str('Comment'), bytes(0, 0), zlibSync(str('taken at home'))])));
  }
  if (exif) pieces.push(pngChunk('eXIf', exif));
  if (time) pieces.push(pngChunk('tIME', bytes(0x07, 0xea, 3, 14, 9, 26, 53)));

  pieces.push(pngChunk('IDAT', zlibSync(raw)));
  pieces.push(pngChunk('IEND', new Uint8Array(0)));
  return concat(pieces);
}

/* -------------------------------------------------------------------------- */
/* WebP                                                                       */
/* -------------------------------------------------------------------------- */

export function riffChunk(fourcc, data) {
  const padded = data.length + (data.length % 2);
  const out = new Uint8Array(8 + padded);
  out.set(str(fourcc), 0);
  new DataView(out.buffer).setUint32(4, data.length, true);
  out.set(data, 8);
  return out;
}

/** Extended-format WebP. The VP8L payload is synthetic; the framing is real. */
export function buildWebp({ exif = richExif({ orientation: 3 }), xmp = XMP_PACKET, icc = true } = {}) {
  const vp8x = new Uint8Array(10);
  let flags = 0;
  if (icc) flags |= 0x20;
  if (exif) flags |= 0x08;
  if (xmp) flags |= 0x04;
  vp8x[0] = flags;
  // Canvas size minus one, three bytes each, little-endian.
  vp8x[4] = 15;
  vp8x[7] = 15;

  const body = [riffChunk('VP8X', vp8x)];
  if (icc) body.push(riffChunk('ICCP', new Uint8Array(64).fill(0x22)));
  // Odd length on purpose: exercises the pad byte.
  body.push(riffChunk('VP8L', new Uint8Array(41).fill(0x2f)));
  if (exif) body.push(riffChunk('EXIF', exif));
  if (xmp) body.push(riffChunk('XMP ', str(xmp)));

  const payload = concat(body);
  const out = new Uint8Array(12 + payload.length);
  out.set(str('RIFF'), 0);
  new DataView(out.buffer).setUint32(4, out.length - 8, true);
  out.set(str('WEBP'), 8);
  out.set(payload, 12);
  return out;
}

export { concat, str };
