import sharp from "sharp";
import fg from "fast-glob";
import { promises as fs } from "fs";
import fse from "fs-extra";
import path from "path";

// === Paths ===
// Only compress photos located in: C:\Users\couti\Downloads\asfvisuals\images\gallery\
const SRC_DIR = path.resolve("../images/gallery"); // originals
// Write output to: C:\Users\couti\Downloads\asfvisuals\gallery\
const OUT_DIR = path.resolve("../gallery");        // optimized output
const PUBLIC_BASE = "/gallery";                    // how your site will reference them

// === Settings ===
const WIDTHS = [480, 960, 1600]; // resize limits (add 2400 if you need larger)
const AVIF_Q = 45;               // AVIF quality (40–55 is typical)
const JPEG_Q = 82;               // JPG fallback quality (largest size only)
const GLOBS = ["**/*.{jpg,jpeg,png,JPG,JPEG,PNG}"];

const extless = (p) => p.replace(/\.[^.]+$/, "");
const toUrl = (s) => s.replaceAll("\\", "/").replace(/ /g, "%20");

// Category is the first subfolder inside images\gallery
const categoryFromRel = (rel) => {
  const parts = rel.split(/[\\/]/);
  return parts.length > 1 ? parts[0] : "General";
};

async function processOne(abs) {
  const rel = path.relative(SRC_DIR, abs).replaceAll("\\", "/");
  const baseNoExt = extless(rel);
  const baseName = path.basename(baseNoExt);

  const meta = await sharp(abs, { failOnError: false }).metadata();
  const srcW = meta.width || Math.max(...WIDTHS);

  const record = {
    base: baseNoExt,
    alt: baseName,
    widths: [],
    variants: { avif: {}, jpg: {} }
  };

  for (const w of WIDTHS) {
    const targetW = Math.min(w, srcW);
    if (!record.widths.includes(targetW)) record.widths.push(targetW);

    const avifRel = `${baseNoExt}_${targetW}.avif`;
    const avifAbs = path.join(OUT_DIR, avifRel);
    await fse.ensureDir(path.dirname(avifAbs));
    await sharp(abs).resize({ width: targetW }).avif({ quality: AVIF_Q }).toFile(avifAbs);
    record.variants.avif[targetW] = `${PUBLIC_BASE}/${toUrl(avifRel)}`;
  }

  // Single JPG fallback at the largest size
  const largest = Math.max(...record.widths);
  const jpgRel = `${baseNoExt}_${largest}.jpg`;
  const jpgAbs = path.join(OUT_DIR, jpgRel);
  await fse.ensureDir(path.dirname(jpgAbs));
  await sharp(abs).resize({ width: largest }).jpeg({ quality: JPEG_Q, mozjpeg: true }).toFile(jpgAbs);
  record.variants.jpg[largest] = `${PUBLIC_BASE}/${toUrl(jpgRel)}`;

  return { record, category: categoryFromRel(rel) };
}

async function main() {
  const files = await fg(GLOBS, { cwd: SRC_DIR, absolute: true });
  const categories = {};

  for (const abs of files) {
    try {
      const { record, category } = await processOne(abs);
      (categories[category] ??= []).push(record);
    } catch (e) {
      console.error("Error:", abs, e.message);
    }
  }

  // Stable ordering
  for (const cat of Object.keys(categories)) {
    categories[cat].sort((a, b) => a.base.localeCompare(b.base));
  }

  await fse.ensureDir(OUT_DIR);
  await fs.writeFile(
    path.join(OUT_DIR, "imagePaths.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), categories }, null, 2)
  );

  console.log("✅ Optimized images + imagePaths.json created in:", OUT_DIR);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
