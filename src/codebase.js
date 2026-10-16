// Codebase search by meaning. The project is cut into chunks of a few dozen lines; a small
// embedding model (all-MiniLM-L6-v2, run in the window by transformers.js, both downloaded on first use) turns each into a
// vector, and a search ranks chunks by how close they are to the question, merged with a keyword
// ranking so exact names still win. The model and its runtime are downloaded once into
// userData/models; the index is kept per folder in userData/index and only changed files are redone.
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const MODEL = 'Xenova/all-MiniLM-L6-v2';
const ORT = '1.31.0-dev.20260914-8d85527a0'; // the onnxruntime-web build transformers.js 4.3.1 expects
const DOWNLOADS = [
  { file: `${MODEL}/config.json`, url: `https://huggingface.co/${MODEL}/resolve/main/config.json` },
  { file: `${MODEL}/tokenizer.json`, url: `https://huggingface.co/${MODEL}/resolve/main/tokenizer.json` },
  { file: `${MODEL}/tokenizer_config.json`, url: `https://huggingface.co/${MODEL}/resolve/main/tokenizer_config.json` },
  { file: `${MODEL}/onnx/model_quantized.onnx`, url: `https://huggingface.co/${MODEL}/resolve/main/onnx/model_quantized.onnx` },
  { file: 'transformers.min.js', url: 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.min.js' },
  { file: 'ort/ort-wasm-simd-threaded.asyncify.mjs', url: `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT}/dist/ort-wasm-simd-threaded.asyncify.mjs` },
  { file: 'ort/ort-wasm-simd-threaded.asyncify.wasm', url: `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT}/dist/ort-wasm-simd-threaded.asyncify.wasm` },
];
const DIM = 384;

const CODE_EXT = new Set(
  'js mjs cjs jsx ts tsx mts cts vue svelte astro py pyi rb php go rs java kt kts scala swift m mm c h cc cpp cxx hpp hh cs fs fsx vb lua pl pm r jl dart ex exs erl hrl clj cljs elm hs ml mli nim zig sol sql graphql gql proto sh bash zsh ps1 psm1 bat cmd html htm css scss sass less md mdx rst txt yaml yml toml ini cfg conf json xml gradle tf hcl dockerfile makefile cmake'.split(' ')
);
const SKIP_NAMES = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|composer\.lock|Gemfile\.lock|go\.sum)$|\.min\.(js|css)$|\.map$/i;
const MAX_FILE = 300 * 1024;
const MAX_FILES = 20000;
const MAX_CHUNKS = 60000;

let baseDir = null;
const setBaseDir = (d) => (baseDir = d);
const modelsDir = () => path.join(baseDir, 'models');

// ---------- the model

const modelReady = () => DOWNLOADS.every((d) => fs.existsSync(path.join(modelsDir(), d.file)));

let downloading = null;
function downloadModel(netFetch, onProgress) {
  if (downloading) return downloading;
  downloading = (async () => {
    const sizes = { '/onnx/model_quantized.onnx': 23e6, '.wasm': 28e6 };
    const expect = (f) => Object.entries(sizes).find(([k]) => f.endsWith(k.replace(/^\//, '')))?.[1] || 5e5;
    const total = DOWNLOADS.reduce((n, d) => n + expect(d.file), 0);
    let done = 0;
    for (const d of DOWNLOADS) {
      const dest = path.join(modelsDir(), d.file);
      if (fs.existsSync(dest)) {
        done += expect(d.file);
        continue;
      }
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      const res = await netFetch(d.url);
      if (!res.ok) throw new Error(`Couldn't download ${path.basename(d.file)} (${res.status}).`);
      const tmp = dest + '.part';
      const out = fs.createWriteStream(tmp);
      const reader = res.body.getReader();
      let last = 0;
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) break;
        out.write(Buffer.from(value));
        done += value.length;
        if (Date.now() - last > 250) {
          last = Date.now();
          onProgress(Math.min(0.99, done / total));
        }
      }
      await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
      await fsp.rename(tmp, dest);
    }
    onProgress(1);
    return true;
  })().finally(() => (downloading = null));
  return downloading;
}

// ---------- chunks

function chunkFile(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    const n = i - start + 1;
    const blank = !lines[i].trim();
    if ((n >= 30 && blank) || n >= 60 || i === lines.length - 1) {
      const body = lines.slice(start, i + 1).join('\n');
      if (body.trim()) out.push({ start: start + 1, end: i + 1, text: body });
      start = i + 1;
    }
  }
  return out;
}

// Words for the keyword ranking: identifiers split at camelCase, snake_case and digits.
function words(text) {
  const out = [];
  for (const raw of text.match(/[A-Za-z_][A-Za-z0-9_]*/g) || []) {
    const lower = raw.toLowerCase();
    if (lower.length > 1) out.push(lower);
    const parts = raw.split(/_|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/).filter(Boolean);
    if (parts.length > 1) for (const p of parts) if (p.length > 1) out.push(p.toLowerCase());
  }
  return out;
}

const hashOf = (s) => crypto.createHash('sha1').update(s).digest('base64').slice(0, 16);

// ---------- one folder's index

class Index {
  constructor(root) {
    this.root = root; // the workspace's folders: [{ key, dir }]
    this.file = path.join(baseDir, 'index', hashOf(root.map((r) => r.dir).join('|')));
    this.files = new Map(); // rel -> { mtime, size, chunks: [chunk] }
    this.vectors = new Map(); // chunk hash -> Float32Array
    this.loaded = false;
    this.scanning = null;
    this.saveTimer = null;
  }

  async load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const meta = JSON.parse(await fsp.readFile(this.file + '.json', 'utf8'));
      const buf = await fsp.readFile(this.file + '.bin');
      const all = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
      meta.hashes.forEach((h, i) => this.vectors.set(h, all.slice(i * DIM, (i + 1) * DIM)));
      for (const [rel, f] of Object.entries(meta.files)) this.files.set(rel, f);
    } catch {}
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow().catch(() => {}), 3000);
  }

  async saveNow() {
    clearTimeout(this.saveTimer);
    const used = new Set();
    for (const f of this.files.values()) for (const c of f.chunks) used.add(c.hash);
    const hashes = [...used].filter((h) => this.vectors.has(h));
    const all = new Float32Array(hashes.length * DIM);
    hashes.forEach((h, i) => all.set(this.vectors.get(h), i * DIM));
    for (const h of [...this.vectors.keys()]) if (!used.has(h)) this.vectors.delete(h);
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    await fsp.writeFile(this.file + '.bin', Buffer.from(all.buffer));
    await fsp.writeFile(this.file + '.json', JSON.stringify({ hashes, files: Object.fromEntries(this.files) }));
  }

  abs(rel) {
    const m = /^(⟦[^⟧]+⟧)\/(.*)$/.exec(rel);
    const r = m ? this.root.find((x) => x.key === m[1]) : this.root[0];
    return r && path.join(r.dir, m ? m[2] : rel);
  }

  // Brings the chunks up to date with the files on disk (only reading files that changed).
  scan(listFiles) {
    if (this.scanning) return this.scanning;
    this.scanning = (async () => {
      await this.load();
      const rels = (await listFiles()).filter((rel) => {
        const base = rel.split('/').pop().toLowerCase();
        const ext = base.includes('.') ? base.split('.').pop() : base;
        return (CODE_EXT.has(ext) || base === 'dockerfile' || base === 'makefile') && !SKIP_NAMES.test(rel);
      });
      const keep = new Set(rels.slice(0, MAX_FILES));
      for (const rel of [...this.files.keys()]) if (!keep.has(rel)) this.files.delete(rel);
      let count = 0;
      for (const rel of keep) {
        const abs = this.abs(rel);
        let st;
        try {
          st = await fsp.stat(abs);
        } catch {
          this.files.delete(rel);
          continue;
        }
        const prev = this.files.get(rel);
        if (prev && prev.mtime === st.mtimeMs && prev.size === st.size) {
          count += prev.chunks.length;
          continue;
        }
        if (st.size > MAX_FILE || count > MAX_CHUNKS) {
          this.files.set(rel, { mtime: st.mtimeMs, size: st.size, chunks: [] });
          continue;
        }
        let text;
        try {
          text = await fsp.readFile(abs, 'utf8');
        } catch {
          continue;
        }
        const avgLine = text.length / (text.split('\n').length || 1);
        const chunks = text.includes('\0') || avgLine > 300 ? [] : chunkFile(text).map((c) => ({ start: c.start, end: c.end, hash: hashOf(rel + '\n' + c.text) }));
        this.files.set(rel, { mtime: st.mtimeMs, size: st.size, chunks });
        count += chunks.length;
      }
      this.save();
    })().finally(() => (this.scanning = null));
    return this.scanning;
  }

  status() {
    let chunks = 0;
    let embedded = 0;
    let files = 0;
    for (const f of this.files.values()) {
      if (f.chunks.length) files++;
      chunks += f.chunks.length;
      for (const c of f.chunks) if (this.vectors.has(c.hash)) embedded++;
    }
    return { files, chunks, embedded };
  }

  async chunkText(rel, c) {
    try {
      const lines = (await fsp.readFile(this.abs(rel), 'utf8')).split(/\r?\n/);
      return lines.slice(c.start - 1, c.end).join('\n');
    } catch {
      return null;
    }
  }

  // The next chunks that still need a vector, with the text to embed.
  async pending(n) {
    const out = [];
    const seen = new Set();
    for (const [rel, f] of this.files) {
      for (const c of f.chunks) {
        if (this.vectors.has(c.hash) || seen.has(c.hash)) continue;
        const text = await this.chunkText(rel, c);
        if (text == null) continue;
        seen.add(c.hash);
        out.push({ hash: c.hash, text: `${rel}\n${text}`.slice(0, 1200) }); // the model reads about 256 tokens
        if (out.length >= n) return out;
      }
    }
    return out;
  }

  put(entries) {
    for (const e of entries) if (e.vector && e.vector.length === DIM) this.vectors.set(e.hash, Float32Array.from(e.vector));
    this.save();
  }

  // Ranks chunks by meaning (when there's a vector for the question) and by keywords, merged.
  async search(query, qvec, k = 12) {
    await this.load();
    const all = [];
    for (const [rel, f] of this.files) for (const c of f.chunks) all.push({ rel, ...c });
    if (!all.length) return [];
    const byMeaning = [];
    if (qvec && qvec.length === DIM) {
      for (const c of all) {
        const v = this.vectors.get(c.hash);
        if (!v) continue;
        let s = 0;
        for (let i = 0; i < DIM; i++) s += v[i] * qvec[i];
        byMeaning.push({ c, s });
      }
      byMeaning.sort((a, b) => b.s - a.s);
    }
    const byWords = await this.keywordRank(query, all);
    const score = new Map();
    const add = (list, weight) => list.slice(0, 200).forEach((x, i) => score.set(x.c, (score.get(x.c) || 0) + weight / (60 + i)));
    add(byMeaning, 1);
    add(byWords, byMeaning.length ? 0.8 : 1);
    const ranked = [...score].sort((a, b) => b[1] - a[1]).map(([c]) => c);
    // At most three chunks from one file, so one big file doesn't crowd out the rest.
    const perFile = new Map();
    const out = [];
    for (const c of ranked) {
      const n = perFile.get(c.rel) || 0;
      if (n >= 3) continue;
      perFile.set(c.rel, n + 1);
      const text = await this.chunkText(c.rel, c);
      if (text == null) continue;
      out.push({ rel: c.rel, start: c.start, end: c.end, text });
      if (out.length >= k) break;
    }
    return out;
  }

  // BM25 over the chunks that contain any of the question's words. Reads only those files.
  async keywordRank(query, all) {
    const STOP = new Set('the a an and or of to in on for is are was be it this that with how where what which do does we our you your my i me from by as at can should when why there here use used using code file files function'.split(' '));
    const terms = [...new Set(words(query))].filter((t) => !STOP.has(t));
    if (!terms.length) return [];
    const cache = new Map();
    const docs = [];
    for (const c of all) {
      if (!cache.has(c.rel)) {
        let text = '';
        try {
          text = await fsp.readFile(this.abs(c.rel), 'utf8');
        } catch {}
        cache.set(c.rel, text.toLowerCase().includes(terms[0]) || terms.some((t) => text.toLowerCase().includes(t)) ? text.split(/\r?\n/) : null);
      }
      const lines = cache.get(c.rel);
      if (!lines) continue;
      const w = words(c.rel + '\n' + lines.slice(c.start - 1, c.end).join('\n'));
      const tf = new Map();
      for (const x of w) if (terms.includes(x)) tf.set(x, (tf.get(x) || 0) + 1);
      if (tf.size) docs.push({ c, tf, len: w.length });
    }
    const N = all.length;
    const avg = docs.reduce((n, d) => n + d.len, 0) / (docs.length || 1);
    const df = new Map(terms.map((t) => [t, docs.filter((d) => d.tf.has(t)).length]));
    for (const d of docs) {
      let s = 0;
      for (const [t, f] of d.tf) {
        const idf = Math.log(1 + (N - df.get(t) + 0.5) / (df.get(t) + 0.5));
        s += (idf * f * 2.2) / (f + 1.2 * (0.25 + 0.75 * (d.len / avg)));
      }
      d.s = s;
    }
    return docs.sort((a, b) => b.s - a.s);
  }
}

module.exports = { setBaseDir, modelsDir, modelReady, downloadModel, Index, chunkFile, words, MODEL };
