import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import sharp from 'sharp';

const CWD = process.cwd();

// --- CONFIG ----------------------------------------------------
const SRC_ROOT = path.resolve(CWD, 'real-estate', 'originals');
// where processed images will be written
const OUT_ROOT = path.resolve(CWD, 'real-estate', 'processed');
// the URL path your site will use to load those processed images
const PUBLIC_PREFIX = '/real-estate/processed';
// where the manifest JSON will be written for the site to fetch
const MANIFEST_PATH = path.resolve(CWD, 'data', 'realestate-manifest.json');

// output sizes & formats
const SIZES = [480, 960, 1600];
const AVIF_QUALITY = 62;
const JPG_QUALITY  = 82;

// ---------------------------------------------------------------

const manifest = {
  generatedAt: new Date().toISOString(),
  // structure: { [city]: { [group]: { [property]: [ photoItems ] } } }
  cities: {}
};

const STATE_NAMES = new Set([
  'alabama','alaska','arizona','arkansas','california','colorado','connecticut','delaware',
  'florida','georgia','hawaii','idaho','illinois','indiana','iowa','kansas','kentucky',
  'louisiana','maine','maryland','massachusetts','michigan','minnesota','mississippi',
  'missouri','montana','nebraska','nevada','new hampshire','new jersey','new mexico',
  'new york','north carolina','north dakota','ohio','oklahoma','oregon','pennsylvania',
  'rhode island','south carolina','south dakota','tennessee','texas','utah','vermont',
  'virginia','washington','west virginia','wisconsin','wyoming'
]);
const STATE_ABBR = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA',
  'ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK',
  'OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'
]);
const looksLikeState = s => STATE_NAMES.has(s?.toLowerCase()) || STATE_ABBR.has(s?.toUpperCase());

function toSlug(s='') {
  return String(s)
    .normalize('NFKD')
    .replace(/['’]/g, '')        // drop apostrophes
    .replace(/[^a-zA-Z0-9]+/g, '-') // non-alnum to dashes
    .replace(/^-+|-+$/g, '')     // trim dashes
    .toLowerCase();
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

function addToManifest({ city, group, prop, base, avifPaths, jpgPaths }) {
  manifest.cities[city] ??= {};
  manifest.cities[city][group] ??= {};
  manifest.cities[city][group][prop] ??= [];

  const widths = SIZES.slice();
  const avif = {};
  const jpg  = {};

  SIZES.forEach((w, i) => {
    avif[String(w)] = avifPaths[i];
  });
  // only emit largest JPG to save space, adjust if you want all sizes
  jpg[String(SIZES[SIZES.length - 1])] = jpgPaths[jpgPaths.length - 1];

  manifest.cities[city][group][prop].push({
    base,
    alt: base,
    widths,
    variants: { avif, jpg }
  });
}

async function processOne(file, city, group, prop, baseName) {
  // real output folder
  const outDir = path.join(OUT_ROOT, city, group, prop);
  await ensureDir(outDir);

  // encode URL parts for manifest URLs
  const urlDir = `${PUBLIC_PREFIX}/${encodeURIComponent(city)}/${encodeURIComponent(group)}/${encodeURIComponent(prop)}`;

  const avifUrls = [];
  const jpgUrls  = [];

  const input = sharp(file).rotate(); // auto-orient

  // we do per-size clones, so we don't mutate the original pipeline
  for (const w of SIZES) {
    const avifName = `${baseName}_${w}.avif`;
    const avifPath = path.join(outDir, avifName);

    await input.clone().resize({ width: w }).toFormat('avif', { quality: AVIF_QUALITY }).toFile(avifPath);

    avifUrls.push(`${urlDir}/${encodeURIComponent(avifName)}`);
    console.log(`  ✓ AVIF ${w}px -> ${path.relative(CWD, avifPath)}`);
  }

  // largest JPG only
  const largest = SIZES[SIZES.length - 1];
  const jpgName = `${baseName}_${largest}.jpg`;
  const jpgPath = path.join(outDir, jpgName);

  await input.clone().resize({ width: largest }).jpeg({ quality: JPG_QUALITY, mozjpeg: true }).toFile(jpgPath);
  jpgUrls.push(`${urlDir}/${encodeURIComponent(jpgName)}`);
  console.log(`  ✓ JPG  ${largest}px -> ${path.relative(CWD, jpgPath)}`);

  addToManifest({ city, group, prop, base: `${city}/${group}/${prop}/${baseName}`, avifPaths: avifUrls, jpgPaths: jpgUrls });
}

function parseDirs(dirs) {
  // Accept:
  //   State/City/Property/Shot
  //   City/Area/Property/Shot
  //   City/Property/Shot (group = General)
  let cityRaw, groupRaw, propRaw;

  if (dirs.length >= 3) {
    const [a, b, c] = dirs.slice(-3);
    if (looksLikeState(a)) { // State/City/Property
      groupRaw = a;
      cityRaw  = b;
      propRaw  = c;
    } else {                 // City/Area/Property
      cityRaw  = a;
      groupRaw = b;
      propRaw  = c;
    }
  } else if (dirs.length === 2) { // City/Property
    [cityRaw, propRaw] = dirs;
    groupRaw = 'General';
  } else {
    return null;
  }

  return {
    city:  toSlug(cityRaw),
    group: toSlug(groupRaw),
    prop:  toSlug(propRaw),
  };
}

async function run() {
  console.log(`CWD: ${CWD}`);
  console.log(`Source: ${SRC_ROOT}`);
  console.log(`Output: ${OUT_ROOT}`);
  console.log(`Manifest: ${MANIFEST_PATH}`);

  // sanity checks
  try {
    const stat = await fs.stat(SRC_ROOT);
    if (!stat.isDirectory()) throw new Error('SRC_ROOT is not a directory');
  } catch (e) {
    console.error('❌ Source folder not found. Expected images under:', SRC_ROOT);
    console.error('   Example path: real-estate/originals/Ohio/Akron/25 Ghent Rd/<image>.jpg');
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
    const parts = rel.split(path.sep);
    const filename = parts.pop();
    const dirs = parts;

    const parsed = parseDirs(dirs);
    if (!parsed) {
      console.warn(`  ↪ Skipping (not deep enough): ${rel}`);
      skipped++;
      continue;
    }

    const baseName = toSlug(path.parse(filename).name);

    try {
      console.log(`→ ${rel}`);
      await processOne(file, parsed.city, parsed.group, parsed.prop, baseName);
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
