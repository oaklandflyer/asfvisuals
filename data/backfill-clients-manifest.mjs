// backfill-clients-manifest.mjs — ultra-permissive + real-widths via sharp
import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import sharp from 'sharp';

const CWD = process.cwd();
const OUT_ROOT      = path.resolve(CWD, 'clients', 'processed');
const PUBLIC_PREFIX = '/clients/processed';
const MANIFEST_PATH = path.resolve(CWD, 'data', 'clients-manifest.json');

const DEBUG = true;
const FORCE_INDUSTRY = 'clients'; // force everything to show under "clients"

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
    return json;
  } catch {
    return { generatedAt: new Date().toISOString(), industries: {} };
  }
}

async function saveManifest(manifest) {
  manifest.generatedAt = new Date().toISOString();
  await fs.mkdir(path.dirname(MANIFEST_PATH), { recursive: true });
  await fs.writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8');
}

// Parse filename into {baseName, width?, ext}
function parseFileName(filename) {
  const ext = path.extname(filename).slice(1).toLowerCase(); // no dot
  const base = path.basename(filename, '.' + ext);
  // try "<name>_<width>"
  const m = base.match(/^(.*)_([0-9]{2,5})$/);
  if (m) {
    return { baseName: toSlug(m[1]), width: Number(m[2]), ext };
  }
  return { baseName: toSlug(base), width: null, ext };
}

// Accept any depth; use last 4 parts as industry/client/project/filename
function parseProcessedRel(rel) {
  const parts = rel.split(path.sep);
  if (parts.length < 4) return null;
  const [industryRaw, clientRaw, projectRaw, filename] = parts.slice(-4);
  const { baseName, width, ext } = parseFileName(filename);
  return {
    industryRaw, clientRaw, projectRaw, filename,
    industry: toSlug(industryRaw),
    client: toSlug(clientRaw),
    project: toSlug(projectRaw),
    baseName, width, ext,
    relUrl: `${PUBLIC_PREFIX}/${encodeURIComponent(industryRaw)}/${encodeURIComponent(clientRaw)}/${encodeURIComponent(projectRaw)}/${encodeURIComponent(filename)}`
  };
}

function ensureArr(manifest, industry, client, project) {
  manifest.industries[industry] ??= {};
  manifest.industries[industry][client] ??= {};
  manifest.industries[industry][client][project] ??= [];
  return manifest.industries[industry][client][project];
}

function summarizePreview(list, max = 8) {
  return list.slice(0, max).map(x => '  - ' + x).join('\n') + (list.length > max ? `\n  … (+${list.length - max} more)` : '');
}

function isAvif(ext) { return ext === 'avif'; }
function isJpgLike(ext) { return ext === 'jpg' || ext === 'jpeg' || ext === 'png' || ext === 'webp'; }

async function run() {
  console.log('Backfilling clients-manifest.json from processed images…');
  console.log('Processed root:', OUT_ROOT);

  const manifest = await loadManifest();

  // Grab everything common
  const files = await fg(['**/*.{avif,AVIF,jpg,JPG,jpeg,JPEG,png,PNG,webp,WEBP}'], {
    cwd: OUT_ROOT,
    absolute: false,
    dot: false,
    caseSensitiveMatch: false
  });

  if (!files.length) {
    console.warn('⚠️  No processed images found under', OUT_ROOT);
    return;
  }

  // Parse paths
  const parsed = [];
  for (const rel of files) {
    const p = parseProcessedRel(rel);
    if (p) parsed.push(p);
  }
  if (!parsed.length) {
    console.warn('⚠️  Found files, but none matched expected path depth (…/<industry>/<client>/<project>/<file>).');
    console.warn('Example:', files[0]);
    return;
  }

  // If width is null, use sharp to detect actual width
  let widthLookups = 0;
  await Promise.all(parsed.map(async p => {
    if (p.width == null) {
      try {
        const abs = path.join(OUT_ROOT, p.industryRaw, p.clientRaw, p.projectRaw, p.filename);
        const meta = await sharp(abs).metadata();
        if (meta && meta.width) {
          p.width = meta.width;
          widthLookups++;
        } else {
          // fallback default (treat as largest)
          p.width = 1600;
        }
      } catch {
        p.width = 1600;
      }
    }
  }));

  if (DEBUG) {
    const groups = new Set(parsed.map(p => `${p.industry}/${p.client}/${p.project}`));
    console.log(`Found ${files.length} files → usable ${parsed.length}. Width metadata looked up for ${widthLookups} file(s).`);
    console.log(`Distinct groups: ${groups.size}\n${summarizePreview([...groups])}`);
  }

  // Group into buckets (force industry to "clients" in MANIFEST only)
  const buckets = new Map(); // key: industry|client|project|baseName
  for (const p of parsed) {
    const industry = FORCE_INDUSTRY || p.industry;
    const key = [industry, p.client, p.project, p.baseName].join('|');
    if (!buckets.has(key)) {
      buckets.set(key, {
        industry,
        client: p.client,
        project: p.project,
        base: `${industry}/${p.client}/${p.project}/${p.baseName}`,
        alt: p.baseName,
        widths: new Set(),
        avif: new Map(),   // width -> url
        jpgLike: new Map() // width -> url (jpg/jpeg/png/webp)
      });
    }
    const b = buckets.get(key);
    b.widths.add(p.width);
    if (isAvif(p.ext)) b.avif.set(String(p.width), p.relUrl);
    else if (isJpgLike(p.ext)) b.jpgLike.set(String(p.width), p.relUrl);
  }

  // Merge into manifest
  let added = 0, updated = 0;
  for (const [, b] of buckets) {
    const arr = ensureArr(manifest, b.industry, b.client, b.project);

    // Normalize widths
    const widthsSorted = Array.from(b.widths).map(Number).sort((a,b)=>a-b);

    // Keep only the largest JPG-like width
    const jpgWidths = Array.from(b.jpgLike.keys()).map(Number).sort((a,b)=>a-b);
    let jpgObj = {};
    if (jpgWidths.length) {
      const largest = String(jpgWidths[jpgWidths.length - 1]);
      jpgObj = { [largest]: b.jpgLike.get(largest) };
    }

    // AVIF keep all
    const avifObj = {};
    for (const [w, url] of b.avif.entries()) avifObj[w] = url;

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
      // merge widths
      const merged = new Set([...(cur.widths || []), ...widthsSorted]);
      cur.widths = Array.from(merged).map(Number).sort((a,b)=>a-b);
      cur.variants ||= { avif:{}, jpg:{} };
      cur.variants.avif ||= {};
      cur.variants.jpg  ||= {};
      // merge avif
      for (const k of Object.keys(avifObj)) cur.variants.avif[k] = avifObj[k];
      // pick largest jpg-like overall
      const allJ = [...Object.keys(cur.variants.jpg), ...Object.keys(jpgObj)].map(Number).sort((a,b)=>a-b);
      if (allJ.length) {
        const largest = String(allJ[allJ.length - 1]);
        const mergedJ = { ...cur.variants.jpg, ...jpgObj };
        cur.variants.jpg = { [largest]: mergedJ[largest] };
      }
      if (!cur.alt) cur.alt = b.alt;
      updated++;
    }
  }

  await saveManifest(manifest);
  console.log(`✅ Done. Added: ${added}, Updated: ${updated}. → ${path.relative(CWD, MANIFEST_PATH)}`);

  if (DEBUG && added + updated === 0) {
    console.log('No changes were written. That usually means the other clients are already present under a different industry key, or entry bases matched exactly.');
  }
}

run().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
