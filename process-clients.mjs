import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import sharp from 'sharp';

const CWD = process.cwd();

// --- CONFIG ----------------------------------------------------
const SRC_ROOT      = path.resolve(CWD, 'clients', 'originals');
const OUT_ROOT      = path.resolve(CWD, 'clients', 'processed');
const PUBLIC_PREFIX = '/clients/processed';
const MANIFEST_PATH = path.resolve(CWD, 'data', 'clients-manifest.json');

const SIZES        = [480, 960, 1600];
const AVIF_QUALITY = 62;
const JPG_QUALITY  = 82;
const DEFAULT_INDUSTRY = 'clients';
// ---------------------------------------------------------------

const manifest = {
  generatedAt: new Date().toISOString(),
  industries: {}
};

function toSlug(s='') {
  return String(s)
    .normalize('NFKD')
    .replace(/['’]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

function addToManifest({ industry, client, project, base, avifPaths, jpgPaths, alt }) {
  manifest.industries[industry] ??= {};
  manifest.industries[industry][client] ??= {};
  manifest.industries[industry][client][project] ??= [];

  const widths = SIZES.slice();
  const avif = {};
  const jpg  = {};

  SIZES.forEach((w, i) => { avif[String(w)] = avifPaths[i]; });
  // largest JPG only
  jpg[String(SIZES[SIZES.length - 1])] = jpgPaths[jpgPaths.length - 1];

  manifest.industries[industry][client][project].push({
    base,
    alt: alt || base,
    widths,
    variants: { avif, jpg }
  });
}

async function processOne({ file, industry, client, project, baseName }) {
  const outDir = path.join(OUT_ROOT, industry, client, project);
  await ensureDir(outDir);

  const urlDir = `${PUBLIC_PREFIX}/${encodeURIComponent(industry)}/${encodeURIComponent(client)}/${encodeURIComponent(project)}`;

  const avifUrls = [];
  const jpgUrls  = [];

  const input = sharp(file).rotate(); // auto-orient

  for (const w of SIZES) {
    const avifName = `${baseName}_${w}.avif`;
    const avifPath = path.join(outDir, avifName);
    await input.clone().resize({ width: w }).toFormat('avif', { quality: AVIF_QUALITY }).toFile(avifPath);
    avifUrls.push(`${urlDir}/${encodeURIComponent(avifName)}`);
    console.log(`  ✓ AVIF ${w}px -> ${path.relative(CWD, avifPath)}`);
  }

  const largest = SIZES[SIZES.length - 1];
  const jpgName = `${baseName}_${largest}.jpg`;
  const jpgPath = path.join(outDir, jpgName);
  await input.clone().resize({ width: largest }).jpeg({ quality: JPG_QUALITY, mozjpeg: true }).toFile(jpgPath);
  jpgUrls.push(`${urlDir}/${encodeURIComponent(jpgName)}`);
  console.log(`  ✓ JPG  ${largest}px -> ${path.relative(CWD, jpgPath)}`);

  const base = `${industry}/${client}/${project}/${baseName}`;
  addToManifest({ industry, client, project, base, avifPaths: avifUrls, jpgPaths: jpgUrls, alt: baseName });
}

function parseDirs(relPath) {
  // relPath like: <industry>/<client>/<project>/<file>
  const partsAll = relPath.split(path.sep);
  const filename = partsAll.pop();
  const dirs = partsAll;

  if (dirs.length >= 3) {
    // industry/client/project
    const [industryRaw, clientRaw, projectRaw] = dirs.slice(-3);
    return {
      ok: true,
      industry: toSlug(industryRaw),
      client:   toSlug(clientRaw),
      project:  toSlug(projectRaw),
      baseName: toSlug(path.parse(filename).name)
    };
  } else if (dirs.length === 2) {
    // client/project  -> default industry
    const [clientRaw, projectRaw] = dirs.slice(-2);
    return {
      ok: true,
      industry: DEFAULT_INDUSTRY,
      client:   toSlug(clientRaw),
      project:  toSlug(projectRaw),
      baseName: toSlug(path.parse(filename).name)
    };
  }
  return { ok: false };
}

async function run() {
  console.log(`CWD: ${CWD}`);
  console.log(`Source: ${SRC_ROOT}`);
  console.log(`Output: ${OUT_ROOT}`);
  console.log(`Manifest: ${MANIFEST_PATH}`);

  try {
    const stat = await fs.stat(SRC_ROOT);
    if (!stat.isDirectory()) throw new Error('SRC_ROOT is not a directory');
  } catch (e) {
    console.error('❌ Source folder not found. Expected images under:', SRC_ROOT);
    console.error('   Examples:');
    console.error('   clients/originals/<client>/<project>/<image>.jpg');
    console.error('   clients/originals/<industry>/<client>/<project>/<image>.jpg');
    process.exit(1);
  }

  const patterns = ['**/*.{jpg,jpeg,png,JPG,JPEG,PNG}'];
  const files = await fg(patterns, { cwd: SRC_ROOT, absolute: true, dot: false, caseSensitiveMatch: false });

  if (!files.length) {
    console.warn('⚠️  No image files found. Check your folder structure and extensions.');
    return;
  }

  console.log(`Found ${files.length} image(s). Processing...\n`);
  let processed = 0, skipped = 0;

  for (const file of files) {
    const rel = path.relative(SRC_ROOT, file);
    const parsed = parseDirs(rel);
    if (!parsed.ok) {
      console.warn(`  ↪ Skipping (needs <client>/<project>/... or <industry>/<client>/<project>/...): ${rel}`);
      skipped++;
      continue;
    }

    try {
      console.log(`→ ${rel}`);
      await processOne({ file, ...parsed });
      processed++;
    } catch (err) {
      console.error(`  ✗ Failed: ${rel}`, err.message);
      skipped++;
    }
  }

  await ensureDir(path.dirname(MANIFEST_PATH));
  await fs.writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8');

  console.log('\n-----------------------------------------');
  console.log(`✅ Wrote manifest: ${path.relative(CWD, MANIFEST_PATH)}`);
  console.log(`✅ Done. Processed: ${processed}, Skipped: ${skipped}`);
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
