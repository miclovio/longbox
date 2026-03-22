const fs = require('fs');
const path = require('path');

const COMIC_EXTENSIONS = new Set(['.cbr', '.cbz', '.zip', '.rar']);

/**
 * Parse a series name from a comic filename.
 * Strips issue numbers, years, group tags, and extensions.
 *
 * Examples:
 *   "Batman - The Killing Joke.cbr" -> "Batman - The Killing Joke"
 *   "Batman - Dark Victory (2014).cbr" -> "Batman - Dark Victory"
 *   "Outcast 001 (2014) (digital) (Minutemen-Midas).cbr" -> "Outcast"
 *   "Batman The Black Mirror (2011) (Digital TPB) (Zone-Empire).cbr" -> "Batman The Black Mirror"
 *   "Plutona (2016).cbr" -> "Plutona"
 */
function parseSeriesName(filename) {
  let name = path.basename(filename, path.extname(filename));

  // Remove parenthetical groups: (2014), (digital), (Minutemen-Midas), (Digital TPB), etc.
  name = name.replace(/\s*\([^)]*\)/g, '');

  // Remove bracket groups: [anything]
  name = name.replace(/\s*\[[^\]]*\]/g, '');

  // Remove trailing issue numbers: "Outcast 001" -> "Outcast"
  // But keep names like "Batman - The Long Halloween" (no trailing number)
  name = name.replace(/\s+\d{1,4}(\.\d+)?\s*$/, '');

  // Remove trailing #number
  name = name.replace(/\s*#\d+\s*$/, '');

  // Clean up trailing whitespace, dashes, hyphens
  name = name.replace(/[\s\-–—]+$/, '').trim();

  return name;
}

/**
 * Preview what the organizer would do without actually moving files.
 * Returns an array of { file, from, to, seriesFolder }.
 */
function previewOrganize(comicsPath) {
  const entries = fs.readdirSync(comicsPath, { withFileTypes: true });
  const moves = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;

    const ext = path.extname(entry.name).toLowerCase();
    if (!COMIC_EXTENSIONS.has(ext)) continue;

    const seriesName = parseSeriesName(entry.name);
    if (!seriesName) continue;

    const seriesFolder = path.join(comicsPath, seriesName);
    const currentPath = path.join(comicsPath, entry.name);
    const newPath = path.join(seriesFolder, entry.name);

    // Only move if the file is loose in the root (not already in a series folder)
    moves.push({
      file: entry.name,
      from: currentPath,
      to: newPath,
      seriesFolder: seriesName,
    });
  }

  return moves;
}

/**
 * Organize loose comic files into series subfolders.
 * Creates folders as needed and moves files.
 */
function organizeLibrary(comicsPath) {
  const moves = previewOrganize(comicsPath);
  const results = { moved: 0, foldersCreated: 0, errors: [] };
  const createdFolders = new Set();

  for (const move of moves) {
    try {
      const folderPath = path.dirname(move.to);

      if (!fs.existsSync(folderPath)) {
        fs.mkdirSync(folderPath, { recursive: true });
        if (!createdFolders.has(folderPath)) {
          createdFolders.add(folderPath);
          results.foldersCreated++;
        }
      }

      fs.renameSync(move.from, move.to);
      results.moved++;
    } catch (err) {
      results.errors.push({ file: move.file, error: err.message });
    }
  }

  return results;
}

module.exports = { parseSeriesName, previewOrganize, organizeLibrary };
