// backfill-clients-nested.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';

const CWD = process.cwd();
const SUBROOT       = path.resolve(CWD, 'clients', 'processed', 'clients'); // only this subtree
const PUBLIC_PREFIX = '/clients/processed/clients';
const MANIFEST_PATH = path.resolve(CWD, 'data', 'clients-manifest.json');

const DEBUG = true;

function toSlug(s='') {
  return String(s)
    .normalize('NFKD')
    .replace(/['’]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}
const isAvif   = (e) => e === 'avif';
const isJpgish = (e) => ['jpg','jpeg','png','webp'].includes(e);

// ALWAYS split on / or \ so it works on Windows + POSIX
function splitParts(relPath) {
  return relPath.replace(/\\/g, '/').split('/');
}

function parseNameWidth(filename) {
  const ext = path.extname(filename).slice(1).toLowerCase();
  const base = path.basename(filename, '.' + ext);
  const m = base.match(/^(.*)_([0-9]{2,5})$/);
  if (m) return { baseName: toSlug(m[1]), width: Number(m[2]), ext };
  return { baseName: toSlug(base), width: null, ext };
}

async function loadManifest() {
  try {
    const txt = await fs.readFile(MANIFEST_PATH, 'utf8');
    const j = JSON.parse(txt);
    j.industries ||= {};
    j.industries.clients ||= {};
    return j;
  } catch {
    return { generatedAt: new Date().toISOString(), industries: { clients:{} } };
  }
}
async function saveManifest(m) {
  m.generatedAt = new Date().toISOString();
  await fs.mkdir(path.dirname(MANIFEST_PATH), { recursive: true });
  await fs.writeFile(MANIFEST_PATH, JSON.stringify(m, null, 2), 'utf8');
}

function ensureArray(manifest, client, project) {
  manifest.industries.clients[client] ||= {};
  manifest.industries.clients[client][project] ||= [];
  return manifest.industries.clients[client][project];
}

function summarize(list, n=10){
  const arr = [...list];
  const head = arr.slice(0,n).map(x=>'  - '+x).join('\n');
  return arr.length>n ? head+`\n  … (+${arr.length-n} more)` : head;
}

async function run(){
  console.log('Backfilling from:', SUBROOT);
  const manifest = await loadManifest();

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

  // Bucket key: clients/<client>/<project[-album...]>/<baseName>
  const buckets = new Map();
  const seenGroups = new Set();

  for (const relRaw of files) {
    const parts = splitParts(relRaw);
    if (parts.length < 3) continue;

    const clientRaw  = parts[0];
    const projectRaw = parts[1];
    const midParts   = parts.length > 3 ? parts.slice(2, -1) : []; // optional album path
    const filename   = parts[parts.length - 1];

    const { baseName, width, ext } = parseNameWidth(filename);

    const client  = toSlug(clientRaw);
    const project = toSlug(projectRaw + (midParts.length ? '-' + midParts.join('-') : ''));

    // public URL preserves original folder names (with encoding), including album parts
    const url = `${PUBLIC_PREFIX}/` + [clientRaw, projectRaw, ...midParts, filename].map(encodeURIComponent).join('/');

    const baseKey = `clients/${client}/${project}/${baseName}`;
    if (!buckets.has(baseKey)) {
      buckets.set(baseKey, {
        client, project,
        base: baseKey,
        alt: baseName,
        widths: new Set(),
        avif: new Map(),   // widthKey -> url
        jpg:  new Map()    // widthKey -> url (jpg/jpeg/png/webp)
      });
    }
    const b = buckets.get(baseKey);
    const wKey = width != null ? String(width) : 'orig';

    if (width != null) b.widths.add(width);
    if (isAvif(ext))   b.avif.set(wKey, url);
    if (isJpgish(ext)) b.jpg.set(wKey, url);

    seenGroups.add(`${client}/${project}`);
  }

  if (DEBUG) {
    console.log(`Scanned ${files.length} file(s). Groups seen: ${seenGroups.size}`);
    console.log(summarize(seenGroups, 20));
  }

  let added = 0, updated = 0;

  for (const [, b] of buckets) {
    const arr = ensureArray(manifest, b.client, b.project);

    // Normalize widths; if none, inject 1600 so the page has a canonical size
    let widthsSorted = Array.from(b.widths).map(Number).sort((a,b)=>a-b);
    if (!widthsSorted.length && (b.avif.has('orig') || b.jpg.has('orig'))) {
      widthsSorted = [1600];
    }

    // Build variants objects:
    // AVIF: keep all numeric widths (or map 'orig' -> 1600)
    const avifObj = {};
    const avifNumeric = [...b.avif.keys()].filter(k=>/^\d+$/.test(k)).map(Number).sort((a,b)=>a-b);
    if (avifNumeric.length) {
      for (const w of avifNumeric) avifObj[String(w)] = b.avif.get(String(w));
    } else if (b.avif.has('orig')) {
      avifObj['1600'] = b.avif.get('orig');
    }

    // JPG: keep only the largest numeric width; else 'orig' -> 1600
    let jpgObj = {};
    const jpgNumeric = [...b.jpg.keys()].filter(k=>/^\d+$/.test(k)).map(Number).sort((a,b)=>a-b);
    if (jpgNumeric.length) {
      const largest = jpgNumeric[jpgNumeric.length-1];
      jpgObj[String(largest)] = b.jpg.get(String(largest));
    } else if (b.jpg.has('orig')) {
      jpgObj['1600'] = b.jpg.get('orig');
    }

    const idx = arr.findIndex(e => e.base === b.base);
    if (idx === -1) {
      arr.push({
        base: b.base,
        alt: b.alt,
        widths: widthsSorted,
        variants: { avif: avifObj, jpg: jpgObj }
      });
      added++;
    } else {
      const cur = arr[idx];
      const mergedW = new Set([...(cur.widths||[]), ...widthsSorted]);
      cur.widths = Array.from(mergedW).sort((a,b)=>a-b);
      cur.variants ||= { avif:{}, jpg:{} };
      Object.assign(cur.variants.avif, avifObj);

      // largest JPG overall
      const allJ = [...Object.keys(cur.variants.jpg), ...Object.keys(jpgObj)]
        .map(Number).filter(n=>!Number.isNaN(n)).sort((a,b)=>a-b);
      if (allJ.length) {
        const largest = String(allJ[allJ.length-1]);
        const merged = { ...cur.variants.jpg, ...jpgObj };
        cur.variants.jpg = { [largest]: merged[largest] };
      } else if (!Object.keys(cur.variants.jpg||{}).length && Object.keys(jpgObj).length) {
        cur.variants.jpg = { ...jpgObj };
      }

      if (!cur.alt) cur.alt = b.alt;
      updated++;
    }
  }

  await saveManifest(manifest);
  console.log(`✅ Done. Added: ${added}, Updated: ${updated}. → ${path.relative(CWD, MANIFEST_PATH)}`);
}

run().catch(err => { console.error('Fatal:', err); process.exit(1); });
