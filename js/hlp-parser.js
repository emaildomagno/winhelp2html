/**
 * WinHelp (.hlp) binary file parser.
 * Supports WinHelp 3.x and 4.x formats.
 *
 * File layout:
 *   Offset 0: File header (16 bytes) — magic + offsets
 *   At DirectoryStart: B+ tree directory (magic 0x293B)
 *   Internal files: |SYSTEM, |TOPIC, |Phrases, |FONT, |KWBTREE …
 */

'use strict';

/* ─────────────────────────────────────────────
   DataReader — thin wrapper over ArrayBuffer
───────────────────────────────────────────── */
class DataReader {
  constructor(buffer) {
    this.view   = new DataView(buffer);
    this.buffer = buffer;
    this.pos    = 0;
    this.size   = buffer.byteLength;
  }

  seek(pos)       { this.pos = pos; }
  skip(n)         { this.pos += n; }
  get remaining() { return this.size - this.pos; }

  u8()  { return this.view.getUint8(this.pos++); }
  u16() { const v = this.view.getUint16(this.pos, true); this.pos += 2; return v; }
  i16() { const v = this.view.getInt16(this.pos,  true); this.pos += 2; return v; }
  u32() { const v = this.view.getUint32(this.pos, true); this.pos += 4; return v; }
  i32() { const v = this.view.getInt32(this.pos,  true); this.pos += 4; return v; }

  /* Null-terminated ASCII string */
  cstr() {
    let s = '';
    while (this.pos < this.size) {
      const b = this.view.getUint8(this.pos++);
      if (b === 0) break;
      s += String.fromCharCode(b);
    }
    return s;
  }

  bytes(n) {
    const arr = new Uint8Array(this.buffer, this.pos, Math.min(n, this.remaining));
    this.pos += arr.length;
    return arr;
  }

  peekU16(pos) { return this.view.getUint16(pos, true); }
}

/* ─────────────────────────────────────────────
   LZ77 decompression (WinHelp variant)
   Bits in the control byte: 1 = literal, 0 = back-reference.
───────────────────────────────────────────── */
function lzDecompress(src) {
  const out = [];
  let i = 0;

  while (i < src.length) {
    let ctrl = src[i++];
    for (let bit = 0; bit < 8 && i < src.length; bit++, ctrl >>= 1) {
      if (ctrl & 1) {
        out.push(src[i++]);
      } else {
        if (i + 1 >= src.length) break;
        const lo  = src[i++];
        const hi  = src[i++];
        const len = (lo & 0x0F) + 3;
        const off = ((hi << 4) | (lo >> 4)) + 1;
        const base = out.length - off;
        for (let k = 0; k < len; k++) {
          const idx = base + k;
          out.push(idx >= 0 ? out[idx] : 0);
        }
      }
    }
  }
  return new Uint8Array(out);
}

/* ─────────────────────────────────────────────
   HLP B+ Tree directory reader

   Header (38 bytes, magic 0x293B):
     u16 magic, u16 flags, u16 pageSize,
     char structure[16], i16 zero, i16 pageSplits,
     i16 rootPage, i16 mustBeNegOne,
     i16 totalPages, i16 nLevels, i32 totalEntries

   Index page layout (per page, PageSize bytes):
     u16 used, i16 unknown,
     i16 firstChildPage,
     [(cstr key, i16 childPage), …]

   Leaf page layout:
     u16 used, i16 prevPage, i16 nextPage,
     [(cstr filename, i32 fileOffset), …]

   Crucially: some generators write a small wrapper (4–9 bytes)
   before the B+ tree header.  We scan a 128-byte window for the
   magic so we are robust to such padding.
───────────────────────────────────────────── */
class BTreeReader {
  constructor(reader, baseOffset) {
    this.reader = reader;
    this._readHeader(baseOffset);
  }

  _readHeader(base) {
    const r = this.reader;

    /* Scan up to 128 bytes ahead for the 0x293B magic.
       Known offsets seen in practice: 0, 4, 8, 9. */
    let found = -1;
    for (let delta = 0; delta <= 128; delta++) {
      const pos = base + delta;
      if (pos + 38 > r.size) break;
      if (r.peekU16(pos) === 0x293B) { found = pos; break; }
    }

    if (found === -1) {
      const badMagic = r.peekU16(base);
      throw new Error(
        `Estrutura de diretório desconhecida (magic=0x${badMagic.toString(16)}). ` +
        `O arquivo pode estar corrompido ou usar um formato não suportado.`
      );
    }

    r.seek(found);
    r.skip(2);                    // magic already confirmed
    this.flags       = r.u16();
    this.pageSize    = r.u16();

    this.structure = '';
    for (let i = 0; i < 16; i++) {
      const b = r.u8();
      if (b) this.structure += String.fromCharCode(b);
    }

    r.skip(2);                    // MustBeZero
    this.pageSplits  = r.i16();
    this.rootPage    = r.i16();
    r.skip(2);                    // MustBeNegOne
    this.totalPages  = r.i16();
    this.nLevels     = r.i16();
    this.totalEntries = r.i32();

    /* Clamp unreasonable page sizes */
    if (this.pageSize < 64 || this.pageSize > 65536) this.pageSize = 1024;

    this.pagesOffset = found + 38;
  }

  pageOffset(pageNo) {
    return this.pagesOffset + pageNo * this.pageSize;
  }

  /* Walk from root down to the leftmost leaf, then iterate via nextPage. */
  listFiles() {
    const files = [];
    if (this.rootPage < 0 || this.nLevels <= 0) return files;

    /* Descend to leftmost leaf through index pages */
    let page  = this.rootPage;
    let level = this.nLevels;

    while (level > 1) {
      const off = this.pageOffset(page);
      if (off + 6 > this.reader.size) break;
      this.reader.seek(off + 4);   // skip: u16 used, i16 unknown
      const firstChild = this.reader.i16();
      if (firstChild < 0 || firstChild >= this.totalPages) break;
      page = firstChild;
      level--;
    }

    /* Iterate leaf pages */
    const visited = new Set();
    while (page >= 0 && page < this.totalPages && !visited.has(page)) {
      visited.add(page);

      const off = this.pageOffset(page);
      if (off + 6 > this.reader.size) break;

      this.reader.seek(off);
      const used     = this.reader.u16();
      const prevPage = this.reader.i16(); // eslint-disable-line no-unused-vars
      const nextPage = this.reader.i16();
      const endPos   = off + Math.min(used, this.pageSize);

      /* Read entries: cstr filename + i32 fileOffset */
      while (this.reader.pos < endPos - 4) {
        const nameStart = this.reader.pos;
        const name      = this.reader.cstr();

        /* Sanity: name must be non-empty and we must have room for i32 */
        if (!name || this.reader.pos + 4 > endPos) {
          /* Back up and bail if we consumed nothing useful */
          if (this.reader.pos === nameStart + 1) break; // only null byte
          break;
        }

        const fileOffset = this.reader.i32();

        /* Negative offsets occasionally appear as "deleted" markers */
        if (fileOffset >= 0) {
          files.push({ name, fileOffset });
        }
      }

      page = nextPage;
    }

    return files;
  }
}

/* ─────────────────────────────────────────────
   Internal file reader

   Each internal file is prefixed by an 8-byte header:
     i32 reserved, i32 fileSize
   then fileSize bytes of data.

   Some unusual files store size at offset 4 (others at 0).
   We try both and pick whichever gives a sane size.
───────────────────────────────────────────── */
function readInternalFile(reader, fileOffset) {
  if (fileOffset < 0 || fileOffset + 8 > reader.size) {
    throw new Error(`Offset de arquivo interno inválido: ${fileOffset}`);
  }

  reader.seek(fileOffset);
  const word0 = reader.i32();
  const word1 = reader.i32();

  const maxData = reader.size - fileOffset - 8;

  /* Prefer word1 as fileSize (the most common layout: reserved + size) */
  let dataOff  = fileOffset + 8;
  let fileSize = word1;

  /* Fall back to word0 if word1 is implausible */
  if (fileSize <= 0 || fileSize > maxData) {
    fileSize = word0;
    dataOff  = fileOffset + 8;
  }

  /* Last resort: treat data as starting right at fileOffset */
  if (fileSize <= 0 || fileSize > reader.size - dataOff) {
    dataOff  = fileOffset;
    fileSize = Math.min(reader.size - dataOff, 65536);
  }

  return new DataReader(reader.buffer.slice(dataOff, dataOff + fileSize));
}

/* ─────────────────────────────────────────────
   |SYSTEM file parser
───────────────────────────────────────────── */
function parseSystem(r) {
  const info = { magic: 0, version: 0, title: '', copyright: '', contents: 0 };

  if (r.remaining < 4) return info;
  info.magic   = r.u16();
  info.version = r.u16();

  while (r.remaining >= 4) {
    const type = r.u16();
    const len  = r.u16();
    if (len === 0 || len > r.remaining) break;

    const startPos = r.pos;
    switch (type) {
      case 0x0001: info.title     = readFixedStr(r, len); break;
      case 0x0002: info.copyright = readFixedStr(r, len); break;
      case 0x0005: if (len >= 4) info.lcid     = r.u32(); break;
      case 0x0006: if (len >= 4) info.contents = r.i32(); break;
    }
    r.seek(startPos + len);
  }
  return info;
}

function readFixedStr(r, maxLen) {
  let s = '';
  for (let i = 0; i < maxLen; i++) {
    const b = r.u8();
    if (b === 0) { r.skip(maxLen - i - 1); break; }
    s += String.fromCharCode(b);
  }
  return s;
}

/* ─────────────────────────────────────────────
   |Phrases decompression table
───────────────────────────────────────────── */
function parsePhrases(r) {
  if (r.remaining < 2) return [];
  const nPhrases = r.u16();
  if (nPhrases === 0 || nPhrases > 32000) return [];

  const offsets = [];
  for (let i = 0; i <= nPhrases; i++) {
    if (r.remaining < 2) return [];
    offsets.push(r.u16());
  }

  const dataStart = r.pos;
  const phrases   = [];

  for (let i = 0; i < nPhrases; i++) {
    const len = offsets[i + 1] - offsets[i];
    if (len <= 0) { phrases.push(''); continue; }
    if (dataStart + offsets[i] + len > r.size) { phrases.push(''); continue; }
    r.seek(dataStart + offsets[i]);
    let s = '';
    for (let j = 0; j < len; j++) s += String.fromCharCode(r.u8());
    phrases.push(s);
  }
  return phrases;
}

/* ─────────────────────────────────────────────
   Topic text decoder

   WinHelp topic data is stored in 4 KB blocks.  Each block:
     i32 nextBlockOffset   (-1 = last block)
     i32 unused
     byte[] records…

   Record types:
     0x01 = TopicHeader  — begins a new logical topic (16-byte payload)
     0x20 = TextRecord   — paragraph data
     0x00 = padding (skip to next block)

   TextRecord layout:
     u16 blockSize   (bytes for this record, including these 4 bytes)
     u16 dataSize    (bytes of attribute data immediately following)
     byte[dataSize]  paragraph attributes (we mostly skip these)
     byte[…]         text bytes, possibly phrase-compressed
───────────────────────────────────────────── */
const TOPIC_BLOCK = 4096;

function decodeText(bytes, phrases) {
  let text = '';
  let i    = 0;

  while (i < bytes.length) {
    const b = bytes[i++];
    if (b === 0x00) break;

    if (b < 0x20) {
      if (b === 0x0D) { text += '\n'; }
      continue;
    }

    if (b < 0x80) {
      text += String.fromCharCode(b);
      continue;
    }

    /* Phrase reference: index encoded across one or two bytes */
    if (phrases.length === 0) continue;
    let idx = (b - 0x80) << 1;
    if (i < bytes.length && (bytes[i] & 1)) {
      idx |= 1;
      i++;
    }
    idx >>= 1;
    if (idx < phrases.length) text += phrases[idx];
  }
  return text;
}

function extractTopics(topicBuf, phrases, onProgress) {
  const topics  = [];
  const size    = topicBuf.byteLength;
  const view    = new DataView(topicBuf);
  let   pos     = 0;
  let   topicNo = 0;

  function currentTopic() {
    if (topics.length === 0) {
      topics.push({ title: '', paras: [], index: topicNo++ });
    }
    return topics[topics.length - 1];
  }

  while (pos + 8 <= size) {
    const nextBlock = view.getInt32(pos, true);     // next block offset
    const blockUsed = view.getInt32(pos + 4, true); // bytes used (may be 0)

    const blockEnd = Math.min(pos + TOPIC_BLOCK, size);
    let   rPos     = pos + 8;

    while (rPos < blockEnd) {
      if (rPos >= size) break;
      const recType = view.getUint8(rPos++);

      if (recType === 0x00) {
        break; // padding, skip to next block
      }

      if (recType === 0x01) {
        /* TopicHeader: 16 bytes of metadata we skip */
        if (rPos + 16 > blockEnd) break;
        rPos += 16;
        topics.push({ title: '', paras: [], index: topicNo++ });
        continue;
      }

      if (recType === 0x20) {
        /* TextRecord */
        if (rPos + 4 > blockEnd) break;

        const blockSize = view.getUint16(rPos,     true);
        const dataSize  = view.getUint16(rPos + 2, true);
        rPos += 4;

        if (blockSize < 4) break;
        const payloadSize = blockSize - 4;

        if (rPos + payloadSize > blockEnd) break;

        /* Attribute bytes (paragraph formatting) */
        const attrEnd  = rPos + dataSize;
        /* Text bytes follow the attribute block */
        const textEnd  = rPos + payloadSize;

        if (attrEnd <= textEnd) {
          const textLen   = textEnd - attrEnd;
          const textBytes = new Uint8Array(topicBuf, attrEnd, textLen);
          const text      = decodeText(textBytes, phrases).trim();

          if (text) {
            const t = currentTopic();
            if (!t.title) t.title = text.split('\n')[0].substring(0, 120);
            t.paras.push(text);
          }
        }

        rPos = textEnd;
        continue;
      }

      /* Unknown record type — try to skip by reading blockSize */
      if (rPos + 2 <= blockEnd) {
        const skip = view.getUint16(rPos, true);
        if (skip >= 2 && rPos + skip <= blockEnd) { rPos += skip; continue; }
      }
      break;
    }

    /* Advance to next block */
    if (nextBlock > pos && nextBlock < size) {
      pos = nextBlock;
    } else {
      pos += TOPIC_BLOCK;
    }

    if (topics.length % 20 === 0 && topics.length > 0) {
      onProgress(55 + Math.min(35, topics.length / 4),
        `${topics.length} tópicos encontrados…`);
    }
  }

  return topics
    .filter(t => t.title || t.paras.length > 0)
    .map((t, i) => ({
      title: t.title || `Tópico ${i + 1}`,
      text:  t.paras.join('\n\n'),
      index: i,
    }));
}

/* ─────────────────────────────────────────────
   Fallback: scan the file for internal file names
   when the B+ tree is completely unreadable.
───────────────────────────────────────────── */
function fallbackScanFiles(reader) {
  const targets = ['|SYSTEM', '|TOPIC', '|Phrases', '|FONT', '|KWBTREE'];
  const found   = {};
  const buf     = new Uint8Array(reader.buffer);
  const size    = buf.length;

  for (const name of targets) {
    const needle = name.split('').map(c => c.charCodeAt(0));
    needle.push(0); // null terminator

    outer:
    for (let i = 0; i < size - needle.length - 4; i++) {
      for (let j = 0; j < needle.length; j++) {
        if (buf[i + j] !== needle[j]) continue outer;
      }
      /* Name found at i; file offset is the i32 right after */
      const off = reader.view.getInt32(i + needle.length, true);
      if (off > 0 && off < size) {
        found[name] = off;
        break;
      }
    }
  }
  return found;
}

/* ─────────────────────────────────────────────
   Main parser entry point
───────────────────────────────────────────── */
function parseHLP(arrayBuffer, onProgress) {
  const r = new DataReader(arrayBuffer);

  /* ── File header ── */
  if (r.size < 16) throw new Error('Arquivo muito pequeno para ser um HLP válido.');

  const magic = r.u32();

  /* Accept both 3.x (0x00035F3F) and 4.x (0x00045F3F) magic */
  if ((magic & 0x0000FFFF) !== 0x5F3F) {
    throw new Error(
      `Arquivo inválido: os primeiros bytes não correspondem ao formato WinHelp ` +
      `(encontrado: 0x${magic.toString(16).toUpperCase()}).`
    );
  }

  onProgress(10, 'Lendo cabeçalho…');

  const directoryStart = r.i32();
  const freeListStart  = r.i32(); // eslint-disable-line no-unused-vars
  const fileSize       = r.i32(); // eslint-disable-line no-unused-vars

  if (directoryStart <= 0 || directoryStart >= r.size) {
    throw new Error('Offset de diretório inválido no cabeçalho do arquivo.');
  }

  /* ── B+ tree directory ── */
  onProgress(20, 'Lendo diretório interno…');

  let fileMap = {};

  try {
    const tree = new BTreeReader(r, directoryStart);
    const list = tree.listFiles();
    for (const f of list) fileMap[f.name] = f.fileOffset;
  } catch (e) {
    /* B+ tree failed — try brute-force name scan as last resort */
    onProgress(25, 'Tentando varredura alternativa de arquivos…');
    fileMap = fallbackScanFiles(r);

    if (Object.keys(fileMap).length === 0) {
      throw new Error(
        `Falha ao ler o diretório interno: ${e.message} ` +
        `O arquivo pode estar corrompido ou num formato incompatível.`
      );
    }
  }

  onProgress(35, 'Lendo metadados…');

  /* ── |SYSTEM ── */
  let sysInfo = { title: '', version: 0 };
  if (fileMap['|SYSTEM'] != null) {
    try { sysInfo = parseSystem(readInternalFile(r, fileMap['|SYSTEM'])); }
    catch (_) { /* non-fatal */ }
  }

  /* ── |Phrases ── */
  onProgress(45, 'Lendo tabela de frases…');
  let phrases = [];
  if (fileMap['|Phrases'] != null) {
    try { phrases = parsePhrases(readInternalFile(r, fileMap['|Phrases'])); }
    catch (_) { /* non-fatal */ }
  }

  /* ── |TOPIC ── */
  onProgress(55, 'Decodificando tópicos…');

  let topics = [];

  if (fileMap['|TOPIC'] != null) {
    try {
      const topicOff = fileMap['|TOPIC'];
      r.seek(topicOff);
      const _res  = r.i32();
      const tSize = r.i32();

      const safeSize = Math.min(
        tSize > 0 ? tSize : r.size - topicOff - 8,
        r.size - topicOff - 8
      );
      const topicBuf = arrayBuffer.slice(topicOff + 8, topicOff + 8 + safeSize);
      topics = extractTopics(topicBuf, phrases, onProgress);
    } catch (e) {
      topics = [{ title: 'Erro ao decodificar tópicos', text: e.message, index: 0 }];
    }
  }

  if (topics.length === 0) {
    topics = [{
      title: '(Sem tópicos)',
      text:  'Nenhum tópico legível foi encontrado neste arquivo.',
      index: 0,
    }];
  }

  onProgress(95, 'Finalizando…');

  return {
    title:    sysInfo.title || 'Sem título',
    version:  sysInfo.version,
    topics,
    fileList: Object.keys(fileMap).map(name => ({ name, fileOffset: fileMap[name] })),
  };
}

if (typeof module !== 'undefined') module.exports = { parseHLP };
