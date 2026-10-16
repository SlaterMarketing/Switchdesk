// Turns a document the user attaches to a chat into text the agent can read: Word, PowerPoint,
// Excel, OpenDocument, PDF, RTF, HTML and plain text or code. Images are passed through as images.
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pathToFileURL } = require('url');
const { htmlToText } = require('./webpage');

const MAX_TEXT = 120000;
const MAX_FILE = 50 * 1024 * 1024;
const MAX_IMAGE = 5 * 1024 * 1024;
const IMAGES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

// ---------- a minimal zip reader (Office and OpenDocument files are zips of XML)

function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("It isn't a valid Office file.");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count && buf.readUInt32LE(p) === 0x02014b50; i++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    entries.set(name, { method, size, local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return {
    names: [...entries.keys()],
    read(name) {
      const e = entries.get(name);
      if (!e) return null;
      const start = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28);
      const data = buf.slice(start, start + e.size);
      if (e.method === 0) return data.toString('utf8');
      if (e.method === 8) return zlib.inflateRawSync(data).toString('utf8');
      return null;
    },
  };
}

const decodeXml = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e.toLowerCase()];
  });

const tidy = (s) => s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

// ---------- Word

function docxText(zip) {
  const parts = ['word/document.xml', ...zip.names.filter((n) => /^word\/(footnotes|endnotes)\.xml$/.test(n))];
  return tidy(parts.map((n) => wordXml(zip.read(n) || '')).join('\n\n'));
}

function wordXml(xml) {
  let out = '';
  let line = '';
  let heading = 0;
  const re = /<w:t(?: [^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br[^>]*\/>|<\/w:p>|<\/w:tc>|<\/w:tr>|<w:pStyle w:val="([^"]+)"\/>/g;
  for (const m of xml.matchAll(re)) {
    const tag = m[0];
    if (m[1] != null && tag.startsWith('<w:t')) line += decodeXml(m[1]);
    else if (tag === '<w:tab/>') line += '\t';
    else if (tag.startsWith('<w:br')) line += '\n';
    else if (m[2] != null) {
      const h = /^(?:Heading|heading)\s*(\d)$/.exec(m[2]) || (/^Title$/.test(m[2]) ? [0, '1'] : null);
      heading = h ? Number(h[1]) : 0;
    } else if (tag === '</w:p>') {
      out += (heading && line.trim() ? '#'.repeat(heading) + ' ' : '') + line + '\n';
      line = '';
      heading = 0;
    } else if (tag === '</w:tc>') out = out.replace(/\n$/, '') + '\t';
    else if (tag === '</w:tr>') out += '\n';
  }
  return out + line;
}

// ---------- PowerPoint

function pptxText(zip) {
  const slides = zip.names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => Number(/(\d+)\.xml$/.exec(a)[1]) - Number(/(\d+)\.xml$/.exec(b)[1]));
  return tidy(
    slides
      .map((n, i) => {
        const xml = zip.read(n) || '';
        const paras = (xml.match(/<a:p>[\s\S]*?<\/a:p>/g) || []).map((p) => decodeXml((p.match(/<a:t>([^<]*)<\/a:t>/g) || []).map((t) => t.slice(5, -6)).join(''))).filter((t) => t.trim());
        const notesName = `ppt/notesSlides/notesSlide${/(\d+)\.xml$/.exec(n)[1]}.xml`;
        const notes = zip.read(notesName);
        const noteText = notes ? decodeXml((notes.match(/<a:t>([^<]*)<\/a:t>/g) || []).map((t) => t.slice(5, -6)).join(' ')).trim() : '';
        return `## Slide ${i + 1}\n${paras.join('\n')}${noteText ? `\n\nSpeaker notes: ${noteText}` : ''}`;
      })
      .join('\n\n')
  );
}

// ---------- Excel

function xlsxText(zip) {
  const shared = [];
  const ss = zip.read('xl/sharedStrings.xml');
  if (ss) for (const si of ss.match(/<si>[\s\S]*?<\/si>/g) || []) shared.push(decodeXml((si.match(/<t(?: [^>]*)?>([^<]*)<\/t>/g) || []).map((t) => t.replace(/<[^>]+>/g, '')).join('')));
  const wb = zip.read('xl/workbook.xml') || '';
  const rels = zip.read('xl/_rels/workbook.xml.rels') || '';
  const target = (rid) => {
    const m = new RegExp(`Id="${rid}"[^>]*Target="([^"]+)"|Target="([^"]+)"[^>]*Id="${rid}"`).exec(rels);
    const t = m && (m[1] || m[2]);
    return t ? (t.startsWith('/') ? t.slice(1) : 'xl/' + t.replace(/^\.\//, '')) : null;
  };
  const sheets = [...wb.matchAll(/<sheet [^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)].map((m) => ({ name: decodeXml(m[1]), file: target(m[2]) }));
  if (!sheets.length) for (const n of zip.names.filter((x) => /^xl\/worksheets\/sheet\d+\.xml$/.test(x))) sheets.push({ name: path.basename(n, '.xml'), file: n });
  const col = (ref) => {
    let n = 0;
    for (const ch of /^[A-Z]+/.exec(ref)[0]) n = n * 26 + ch.charCodeAt(0) - 64;
    return n - 1;
  };
  const out = [];
  for (const s of sheets) {
    const xml = (s.file && zip.read(s.file)) || '';
    const rows = [];
    for (const row of xml.match(/<row[^>]*>[\s\S]*?<\/row>/g) || []) {
      const cells = [];
      for (const c of row.match(/<c [^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) || []) {
        const ref = /r="([A-Z]+)\d+"/.exec(c);
        const type = (/ t="(\w+)"/.exec(c) || [])[1];
        let v = (/<v>([\s\S]*?)<\/v>/.exec(c) || [])[1];
        if (type === 's') v = shared[Number(v)];
        else if (type === 'inlineStr') v = (c.match(/<t(?: [^>]*)?>([^<]*)<\/t>/g) || []).map((t) => t.replace(/<[^>]+>/g, '')).join('');
        else if (type === 'b') v = v === '1' ? 'TRUE' : 'FALSE';
        if (v == null) continue;
        cells[ref ? col(ref[1]) : cells.length] = decodeXml(String(v));
      }
      if (cells.length) rows.push(Array.from(cells, (x) => (x == null ? '' : /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x)).join(','));
      if (rows.length >= 5000) {
        rows.push('… (more rows not shown)');
        break;
      }
    }
    out.push(`## Sheet: ${s.name}\n${rows.join('\n')}`);
  }
  return out.join('\n\n').trim();
}

// ---------- OpenDocument (LibreOffice)

function odfText(zip) {
  const xml = zip.read('content.xml') || '';
  return tidy(
    decodeXml(
      xml
        .replace(/<text:tab\/>/g, '\t')
        .replace(/<text:line-break\/>/g, '\n')
        .replace(/<text:s(?: text:c="(\d+)")?\/>/g, (m, n) => ' '.repeat(Number(n || 1)))
        .replace(/<\/text:p>(?=(?:\s|<\/?text:[^>]*>)*<\/table:table-cell>)/g, '')
        .replace(/<\/table:table-cell>/g, '\t')
        .replace(/<\/(text:p|text:h|table:table-row)>/g, '\n')
        .replace(/<[^>]+>/g, '')
    )
  );
}

// ---------- RTF

function rtfText(raw) {
  // Drop header groups (fonts, colours, styles, metadata), which hold no document text.
  let s = '';
  for (let i = 0; i < raw.length; i++) {
    const skip = raw[i] === '{' && /^\{\\(\*|fonttbl|colortbl|stylesheet|info|pict)/.test(raw.slice(i, i + 12));
    if (!skip) {
      s += raw[i];
      continue;
    }
    let depth = 0;
    for (; i < raw.length; i++) {
      if (raw[i] === '\\') i++;
      else if (raw[i] === '{') depth++;
      else if (raw[i] === '}' && --depth === 0) break;
    }
  }
  s = s
    .replace(/\\par[d]?\b ?/g, '\n')
    .replace(/\\tab\b ?/g, '\t')
    .replace(/\\'([0-9a-f]{2})/gi, (m, h) => Buffer.from([parseInt(h, 16)]).toString('latin1'))
    .replace(/\\u(-?\d+)\??/g, (m, n) => String.fromCharCode(Number(n) < 0 ? Number(n) + 65536 : Number(n)))
    .replace(/\\[a-z]+-?\d* ?/gi, '')
    .replace(/[{}]/g, '');
  return tidy(s);
}

// ---------- PDF

async function pdfText(buf) {
  // Unpacked from the app archive in builds, so Node's module loader can read it.
  const pdfjs = await import(pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')).href);
  const task = pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: false, isEvalSupported: false, disableFontFace: true, verbosity: 0 });
  const doc = await task.promise;
  const pages = [];
  let total = 0;
  for (let i = 1; i <= doc.numPages && total < MAX_TEXT; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let text = '';
    for (const it of content.items) text += (it.str || '') + (it.hasEOL ? '\n' : ' ');
    text = tidy(text.replace(/ +/g, ' '));
    total += text.length;
    pages.push(`## Page ${i}\n${text}`);
  }
  const n = doc.numPages;
  await task.destroy();
  const body = pages.join('\n\n');
  if (!body.replace(/## Page \d+/g, '').trim()) throw new Error('This PDF has no text in it (it may be scanned images). Attach it as screenshots instead.');
  return { text: body, pages: n };
}

// ---------- plain text

function looksBinary(buf) {
  const sample = buf.slice(0, 8000);
  let odd = 0;
  for (const b of sample) if (b === 0) return true;
  else if (b < 9 || (b > 13 && b < 32)) odd++;
  return odd > sample.length * 0.1;
}

// Returns { kind: 'image', name, mediaType, data } or { kind: 'doc', name, file, text, truncated, note }.
async function extract(file) {
  const name = path.basename(file);
  const ext = path.extname(file).toLowerCase();
  const stat = fs.statSync(file);
  if (stat.isDirectory()) throw new Error(`${name} is a folder. Add it to the workspace instead (File → Add Folder to Workspace).`);
  if (IMAGES[ext]) {
    if (stat.size > MAX_IMAGE) throw new Error(`${name} is over 5 MB. Try a smaller image.`);
    return { kind: 'image', name, mediaType: IMAGES[ext], data: fs.readFileSync(file).toString('base64') };
  }
  if (stat.size > MAX_FILE) throw new Error(`${name} is over 50 MB, too big to attach.`);
  const buf = fs.readFileSync(file);
  let text;
  let note = '';
  if (ext === '.docx' || ext === '.docm' || ext === '.dotx') text = docxText(readZip(buf));
  else if (ext === '.pptx' || ext === '.ppsx') text = pptxText(readZip(buf));
  else if (ext === '.xlsx' || ext === '.xlsm') text = xlsxText(readZip(buf));
  else if (['.odt', '.ods', '.odp'].includes(ext)) text = odfText(readZip(buf));
  else if (ext === '.pdf') {
    const r = await pdfText(buf);
    text = r.text;
    note = `${r.pages} page${r.pages === 1 ? '' : 's'}`;
  } else if (ext === '.rtf') text = rtfText(buf.toString('latin1'));
  else if (['.doc', '.xls', '.ppt'].includes(ext)) throw new Error(`${name} is an old-style Office file. Save it as ${ext}x in Office and attach that.`);
  else if (looksBinary(buf)) throw new Error(`${name} isn't a document Switchdesk can read. Word, PowerPoint, Excel, PDF, RTF, OpenDocument and text files work.`);
  else {
    text = buf.toString('utf8').replace(/^﻿/, '');
    if (ext === '.html' || ext === '.htm') text = htmlToText(text).text;
  }
  if (!text || !text.trim()) throw new Error(`${name} has no text in it.`);
  const truncated = text.length > MAX_TEXT;
  return { kind: 'doc', name, file, text: truncated ? text.slice(0, MAX_TEXT) : text, truncated, note };
}

module.exports = { extract, readZip, docxText, xlsxText, pptxText };
