// scripts/generate-oldcss-manifest.js
// Scans all version subdirectories under revelation/assets/oldcss/ and writes
// a flat manifest.json where every path includes the version prefix, e.g.:
//   "1.0.6/beige.css", "1.0.6/fonts/inter/inter.css", "1.1.0/beige.css", …
//
// Upload the output file to:
//   https://www.pastordaniel.net/bigmedia/revelation/oldcss/manifest.json
//
// Usage: node scripts/generate-oldcss-manifest.js
const fs = require('fs');
const path = require('path');

const OLDCSS_DIR = path.join(__dirname, '..', 'revelation', 'assets', 'oldcss');
const OUTFILE = path.join(OLDCSS_DIR, 'manifest.json');

function walkDir(dir, base) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const results = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    const rel = path.join(base, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(full, rel));
    } else {
      results.push(rel.split(path.sep).join('/'));  // always forward slashes
    }
  }
  return results;
}

// Collect version subdirectories (anything that looks like x.y.z)
const versionDirs = fs.readdirSync(OLDCSS_DIR, { withFileTypes: true })
  .filter(e => e.isDirectory() && /^\d+\.\d+/.test(e.name))
  .sort((a, b) => a.name.localeCompare(b.name));

const files = versionDirs.flatMap(vd => walkDir(path.join(OLDCSS_DIR, vd.name), vd.name));

fs.writeFileSync(OUTFILE, JSON.stringify(files, null, 2) + '\n');
console.log(`✓ Wrote ${files.length} entries across ${versionDirs.length} version(s) to ${OUTFILE}`);
console.log(`  Versions: ${versionDirs.map(v => v.name).join(', ')}`);
console.log(`  Upload this file to: https://www.pastordaniel.net/bigmedia/revelation/oldcss/manifest.json`);
