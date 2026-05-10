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
   WinHelp 3.x phrase table  |PhrIndex + |PhrImage

   |PhrIndex layout:
     u16 nPhrases
     u16 cbPhrases  (total bytes in decompressed |PhrImage)
     u16 offsets[nPhrases + 1]

   |PhrImage layout:
     Hall-LZ77–compressed blob whose decompressed form is
     the concatenated phrase strings addressed by offsets[].
───────────────────────────────────────────── */
function parsePhrIndex3x(r) {
  if (r.remaining < 4) return null;
  const nPhrases  = r.u16();
  const cbPhrases = r.u16(); // eslint-disable-line no-unused-vars
  if (nPhrases === 0 || nPhrases > 32000) return null;
  const offsets = [];
  for (let i = 0; i <= nPhrases; i++) {
    if (r.remaining < 2) return null;
    offsets.push(r.u16());
  }
  return { nPhrases, offsets };
}

function parsePhrImage3x(r, phrIndex) {
  const compressed = new Uint8Array(r.buffer);
  const raw        = lzDecompress(compressed);
  const phrases    = [];
  for (let i = 0; i < phrIndex.nPhrases; i++) {
    const start = phrIndex.offsets[i];
    const end   = phrIndex.offsets[i + 1];
    if (start >= raw.length || end > raw.length || end <= start) {
      phrases.push(''); continue;
    }
    let s = '';
    for (let j = start; j < end; j++) s += String.fromCharCode(raw[j]);
    phrases.push(s);
  }
  return phrases;
}

/* ─────────────────────────────────────────────
   WinHelp 3.x |TOPIC block decompression

   Each 2048-byte block has a 10-byte uncompressed header:
     i32 nextBlock, i32 lastTopicLink, u16 freeBytes
   Followed by Hall-LZ77–compressed data of length
   (2048 - 10 - freeBytes).  After decompressing every
   block and concatenating results we get a flat stream
   of topic-link records with no block boundaries.
───────────────────────────────────────────── */
function decompressTopicBlocks3x(topicBuf, L) {
  const BLOCK_3X     = 2048;
  const BLK_HDR_3X   = 10;
  const view         = new DataView(topicBuf);
  const allBytes     = [];
  let   blockStart   = 0;
  let   blockNo      = 0;

  while (blockStart + BLK_HDR_3X <= topicBuf.byteLength) {
    const nextBlock  = view.getInt32(blockStart,     true);
    const freeBytes  = view.getUint16(blockStart + 8, true);
    const blockEnd   = Math.min(blockStart + BLOCK_3X, topicBuf.byteLength);
    const compStart  = blockStart + BLK_HDR_3X;
    const safeEnd    = blockEnd - Math.min(freeBytes, blockEnd - compStart);

    L?.dim(`  3x bloco #${blockNo} off=${blockStart} nextBlock=${nextBlock} freeBytes=${freeBytes} compLen=${safeEnd - compStart}`);

    if (safeEnd > compStart) {
      const compData = new Uint8Array(topicBuf, compStart, safeEnd - compStart);
      const expanded = lzDecompress(compData);
      L?.dim(`  → ${compData.length} → ${expanded.length} bytes`);
      for (const b of expanded) allBytes.push(b);
    }

    blockStart += BLOCK_3X;
    blockNo++;
  }

  L?.info(`  Descompressão 3.x total: ${topicBuf.byteLength} → ${allBytes.length} bytes`);
  return new Uint8Array(allBytes).buffer;
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
   Topic extraction from |TOPIC data

   |TOPIC is divided into fixed-size file-blocks (2 048 or 4 096 bytes).
   Each file-block starts with an 8-byte block header:
     i32 nextBlockOffset  (abs. offset in |TOPIC of next block, -1 = last)
     i32 lastTopicOffset  (informational)

   Within each block, "topic links" are stored sequentially.
   Each topic link has a 24-byte link header:
     i32 linkSize   total bytes of this link (24-byte hdr + payload)
     i32 dataLen    bytes of payload following this 24-byte header
     i32 prevLink   abs. offset of previous link  (-1 = none)
     i32 nextLink   abs. offset of next link      (-1 = none)
     i32 prevNS     non-scroll navigation (ignored)
     i32 nextNS

   Payload (dataLen bytes):
     byte[0] recType  0x02 = new logical topic
                      0x20 = text paragraph
                      0x23 = table
     byte[1…] paragraph data
───────────────────────────────────────────── */

const LINK_HDR  = 24;   // bytes in each topic link header
const BLOCK_HDR = 8;    // bytes in each file-block header

/* Detect file-block size from the first nextBlock field.
   Typical values: 2048 (WinHelp 3.x) or 4096 (WinHelp 4.x). */
function detectBlockSize(buf) {
  if (buf.byteLength < 4) return 4096;
  const v = new DataView(buf).getInt32(0, true);
  if (v === 2048) return 2048;
  if (v === 4096) return 4096;
  return 4096;
}

/* Extract printable text from a paragraph payload.
   Bytes 0x20-0x7F → literal ASCII.
   Bytes 0x80-0xFF → phrase table lookup.
   Bytes 0x00-0x1F → WinHelp formatting escape codes; skip them and
                     any parameter bytes they carry.                  */
function extractParaText(buf, start, end, phrases) {
  const view = new DataView(buf);
  let text = '';
  let i    = start;

  while (i < end) {
    const b = view.getUint8(i++);

    if (b === 0x00) break;

    if (b >= 0x20 && b < 0x80) {
      text += String.fromCharCode(b);
      continue;
    }

    if (b >= 0x80) {
      if (phrases.length === 0) continue;
      let idx = (b - 0x80) << 1;
      if (i < end && (view.getUint8(i) & 1)) { idx |= 1; i++; }
      idx >>= 1;
      if (idx < phrases.length) text += phrases[idx];
      continue;
    }

    /* b < 0x20 — WinHelp escape codes with variable-length parameters */
    switch (b) {
      case 0x0D: text += '\n'; break;
      case 0x0A: break;
      /* 1-byte parameter codes (even values) */
      case 0x02: case 0x04: case 0x06: case 0x08:
      case 0x0E: case 0x10: case 0x12: case 0x14:
      case 0x16: case 0x18: case 0x1A: case 0x1C: i += 1; break;
      /* 2-byte parameter codes (odd values) */
      case 0x03: case 0x05: case 0x07: case 0x09:
      case 0x0F: case 0x11: case 0x13: case 0x15:
      case 0x17: case 0x19: case 0x1B: case 0x1D: i += 2; break;
      /* 4-byte parameter */
      case 0x01: i += 4; break;
      default: break;
    }
  }
  return text;
}

/* flatMode = true: the buffer is already fully decompressed with no block
   headers — treat the whole thing as a single stream of topic-link records. */
function extractTopics(topicBuf, phrases, onProgress, flatMode) {
  const L = typeof DebugLog !== 'undefined' ? DebugLog : null;
  const topics  = [];
  const size    = topicBuf.byteLength;
  const view    = new DataView(topicBuf);
  let   topicNo = 0;

  const fileBlockSize = flatMode ? size : detectBlockSize(topicBuf);
  const hdrSize       = flatMode ? 0    : BLOCK_HDR;

  L?.head(`── |TOPIC extraction (${flatMode ? 'flat/decompressed' : 'raw'}) ──`);
  L?.info(`  Buffer: ${size} bytes  blockSize: ${fileBlockSize}  hdrSize: ${hdrSize}`);
  L?.info(`  Frases carregadas: ${phrases.length}`);
  if (L) L.hex('  Primeiros 64 bytes', topicBuf, 0, 64);

  const visited    = new Set();
  let   blockStart = 0;
  let   blockNo    = 0;
  let   totalLinks = 0;
  let   skipped    = 0;

  while (blockStart < size && !visited.has(blockStart)) {
    visited.add(blockStart);

    if (!flatMode && blockStart + BLOCK_HDR > size) {
      L?.warn(`  Bloco #${blockNo} em offset ${blockStart}: fora dos limites — interrompendo`);
      break;
    }

    let nextBlockOff = -1;
    if (!flatMode) {
      nextBlockOff = view.getInt32(blockStart,     true);
      const lastTopicOff = view.getInt32(blockStart + 4, true);
      L?.info(`  Bloco #${blockNo} offset=${blockStart}  nextBlock=${nextBlockOff}  lastTopic=${lastTopicOff}`);
    } else {
      L?.info(`  Flat bloco #${blockNo} offset=${blockStart}`);
    }

    const blockDataEnd = Math.min(blockStart + fileBlockSize, size);
    let   lpos         = blockStart + hdrSize;
    let   linksInBlock = 0;

    while (lpos + LINK_HDR <= blockDataEnd) {
      const linkSize = view.getInt32(lpos,      true);
      const dataLen  = view.getInt32(lpos + 4,  true);
      const prevLink = view.getInt32(lpos + 8,  true);
      const nextLink = view.getInt32(lpos + 12, true);

      L?.dim(`    link @${lpos}  linkSize=${linkSize}  dataLen=${dataLen}  prev=${prevLink}  next=${nextLink}`);

      const maxLink = flatMode ? size : fileBlockSize;
      if (linkSize < LINK_HDR || linkSize > maxLink ||
          dataLen  < 1        || dataLen  > linkSize - LINK_HDR) {
        L?.warn(`    → inválido (linkSize=${linkSize}, dataLen=${dataLen}) — interrompendo bloco`);
        skipped++;
        break;
      }

      const dataStart = lpos + LINK_HDR;
      if (dataStart >= size) { L?.warn(`    → dataStart ${dataStart} >= size ${size}`); break; }

      const dataEnd  = Math.min(dataStart + dataLen, blockDataEnd, size);
      const recType  = view.getUint8(dataStart);

      L?.dim(`    recType=0x${recType.toString(16).padStart(2,'0')}  dataStart=${dataStart}  dataEnd=${dataEnd}`);

      if (recType === 0x01 || recType === 0x02) {
        topics.push({ title: '', paras: [], index: topicNo++ });
        L?.ok(`    → NOVO TÓPICO #${topicNo} (type=0x${recType.toString(16)})`);

      } else if (recType === 0x20) {
        const text = extractParaText(topicBuf, dataStart + 1, dataEnd, phrases).trim();
        L?.dim(`    → TEXT len=${dataEnd - dataStart - 1}  extraído="${text.substring(0, 60).replace(/\n/g,' ')}"`);
        if (text) {
          if (!topics.length) topics.push({ title: '', paras: [], index: topicNo++ });
          const t = topics[topics.length - 1];
          if (!t.title) {
            t.title = text.split('\n')[0].substring(0, 120);
            L?.ok(`    → Título do tópico #${t.index + 1}: "${t.title}"`);
          }
          t.paras.push(text);
        } else {
          L?.dim(`    → texto vazio após extração`);
        }

      } else if (recType === 0x23 || recType === 0x24) {
        L?.dim(`    → TABELA (type=0x${recType.toString(16)}) — ignorado`);

      } else {
        L?.warn(`    → tipo desconhecido 0x${recType.toString(16).padStart(2,'0')}`);
      }

      lpos += linkSize;
      linksInBlock++;
      totalLinks++;
    }

    L?.info(`  Bloco #${blockNo} encerrado: ${linksInBlock} links, ${topics.length} tópicos até aqui`);
    blockNo++;

    if (flatMode) break;  // entire buffer is one block — done

    if (nextBlockOff > blockStart && nextBlockOff < size) {
      blockStart = nextBlockOff;
    } else {
      blockStart += fileBlockSize;
    }

    if (topics.length > 0 && topics.length % 20 === 0) {
      onProgress(55 + Math.min(35, topics.length / 4),
        `${topics.length} tópicos encontrados…`);
    }
  }

  L?.head(`── Resultado: ${topics.length} tópicos, ${totalLinks} links, ${skipped} blocos inválidos ──`);

  const result = topics
    .filter(t => t.title || t.paras.length)
    .map((t, i) => ({
      title: t.title || `Tópico ${i + 1}`,
      text:  t.paras.join('\n\n'),
      index: i,
    }));

  L?.info(`  Após filtro: ${result.length} tópicos com conteúdo`);
  return result;
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
  const L = typeof DebugLog !== 'undefined' ? DebugLog : null;
  const r = new DataReader(arrayBuffer);

  L?.head('═══════════════ parseHLP iniciado ═══════════════');
  L?.info(`Tamanho do arquivo: ${arrayBuffer.byteLength} bytes`);
  if (L) L.hex('Primeiros 16 bytes', arrayBuffer, 0, 16);

  /* ── File header ── */
  if (r.size < 16) throw new Error('Arquivo muito pequeno para ser um HLP válido.');

  const magic = r.u32();
  L?.info(`Magic: 0x${magic.toString(16).toUpperCase()}`);

  /* Accept both 3.x (0x00035F3F) and 4.x (0x00045F3F) magic */
  if ((magic & 0x0000FFFF) !== 0x5F3F) {
    L?.error(`Magic inválido — esperado 0xXXXX5F3F`);
    throw new Error(
      `Arquivo inválido: os primeiros bytes não correspondem ao formato WinHelp ` +
      `(encontrado: 0x${magic.toString(16).toUpperCase()}).`
    );
  }
  L?.ok(`Magic OK (versão ${(magic >> 16) & 0xFF === 3 ? '3.x' : (magic >> 16) & 0xFF === 4 ? '4.x' : 'desconhecida'})`);

  onProgress(10, 'Lendo cabeçalho…');

  const directoryStart = r.i32();
  const freeListStart  = r.i32();
  const fileSize       = r.i32();

  L?.info(`directoryStart: ${directoryStart}  freeListStart: ${freeListStart}  fileSize: ${fileSize}`);

  if (directoryStart <= 0 || directoryStart >= r.size) {
    L?.error(`directoryStart inválido: ${directoryStart}`);
    throw new Error('Offset de diretório inválido no cabeçalho do arquivo.');
  }

  /* ── B+ tree directory ── */
  onProgress(20, 'Lendo diretório interno…');
  L?.head('── B+ Tree ──');
  if (L) L.hex(`Bytes em directoryStart (${directoryStart})`, arrayBuffer, directoryStart, 40);

  let fileMap = {};

  try {
    const tree = new BTreeReader(r, directoryStart);
    L?.ok(`B+ tree: magic OK  pageSize=${tree.pageSize}  rootPage=${tree.rootPage}  nLevels=${tree.nLevels}  totalEntries=${tree.totalEntries}  pagesOffset=${tree.pagesOffset}`);
    const list = tree.listFiles();
    L?.ok(`Arquivos encontrados no diretório: ${list.length}`);
    for (const f of list) {
      fileMap[f.name] = f.fileOffset;
      L?.dim(`  "${f.name}" → offset ${f.fileOffset}`);
    }
  } catch (e) {
    L?.warn(`B+ tree falhou: ${e.message} — tentando varredura alternativa`);
    onProgress(25, 'Tentando varredura alternativa de arquivos…');
    fileMap = fallbackScanFiles(r);
    L?.info(`Varredura alternativa encontrou: ${Object.keys(fileMap).join(', ') || '(nada)'}`);

    if (Object.keys(fileMap).length === 0) {
      throw new Error(
        `Falha ao ler o diretório interno: ${e.message} ` +
        `O arquivo pode estar corrompido ou num formato incompatível.`
      );
    }
  }

  onProgress(35, 'Lendo metadados…');
  L?.head('── Arquivos internos ──');

  /* Detect WinHelp version: 3.x uses |PhrImage+|PhrIndex; 4.x uses |Phrases */
  const is3x = fileMap['|PhrImage'] != null && fileMap['|PhrIndex'] != null;
  L?.info(`Formato detectado: WinHelp ${is3x ? '3.x (Hall compression)' : '4.x'}`);

  /* ── |SYSTEM ── */
  let sysInfo = { title: '', version: 0 };
  if (fileMap['|SYSTEM'] != null) {
    L?.info(`|SYSTEM offset: ${fileMap['|SYSTEM']}`);
    if (L) L.hex('|SYSTEM header bytes', arrayBuffer, fileMap['|SYSTEM'], 16);
    try {
      sysInfo = parseSystem(readInternalFile(r, fileMap['|SYSTEM']));
      L?.ok(`|SYSTEM: magic=0x${sysInfo.magic?.toString(16)}  version=${sysInfo.version}  title="${sysInfo.title}"`);
    } catch (e) { L?.warn(`|SYSTEM falhou: ${e.message}`); }
  } else {
    L?.warn('|SYSTEM não encontrado no diretório');
  }

  /* ── Phrase table ── */
  onProgress(45, 'Lendo tabela de frases…');
  let phrases = [];

  if (is3x) {
    L?.info(`|PhrIndex offset: ${fileMap['|PhrIndex']}  |PhrImage offset: ${fileMap['|PhrImage']}`);
    try {
      const phrIndexR = readInternalFile(r, fileMap['|PhrIndex']);
      const phrIndex  = parsePhrIndex3x(phrIndexR);
      if (phrIndex) {
        L?.ok(`|PhrIndex: ${phrIndex.nPhrases} frases`);
        const phrImageR = readInternalFile(r, fileMap['|PhrImage']);
        phrases = parsePhrImage3x(phrImageR, phrIndex);
        L?.ok(`|PhrImage: ${phrases.length} frases decodificadas`);
        if (phrases.length > 0) L?.dim(`  Ex. frase[0]="${phrases[0]}"  frase[1]="${phrases[1] || ''}"`);
      } else {
        L?.warn('|PhrIndex parse falhou — frases indisponíveis');
      }
    } catch (e) { L?.warn(`|PhrIndex/|PhrImage falhou: ${e.message}`); }
  } else if (fileMap['|Phrases'] != null) {
    L?.info(`|Phrases offset: ${fileMap['|Phrases']}`);
    try {
      phrases = parsePhrases(readInternalFile(r, fileMap['|Phrases']));
      L?.ok(`|Phrases: ${phrases.length} frases carregadas`);
    } catch (e) { L?.warn(`|Phrases falhou: ${e.message}`); }
  } else {
    L?.info('Nenhuma tabela de frases encontrada');
  }

  /* ── |TOPIC ── */
  onProgress(55, 'Decodificando tópicos…');
  L?.head('── |TOPIC ──');

  let topics = [];

  if (fileMap['|TOPIC'] != null) {
    const topicOff = fileMap['|TOPIC'];
    L?.info(`|TOPIC offset no arquivo: ${topicOff}`);
    if (L) L.hex('|TOPIC cabeçalho interno (16 bytes)', arrayBuffer, topicOff, 16);

    try {
      r.seek(topicOff);
      const hdrWord0 = r.i32();
      const hdrWord1 = r.i32();
      L?.info(`|TOPIC header word0=${hdrWord0}  word1=${hdrWord1}`);

      const safeSize = Math.min(
        hdrWord1 > 0 ? hdrWord1 : r.size - topicOff - 8,
        r.size - topicOff - 8
      );
      L?.info(`|TOPIC safeSize=${safeSize} bytes  (dados começam em offset ${topicOff + 8})`);

      if (safeSize <= 0) {
        L?.error('|TOPIC safeSize <= 0 — nada a decodificar');
      } else {
        if (L) L.hex('|TOPIC primeiros 64 bytes de dados', arrayBuffer, topicOff + 8, 64);
        const topicBuf = arrayBuffer.slice(topicOff + 8, topicOff + 8 + safeSize);

        if (is3x) {
          L?.info('WinHelp 3.x: descomprimindo blocos Hall LZ77…');
          onProgress(60, 'Descomprimindo tópicos 3.x…');
          const decompBuf = decompressTopicBlocks3x(topicBuf, L);
          L?.ok(`Descompressão concluída: ${decompBuf.byteLength} bytes`);
          if (L) L.hex('Primeiros 64 bytes descomprimidos', decompBuf, 0, 64);
          topics = extractTopics(decompBuf, phrases, onProgress, true /* flatMode */);
        } else {
          topics = extractTopics(topicBuf, phrases, onProgress, false);
        }
      }
    } catch (e) {
      L?.error(`Exceção em |TOPIC: ${e.message}`);
      topics = [{ title: 'Erro ao decodificar tópicos', text: e.message, index: 0 }];
    }
  } else {
    L?.error('|TOPIC não encontrado no diretório — sem tópicos');
  }

  if (topics.length === 0) {
    L?.warn('Nenhum tópico extraído — retornando placeholder');
    topics = [{
      title: '(Sem tópicos)',
      text:  'Nenhum tópico legível foi encontrado neste arquivo.',
      index: 0,
    }];
  }

  onProgress(95, 'Finalizando…');
  L?.head(`═══════════════ parseHLP concluído: ${topics.length} tópico(s) ═══════════════`);

  return {
    title:    sysInfo.title || 'Sem título',
    version:  sysInfo.version,
    topics,
    fileList: Object.keys(fileMap).map(name => ({ name, fileOffset: fileMap[name] })),
  };
}

if (typeof module !== 'undefined') module.exports = { parseHLP };
