// backfill-clients-only.mjs
// Scans: clients/processed/clients/** and merges into data/clients-manifest.json
// Industry is always "clients". Does not touch any other keys.

import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';

const CWD = process.cwd();
const SUBROOT        = path.resolve(CWD, 'clients', 'processed', 'clients'); // <-- only this subtree
const PUBLIC_PREFIX  = '/clients/processed/clients';                          // public URL prefix
const MANIFEST_PATH  = path.resolve(CWD, 'data', 'clients-manifest.json');

function toSlug(s='') {
  return String(s)
    .normalize('NFKD')
    .replace(/['’]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

async function loadManifest() {
  try {
    const txt = await fs.readFile(MANIFEST_PATH, 'utf8');
    const json = JSON.parse(txt);
    json.industries ||= {};
    json.industries.clients ||= {}; // ensure industry exists
    return json;
  } catch {
    return { generatedAt: new Date().toISOString(), industries: { clients: {} } };
  }
}

async function saveManifest(manifest) {
  manifest.generatedAt = new Date().toISOString();
  await fs.mkdir(path.dirname(MANIFEST_PATH), { recursive: true });
  await fs.writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8');
}

// Parse "<name>_<width>.ext" → { baseName, width } or fallback no width
function parseNameWidth(filename) {
  const ext = path.extname(filename).slice(1).toLowerCase(); // no dot
  const base = path.basename(filename, '.' + ext);
  const m = base.match(/^(.*)_([0-9]{2,5})$/);
  if (m) return { baseName: toSlug(m[1]), width: Number(m[2]), ext };
  return { baseName: toSlug(base), width: null, ext };
}

function isAvif(ext){ return ext === 'avif'; }
function isJpgLike(ext){ return ['jpg','jpeg','png','webp'].includes(ext); }

function ensureArray(manifest, client, project) {
  manifest.industries.clients[client] ||= {};
  manifest.industries.clients[client][project] ||= [];
  return manifest.industries.clients[client][project];
}

async function run(){
  console.log('Backfilling from:', SUBROOT);

  // Collect common raster formats (what your processor writes)
  const files = await fg(['**/*.{avif,AVIF,jpg,JPG,jpeg,JPEG,png,PNG,webp,WEBP}'], {
    cwd: SUBROOT,
    absolute: false,
    dot: false,
    caseSensitiveMatch: false
  });

  if (!files.length) {
    console.warn('No images found under', SUBROOT);
    return;
  }

  const manifest = await loadManifest();

  // Buckets by: clients/<client>/<project>/<baseName>
  const buckets = new Map();

  for (const rel of files) {
    // Expect at least: <client>/<project>/<filename>
    const parts = rel.split(path.sep);
    if (parts.length < 3) continue;

    const [clientRaw, projectRaw, filename] = parts.slice(-3);
    const { baseName, width, ext } = parseNameWidth(filename);

    const client = toSlug(clientRaw);
    const project = toSlug(projectRaw);
    const baseKey = `clients/${client}/${project}/${baseName}`;

    if (!buckets.has(baseKey)) {
      buckets.set(baseKey, {
        client, project,
        base: baseKey,
        alt: baseName,
        widths: new Set(),
        avif: new Map(),       // width -> url
        jpgLike: new Map()     // width -> url (jpg/jpeg/png/webp)
      });
    }

    const b = buckets.get(baseKey);

    // Build a public URL that respects original (possibly spaced) folder/file names
    const url = `${PUBLIC_PREFIX}/` +
      [clientRaw, projectRaw, filename].map(encodeURIComponent).join('/');

    // If width missing (rare for processed outputs), skip adding width; still allow asset with a fallback width later
    if (width != null) b.widths.add(width);

    if (isAvif(ext)) {
      const key = width != null ? String(width) : 'orig';
      b.avif.set(key, url);
    } else if (isJpgLike(ext)) {
      const key = width != null ? String(width) : 'orig';
      b.jpgLike.set(key, url);
    }
  }

  let added = 0, updated = 0;

  for (const [, b] of buckets) {
    const arr = ensureArray(manifest, b.client, b.project);

    // Normalize widths → numeric sort
    const widthsSorted = Array.from(b.widths).map(Number).sort((a,b)=>a-b);

    // Build variants objects:
    // - AVIF: keep all numeric widths (ignore 'orig' if we have any numeric)
    const avifObj = {};
    const avifNumeric = [...b.avif.keys()].filter(k=>/^\d+$/.test(k)).map(Number).sort((a,b)=>a-b);
    if (avifNumeric.length) {
      for (const w of avifNumeric) avifObj[String(w)] = b.avif.get(String(w));
    } else if (b.avif.has('orig')) {
      // If only 'orig', treat it as largest width fallback
      avifObj['1600'] = b.avif.get('orig');
      if (!widthsSorted.length) widthsSorted.push(1600);
    }

    // - JPG-like: keep only largest numeric width, else 'orig' as 1600
    let jpgObj = {};
    const jpgNumeric = [...b.jpgLike.keys()].filter(k=>/^\d+$/.test(k)).map(Number).sort((a,b)=>a-b);
    if (jpgNumeric.length) {
      const largest = jpgNumeric[jpgNumeric.length - 1];
      jpgObj[String(largest)] = b.jpgLike.get(String(largest));
    } else if (b.jpgLike.has('orig')) {
      jpgObj['1600'] = b.jpgLike.get('orig');
      if (!widthsSorted.length) widthsSorted.push(1600);
    }

    // Merge into manifest
    const idx = arr.findIndex(e => e.base === b.base);
    if (idx === -1) {
      arr.push({
        base: b.base,
        alt: b.alt,
        widths: Array.from(new Set(widthsSorted)).sort((a,b)=>a-b),
        variants: { avif: avifObj, jpg: jpgObj }
      });
      added++;
    } else {
      const cur = arr[idx];
      // widths
      const merged = new Set([...(cur.widths || []), ...widthsSorted]);
      cur.widths = Array.from(merged).sort((a,b)=>a-b);

      // variants
      cur.variants ||= { avif:{}, jpg:{} };
      cur.variants.avif ||= {};
      cur.variants.jpg  ||= {};

      Object.assign(cur.variants.avif, avifObj);

      // keep only largest JPG overall
      const allJ = [...Object.keys(cur.variants.jpg), ...Object.keys(jpgObj)].map(Number).filter(n=>!Number.isNaN(n)).sort((a,b)=>a-b);
      if (allJ.length) {
        const largest = String(allJ[allJ.length-1]);
        const mergedJ = { ...cur.variants.jpg, ...jpgObj };
        cur.variants.jpg = { [largest]: mergedJ[largest] };
      } else if (Object.keys(cur.variants.jpg).length === 0 && Object.keys(jpgObj).length === 1) {
        cur.variants.jpg = { ...jpgObj };
      }

      if (!cur.alt) cur.alt = b.alt;
      updated++;
    }
  }

  await saveManifest(manifest);
  console.log(`✅ Done. Added: ${added}, Updated: ${updated}. → ${path.relative(CWD, MANIFEST_PATH)}`);
}

run().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
