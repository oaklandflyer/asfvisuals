import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import sharp from 'sharp';

const CWD = process.cwd();

// --- CONFIG ----------------------------------------------------
const SRC_ROOT       = path.resolve(CWD, 'projects', 'originals');
const OUT_ROOT       = path.resolve(CWD, 'projects', 'processed');
const PUBLIC_PREFIX  = '/projects/processed';
const MANIFEST_PATH  = path.resolve(CWD, 'data', 'projects-manifest.json');

const SIZES          = [480, 960, 1600];
const AVIF_QUALITY   = 62;
const JPG_QUALITY    = 82;
const DEFAULT_INDUSTRY = 'projects';
// ---------------------------------------------------------------

const manifest = {
  generatedAt: new Date().toISOString(),
  projects: {} // projects[industry][project][album] = [{...images}]
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

function addToManifest({ industry, project, album, base, avifPaths, jpgPaths, alt }) {
  manifest.projects[industry] ??= {};
  manifest.projects[industry][project] ??= {};
  manifest.projects[industry][project][album] ??= [];

  const widths = SIZES.slice();
  const avif = {};
  const jpg  = {};

  SIZES.forEach((w, i) => { avif[String(w)] = avifPaths[i]; });
  // largest JPG only
  jpg[String(SIZES[SIZES.length - 1])] = jpgPaths[jpgPaths.length - 1];

  manifest.projects[industry][project][album].push({
    base,
    alt: alt || base,
    widths,
    variants: { avif, jpg }
  });
}

/**
 * Try to infer an album name and a cleaned baseName from the filename.
 * Examples:
 *   "Day 1 ASO-004.jpg"     -> album: "day-1",        baseName: "aso-004"
 *   "Set 2 - IMG_1234"      -> album: "set-2",        baseName: "img-1234"
 *   "Rockwell Park - 001"   -> album: "rockwell-park",baseName: "001"
 * Fallback album is "misc".
 */
function inferAlbumFromFilename(filename) {
  const raw = path.parse(filename).name.trim();

  // 1) "Day 1", "Set 2", "Album 3" at the start
  const dayLike = /^(day|set|album)\s*\d+/i;
  if (dayLike.test(raw)) {
    const m = raw.match(dayLike);
    const album = toSlug(m[0]);
    const rest = raw.slice(m[0].length).replace(/^[-_\s]+/, '');
    const baseName = toSlug(rest || raw);
    return { album: album || 'misc', baseName: baseName || 'image' };
  }

  // 2) Split on " - " → left side is album
  if (raw.includes(' - ')) {
    const [left, right] = raw.split(' - ', 2);
    const album = toSlug(left);
    const baseName = toSlug((right || '').trim() || raw);
    return { album: album || 'misc', baseName: baseName || 'image' };
  }

  // 3) "day1_" / "set2" compact style
  const compactDay = /^(day|set|album)\d+/i;
  if (compactDay.test(raw)) {
    const m = raw.match(compactDay);
    const album = toSlug(m[0].replace(/(\D)(\d+)/, '$1 $2')); // "day1" → "day 1"
    const rest = raw.slice(m[0].length).replace(/^[-_\s]+/, '');
    const baseName = toSlug(rest || raw);
    return { album: album || 'misc', baseName: baseName || 'image' };
  }

  // 4) Fallback
  return { album: 'misc', baseName: toSlug(raw) || 'image' };
}

function parseDirs(relPath) {
  // relPath like: <industry>/<project>/<album>/<file>
  const partsAll = relPath.split(path.sep);
  const filename = partsAll.pop();
  const dirs = partsAll;

  if (dirs.length >= 3) {
    // industry/project/album
    const [industryRaw, projectRaw, albumRaw] = dirs.slice(-3);
    return {
      ok: true,
      industry: toSlug(industryRaw),
      project:  toSlug(projectRaw),
      album:    toSlug(albumRaw),
      baseName: toSlug(path.parse(filename).name)
    };
  } else if (dirs.length === 2) {
    // project/album  -> default industry
    const [projectRaw, albumRaw] = dirs.slice(-2);
    return {
      ok: true,
      industry: DEFAULT_INDUSTRY,
      project:  toSlug(projectRaw),
      album:    toSlug(albumRaw),
      baseName: toSlug(path.parse(filename).name)
    };
  } else if (dirs.length === 1) {
    // project/<file>  -> infer album from filename
    const [projectRaw] = dirs;
    const inferred = inferAlbumFromFilename(filename);
    return {
      ok: true,
      industry: DEFAULT_INDUSTRY,
      project:  toSlug(projectRaw),
      album:    inferred.album,
      baseName: inferred.baseName
    };
  }
  return { ok: false };
}

async function processOne({ file, industry, project, album, baseName }) {
  const outDir = path.join(OUT_ROOT, industry, project, album);
  await ensureDir(outDir);

  const urlDir = `${PUBLIC_PREFIX}/${encodeURIComponent(industry)}/${encodeURIComponent(project)}/${encodeURIComponent(album)}`;

  const avifUrls = [];
  const jpgUrls  = [];

  const input = sharp(file).rotate(); // auto-orient EXIF

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

  const base = `${industry}/${project}/${album}/${baseName}`;
  addToManifest({ industry, project, album, base, avifPaths: avifUrls, jpgPaths: jpgUrls, alt: baseName });
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
    console.error('   projects/originals/<project>/<album>/<image>.jpg');
    console.error('   projects/originals/<industry>/<project>/<album>/<image>.jpg');
    console.error('   (Also supported) projects/originals/<project>/<image>.jpg  // album inferred from filename');
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
      console.warn(`  ↪ Skipping (needs <project>/<album>/... or <industry>/<project>/<album>/... or <project>/<file>): ${rel}`);
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
