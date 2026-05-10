/**
 * WinHelp (.hlp) binary file parser.
 * Supports WinHelp 3.x and 4.x formats.
 *
 * Format references:
 *  - Magic: 0x00035F3F (bytes: 3F 5F 03 00)
 *  - Internal file system uses a B+ tree directory
 *  - Topic data may use LZ77 compression and phrase substitution
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

  seek(pos)      { this.pos = pos; }
  skip(n)        { this.pos += n; }
  get remaining(){ return this.size - this.pos; }

  u8()  { return this.view.getUint8(this.pos++); }
  i8()  { const v = this.view.getInt8(this.pos); this.pos++; return v; }

  u16() { const v = this.view.getUint16(this.pos, true); this.pos += 2; return v; }
  i16() { const v = this.view.getInt16(this.pos, true);  this.pos += 2; return v; }

  u32() { const v = this.view.getUint32(this.pos, true); this.pos += 4; return v; }
  i32() { const v = this.view.getInt32(this.pos, true);  this.pos += 4; return v; }

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

  /* Read n raw bytes as Uint8Array */
  bytes(n) {
    const arr = new Uint8Array(this.buffer, this.pos, n);
    this.pos += n;
    return arr;
  }

  /* Read slice as a new DataReader */
  slice(offset, length) {
    return new DataReader(this.buffer.slice(offset, offset + length));
  }

  peekU8(offset = this.pos) { return this.view.getUint8(offset); }
  peekU16(offset = this.pos){ return this.view.getUint16(offset, true); }
}

/* ─────────────────────────────────────────────
   LZ77 decompression (WinHelp variant)
───────────────────────────────────────────── */
function lzDecompress(src) {
  const out = [];
  let i = 0;

  while (i < src.length) {
    let ctrl = src[i++];
    for (let bit = 0; bit < 8 && i < src.length; bit++) {
      if (ctrl & 1) {
        /* Literal byte */
        out.push(src[i++]);
      } else {
        if (i + 1 >= src.length) break;
        const lo = src[i++];
        const hi = src[i++];
        const len    = (lo & 0x0F) + 3;
        const offset = ((hi << 4) | (lo >> 4)) + 1;
        const base   = out.length - offset;
        for (let k = 0; k < len; k++) {
          const idx = base + k;
          out.push(idx >= 0 ? out[idx] : 0);
        }
      }
      ctrl >>= 1;
    }
  }
  return new Uint8Array(out);
}

/* ─────────────────────────────────────────────
   HLP B+ Tree directory reader
───────────────────────────────────────────── */
class BTreeReader {
  constructor(reader, baseOffset) {
    this.reader     = reader;
    this.baseOffset = baseOffset;
    this._readHeader();
  }

  _readHeader() {
    const r = this.reader;
    r.seek(this.baseOffset);

    const magic = r.u16();
    if (magic !== 0x293B) {
      throw new Error(`Invalid B+ tree magic: 0x${magic.toString(16)}`);
    }

    this.flags     = r.u16();
    this.pageSize  = r.u16();
    /* Structure string (16 bytes) + 2 padding bytes */
    this.structure = '';
    for (let i = 0; i < 16; i++) {
      const b = r.u8();
      if (b) this.structure += String.fromCharCode(b);
    }
    r.skip(2);                  // MustBeZero
    this.pageSplits  = r.i16();
    this.rootPage    = r.i16();
    r.skip(2);                  // MustBeNegOne
    this.totalPages  = r.i16();
    this.nLevels     = r.i16();
    this.totalEntries = r.i32();

    /* Pages start immediately after the 22-byte header */
    this.pagesOffset = this.baseOffset + 38;
  }

  pageOffset(pageNo) {
    return this.pagesOffset + pageNo * this.pageSize;
  }

  /* Enumerate all leaf-page entries: {name, fileOffset} */
  listFiles() {
    const files = [];
    this._collectLeaves(this.rootPage, files);
    return files;
  }

  _collectLeaves(pageNo, files) {
    if (pageNo < 0 || pageNo >= this.totalPages) return;

    const off    = this.pageOffset(pageNo);
    const r      = this.reader;
    r.seek(off);

    const usedBytes = r.u16();
    const prevPage  = r.i16();
    const nextPage  = r.i16();
    const isLeaf    = (prevPage !== -1 || nextPage !== -1 ||
                       this.nLevels === 1);

    /* For internal (index) pages we recurse via child pointers */
    if (!isLeaf) {
      r.seek(off + 6);
      const firstChild = r.i16();
      this._collectLeaves(firstChild, files);

      /* Each index entry: key string + child page */
      const endPos = off + usedBytes;
      while (r.pos < endPos - 4) {
        r.cstr();               // skip key
        const child = r.i16();
        this._collectLeaves(child, files);
      }
      return;
    }

    /* Leaf page: key = filename, value = DWORD file offset */
    r.seek(off + 6);
    const endPos = off + usedBytes;

    while (r.pos < endPos - 4) {
      const startPos = r.pos;
      const name = r.cstr();
      if (!name) break;

      const fileOffset = r.i32();
      if (fileOffset < 0) break;

      files.push({ name, fileOffset });
    }

    /* Follow linked leaf list */
    if (nextPage >= 0) this._collectLeaves(nextPage, files);
  }
}

/* ─────────────────────────────────────────────
   Internal file reader
───────────────────────────────────────────── */
function readInternalFile(reader, fileOffset) {
  reader.seek(fileOffset);
  const reserved  = reader.i32(); // reserved / file header flags
  const fileSize  = reader.i32(); // uncompressed size

  /* Data immediately follows the 8-byte header */
  const data = new Uint8Array(reader.buffer, fileOffset + 8, fileSize);
  return new DataReader(data.buffer.slice(fileOffset + 8, fileOffset + 8 + fileSize));
}

/* ─────────────────────────────────────────────
   |SYSTEM file parser
───────────────────────────────────────────── */
function parseSystem(r) {
  const info = {
    magic:    r.u16(),
    version:  r.u16(),
    lcid:     0,
    title:    '',
    copyright:'',
    contents: 0,
  };

  /* Records follow the 4-byte header */
  while (r.remaining >= 4) {
    const type = r.u16();
    const len  = r.u16();
    if (len > r.remaining) break;

    const startPos = r.pos;
    switch (type) {
      case 0x0001:              // Title
        info.title = readFixedStr(r, len);
        break;
      case 0x0002:              // Copyright
        info.copyright = readFixedStr(r, len);
        break;
      case 0x0005:              // LCID
        if (len >= 4) info.lcid = r.u32();
        break;
      case 0x0006:              // Contents topic offset
        if (len >= 4) info.contents = r.i32();
        break;
      default:
        break;
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
  const nPhrases = r.u16();
  if (nPhrases === 0) return [];

  /* Offsets: nPhrases+1 WORDs */
  const offsets = [];
  for (let i = 0; i <= nPhrases; i++) offsets.push(r.u16());

  /* The string data starts right after the offset table */
  const dataStart = r.pos;
  const phrases   = [];

  for (let i = 0; i < nPhrases; i++) {
    const len = offsets[i + 1] - offsets[i];
    if (len <= 0) { phrases.push(''); continue; }
    r.seek(dataStart + offsets[i]);
    let s = '';
    for (let j = 0; j < len; j++) s += String.fromCharCode(r.u8());
    phrases.push(s);
  }
  return phrases;
}

/* ─────────────────────────────────────────────
   Topic paragraph / text decoder
───────────────────────────────────────────── */

/*
  WinHelp topic blocks are 4 KB each. Each block:
    - 4 bytes: offset to next block (-1 = last)
    - 4 bytes: reserved
    - Records until end of block

  Each record starts with a BYTE type:
    0x20 = TextRecord  (paragraph header + text runs)
    0x01 = TopicHeader (begin of a new logical topic)
    0x02 = TableRecord
    etc.
*/

const BLOCK_SIZE = 4096;

function decodeTopicBlocks(topicData, phrases) {
  const blocks  = [];
  const size    = topicData.byteLength;
  let   pos     = 0;

  while (pos + 8 <= size) {
    const r        = new DataReader(topicData);
    r.seek(pos);
    const nextOff  = r.i32();  // offset to next block from start of |TOPIC
    const reserved = r.i32();

    const blockEnd = Math.min(pos + BLOCK_SIZE, size);
    const blockData = topicData.slice(pos + 8, blockEnd);
    blocks.push({ data: blockData, nextOff, startOff: pos });

    if (nextOff <= 0 || nextOff === pos) break;
    pos = nextOff >= size ? size : nextOff;
    if (pos >= size) break;
  }
  return blocks;
}

function decodeTextRecord(bytes, phrases) {
  /* Phrase substitution: bytes >= 0x80 reference phrases table */
  let text = '';
  let i    = 0;

  while (i < bytes.length) {
    const b = bytes[i++];

    if (b === 0x00) break;

    if (b >= 0x80) {
      /* Phrase reference */
      let idx = (b - 0x80) << 1;
      if (i < bytes.length) {
        const next = bytes[i];
        if (next & 0x01) {
          idx |= 0x01;
          i++;
        }
        idx >>= 1;
      } else {
        idx >>= 1;
      }
      if (phrases && idx < phrases.length) {
        text += phrases[idx];
      }
    } else if (b >= 0x20) {
      text += String.fromCharCode(b);
    } else {
      /* Control codes */
      switch (b) {
        case 0x0D: text += '\n'; break;
        case 0x0A: break;
        case 0x09: text += '\t'; break;
        default:   break;
      }
    }
  }
  return text;
}

/* ─────────────────────────────────────────────
   Main parser entry point
───────────────────────────────────────────── */
function parseHLP(arrayBuffer, onProgress) {
  const r = new DataReader(arrayBuffer);

  /* ── File header ── */
  const magic = r.u32();
  if (magic !== 0x00035F3F) {
    throw new Error(
      `Arquivo inválido: magic incorreto (0x${magic.toString(16).toUpperCase()}). ` +
      `Esperado: 0x35F3F.`
    );
  }

  onProgress(10, 'Lendo cabeçalho do arquivo…');

  const directoryStart = r.i32();
  const freeListStart  = r.i32();
  const fileSize       = r.i32();

  if (directoryStart <= 0 || directoryStart >= arrayBuffer.byteLength) {
    throw new Error('Estrutura de diretório inválida.');
  }

  /* ── Internal file directory (B+ tree) ── */
  onProgress(20, 'Lendo diretório interno…');

  let fileList;
  try {
    const tree = new BTreeReader(r, directoryStart);
    fileList   = tree.listFiles();
  } catch (e) {
    throw new Error(`Falha ao ler diretório: ${e.message}`);
  }

  if (fileList.length === 0) {
    throw new Error('Diretório vazio — arquivo HLP pode estar corrompido.');
  }

  /* Build lookup map */
  const fileMap = {};
  for (const f of fileList) fileMap[f.name] = f.fileOffset;

  onProgress(35, 'Lendo metadados…');

  /* ── |SYSTEM ── */
  let sysInfo = { title: '', version: 0 };
  if (fileMap['|SYSTEM'] != null) {
    try {
      const sr  = readInternalFile(r, fileMap['|SYSTEM']);
      sysInfo   = parseSystem(sr);
    } catch (_) { /* non-fatal */ }
  }

  /* ── |Phrases ── */
  onProgress(45, 'Lendo tabela de frases…');
  let phrases = [];
  if (fileMap['|Phrases'] != null) {
    try {
      const pr = readInternalFile(r, fileMap['|Phrases']);
      phrases  = parsePhrases(pr);
    } catch (_) { /* non-fatal */ }
  }

  /* ── |TOPIC ── */
  onProgress(55, 'Decodificando tópicos…');

  let topics = [];
  if (fileMap['|TOPIC'] != null) {
    try {
      const topicOffset = fileMap['|TOPIC'];
      r.seek(topicOffset);
      const _res  = r.i32();
      const tSize = r.i32();
      const topicBuf = arrayBuffer.slice(topicOffset + 8, topicOffset + 8 + tSize);
      topics = extractTopics(topicBuf, phrases, onProgress);
    } catch (e) {
      /* Fallback: return at least something */
      topics = [{ title: 'Erro ao decodificar', text: e.message, index: 0 }];
    }
  }

  if (topics.length === 0) {
    topics = [{ title: '(Sem tópicos)', text: 'Nenhum tópico encontrado neste arquivo.', index: 0 }];
  }

  onProgress(95, 'Finalizando…');

  return {
    title:    sysInfo.title || 'Sem título',
    version:  sysInfo.version,
    topics,
    fileList,
  };
}

/* ─────────────────────────────────────────────
   Topic extraction from |TOPIC data
───────────────────────────────────────────── */
function extractTopics(topicBuf, phrases, onProgress) {
  const topics  = [];
  const size    = topicBuf.byteLength;
  let   topicNo = 0;
  let   pos     = 0;

  /* Topics are stored in 4 KB blocks; each block can contain
     multiple paragraphs.  We do a linear scan for paragraph
     header records (type 0x01 starts a new topic, 0x20 is text). */

  while (pos < size) {
    /* Block header */
    if (pos + 8 > size) break;

    const blockView = new DataView(topicBuf);
    const nextBlock = blockView.getInt32(pos, true);       // offset of next block
    const blockUsed = blockView.getInt32(pos + 4, true);   // bytes used

    const blockEnd = Math.min(pos + BLOCK_SIZE, size);
    let   rPos     = pos + 8;

    while (rPos < blockEnd) {
      if (rPos >= size) break;
      const recType = blockView.getUint8(rPos++);

      if (recType === 0x01) {
        /* TopicHeader — begins a new logical topic */
        /* 8 bytes: blockSize, dataLen, prevTopic, nextTopic, topicNo, ... */
        if (rPos + 16 > blockEnd) break;
        rPos += 16; // skip topic header fields

        const topic = { title: '', paragraphs: [], index: topicNo++ };
        topics.push(topic);

      } else if (recType === 0x20) {
        /* TextRecord */
        if (rPos + 4 > blockEnd) break;

        const blockSize = blockView.getUint16(rPos, true); rPos += 2;
        const dataSize  = blockView.getUint16(rPos, true); rPos += 2;

        if (blockSize < 4 || rPos + blockSize - 4 > blockEnd) break;

        /* Paragraph attribute block (dataSize bytes) */
        const attrEnd = rPos + dataSize;

        /* Text block follows the attribute block */
        const textStart = attrEnd;
        const textEnd   = rPos + blockSize - 4;

        if (textEnd > blockEnd || textStart > textEnd) {
          rPos += blockSize - 4;
          continue;
        }

        const textBytes = new Uint8Array(topicBuf, textStart, textEnd - textStart);
        const text      = decodeTextRecord(textBytes, phrases).trim();

        rPos = textEnd;

        if (topics.length === 0) {
          topics.push({ title: '', paragraphs: [], index: topicNo++ });
        }
        const cur = topics[topics.length - 1];

        if (!cur.title && text) {
          cur.title = text.split('\n')[0].substring(0, 120);
        }
        if (text) cur.paragraphs.push(text);

      } else if (recType === 0x00) {
        break; // padding
      } else {
        /* Unknown record: try to skip using block-size at next 2 bytes */
        if (rPos + 2 <= blockEnd) {
          const skip = blockView.getUint16(rPos, true);
          if (skip >= 2 && skip <= blockEnd - rPos) { rPos += skip; continue; }
        }
        break;
      }
    }

    /* Advance to next block */
    if (nextBlock > pos && nextBlock < size) {
      pos = nextBlock;
    } else {
      pos += BLOCK_SIZE;
    }

    if (topics.length % 20 === 0 && topics.length > 0) {
      onProgress(55 + Math.min(35, topics.length / 5), `${topics.length} tópicos encontrados…`);
    }
  }

  /* Post-process: remove empty topics, fill default titles */
  return topics
    .filter(t => t.title || (t.paragraphs && t.paragraphs.length))
    .map((t, i) => ({
      title: t.title || `Tópico ${i + 1}`,
      text:  (t.paragraphs || []).join('\n\n'),
      index: i,
    }));
}

/* Export */
if (typeof module !== 'undefined') module.exports = { parseHLP };
