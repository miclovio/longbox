const fs = require('fs');
const path = require('path');
const { getDb } = require('../db');
const { listPages } = require('./parser');
const { generateThumbnail, generateSeriesThumbnail } = require('./thumbnailer');

const COMIC_EXTENSIONS = new Set(['.cbr', '.cbz', '.zip', '.rar']);

/**
 * Parse an issue number from a filename.
 * Handles patterns like "Batman 001", "Batman #1", "Issue 12", etc.
 */
function parseIssueNumber(filename) {
  const base = path.basename(filename, path.extname(filename));

  // Try common patterns
  const patterns = [
    /\b#?(\d+(?:\.\d+)?)\s*(?:\(|$|\[|-|\.)/,   // "Title 001 (2013)" or "Title 001.cbr"
    /\b(?:issue|no\.?|number|#)\s*(\d+(?:\.\d+)?)/i,
    /\b(\d{3,})\b/,                                // 3+ digit number (likely issue)
    /\b(\d+)\s*$/,                                  // trailing number
  ];

  for (const pattern of patterns) {
    const match = base.match(pattern);
    if (match) {
      return parseFloat(match[1]);
    }
  }

  return null;
}

/**
 * Parse a series name from a loose comic filename.
 * Strips year, group tags, issue numbers, and extension.
 * "Batman - The Killing Joke.cbr" -> "Batman - The Killing Joke"
 * "Plutona (2016).cbr" -> "Plutona"
 */
function parseSeriesNameFromFile(filename) {
  let name = path.basename(filename, path.extname(filename));

  // Remove parenthetical groups: (2014), (digital), (Minutemen-Midas), etc.
  name = name.replace(/\s*\([^)]*\)/g, '');

  // Remove bracket groups: [anything]
  name = name.replace(/\s*\[[^\]]*\]/g, '');

  // Clean up trailing whitespace, dashes
  name = name.replace(/[\s\-–—]+$/, '').trim();

  return name || path.basename(filename, path.extname(filename));
}

/**
 * Clean up a series name from folder name.
 */
function cleanSeriesName(folderName) {
  return folderName
    .replace(/[-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Scan the comics directory and update the database.
 */
async function scanLibrary(comicsPath, progressCallback) {
  const db = getDb();
  const dataDir = process.env.DATA_DIR || './data';
  const thumbDir = path.join(dataDir, 'thumbnails');

  if (!fs.existsSync(comicsPath)) {
    throw new Error(`Comics path does not exist: ${comicsPath}`);
  }

  const entries = fs.readdirSync(comicsPath, { withFileTypes: true });
  const totalFolders = entries.filter(e => e.isDirectory()).length;

  // Also check for loose comic files in the root (skip macOS ._ metadata files)
  const rootFiles = entries.filter(e =>
    e.isFile() && !e.name.startsWith('._') && COMIC_EXTENSIONS.has(path.extname(e.name).toLowerCase())
  );

  let processed = 0;
  const stats = { seriesAdded: 0, issuesAdded: 0, issuesUpdated: 0, errors: [] };

  // Handle loose files in root — each gets its own series based on parsed name
  if (rootFiles.length > 0) {
    for (const file of rootFiles) {
      const seriesName = parseSeriesNameFromFile(file.name);
      const seriesKey = comicsPath + '::' + seriesName; // unique path per parsed name
      const fullPath = path.join(comicsPath, file.name);

      await scanSeriesFolder(db, comicsPath, seriesName, seriesKey, thumbDir, [fullPath], stats);
    }
  }

  // Scan each subfolder as a series (with nested subfolder support)
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const seriesPath = path.join(comicsPath, entry.name);

    // Check for subfolders inside this folder
    const subEntries = fs.readdirSync(seriesPath, { withFileTypes: true });
    const subFolders = subEntries.filter(e => e.isDirectory());
    const looseFiles = subEntries.filter(e =>
      e.isFile() && !e.name.startsWith('._') && COMIC_EXTENSIONS.has(path.extname(e.name).toLowerCase())
    );

    if (subFolders.length > 0) {
      // Has subfolders — treat each subfolder as its own series
      // Loose files in the parent folder also become a series
      if (looseFiles.length > 0) {
        const seriesName = cleanSeriesName(entry.name);
        const files = looseFiles.map(f => path.join(seriesPath, f.name));
        await scanSeriesFolder(db, seriesPath, seriesName, seriesPath, thumbDir, files, stats);
      }

      for (const sub of subFolders) {
        const subPath = path.join(seriesPath, sub.name);
        const subName = cleanSeriesName(sub.name);
        const comicFiles = findComicFiles(subPath);

        if (comicFiles.length === 0) continue;

        await scanSeriesFolder(db, subPath, subName, subPath, thumbDir, comicFiles, stats);
      }
    } else {
      // No subfolders — this folder is a single series (original behavior)
      const seriesName = cleanSeriesName(entry.name);
      const comicFiles = findComicFiles(seriesPath);

      if (comicFiles.length === 0) continue;

      await scanSeriesFolder(db, seriesPath, seriesName, seriesPath, thumbDir, comicFiles, stats);
    }

    processed++;
    if (progressCallback) {
      progressCallback({ processed, total: totalFolders, seriesName: cleanSeriesName(entry.name) });
    }
  }

  // Clean up series/issues for files that no longer exist
  cleanupMissing(db);

  return stats;
}

/**
 * Recursively find comic files in a directory.
 */
function findComicFiles(dirPath) {
  const files = [];

  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (COMIC_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) && !entry.name.startsWith('._')) {
        files.push(fullPath);
      }
    }
  }

  walk(dirPath);
  // Return relative paths if called with absolute, or just filenames
  return files;
}

async function scanSeriesFolder(db, basePath, seriesName, seriesPath, thumbDir, comicFiles, stats) {
  // Normalize path for consistent lookup (Windows slash differences)
  const normalizedPath = path.resolve(seriesPath);

  // Upsert series — try normalized path first, fall back to LIKE for legacy slash mismatches
  let series = db.prepare('SELECT * FROM series WHERE folder_path = ?').get(normalizedPath);
  if (!series) {
    // Check for same path stored with different slashes
    const altPath = normalizedPath.replace(/\\/g, '/');
    series = db.prepare('SELECT * FROM series WHERE folder_path = ? OR folder_path = ?').get(altPath, normalizedPath);
    if (series) {
      // Fix the stored path to the normalized form
      db.prepare('UPDATE series SET folder_path = ? WHERE id = ?').run(normalizedPath, series.id);
    }
  }

  if (!series) {
    const result = db.prepare('INSERT INTO series (name, folder_path) VALUES (?, ?)')
      .run(seriesName, normalizedPath);
    series = { id: result.lastInsertRowid, name: seriesName, folder_path: normalizedPath };
    stats.seriesAdded++;
  }

  let issueCount = 0;

  for (const filePath of comicFiles) {
    // Normalize: if filePath is just a filename, join with basePath
    const fullPath = path.resolve(path.isAbsolute(filePath) ? filePath : path.join(basePath, filePath));
    const filename = path.basename(fullPath);

    try {
      const fileStat = fs.statSync(fullPath);
      // Check normalized path and alternate slash form for legacy entries
      const altFullPath = fullPath.replace(/\\/g, '/');
      let existing = db.prepare('SELECT * FROM issues WHERE file_path = ?').get(fullPath);
      if (!existing) {
        existing = db.prepare('SELECT * FROM issues WHERE file_path = ?').get(altFullPath);
        if (existing) {
          db.prepare('UPDATE issues SET file_path = ? WHERE id = ?').run(fullPath, existing.id);
        }
      }

      if (existing) {
        // Update if file size changed (re-scan)
        if (existing.file_size !== fileStat.size) {
          const pages = await listPages(fullPath);
          db.prepare('UPDATE issues SET file_size = ?, page_count = ? WHERE id = ?')
            .run(fileStat.size, pages.length, existing.id);
          stats.issuesUpdated++;
        }
        issueCount++;
        continue;
      }

      // New issue — get page count
      const pages = await listPages(fullPath);
      const issueNumber = parseIssueNumber(filename);
      const title = path.basename(filename, path.extname(filename));

      const result = db.prepare(`
        INSERT INTO issues (series_id, title, filename, file_path, file_size, page_count, issue_number)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(series.id, title, filename, fullPath, fileStat.size, pages.length, issueNumber);

      // Generate thumbnail
      const thumbFile = await generateThumbnail(fullPath, thumbDir, result.lastInsertRowid);
      if (thumbFile) {
        db.prepare('UPDATE issues SET thumbnail_path = ? WHERE id = ?')
          .run(thumbFile, result.lastInsertRowid);
      }

      stats.issuesAdded++;
      issueCount++;
    } catch (err) {
      console.error(`Error scanning ${fullPath}:`, err.message);
      stats.errors.push({ file: fullPath, error: err.message });
    }
  }

  // Update issue count and series thumbnail
  db.prepare('UPDATE series SET issue_count = ? WHERE id = ?').run(issueCount, series.id);

  // Generate series thumbnail from first issue if missing
  if (!series.thumbnail_path) {
    const firstIssue = db.prepare(
      'SELECT file_path FROM issues WHERE series_id = ? ORDER BY issue_number ASC, filename ASC LIMIT 1'
    ).get(series.id);

    if (firstIssue) {
      const thumbFile = await generateSeriesThumbnail(firstIssue.file_path, thumbDir, series.id);
      if (thumbFile) {
        db.prepare('UPDATE series SET thumbnail_path = ? WHERE id = ?').run(thumbFile, series.id);
      }
    }
  }
}

/**
 * Remove DB entries for files/folders that no longer exist.
 */
function cleanupMissing(db) {
  const allIssues = db.prepare('SELECT id, file_path, series_id FROM issues').all();
  const removedIssueIds = [];

  for (const issue of allIssues) {
    if (!fs.existsSync(issue.file_path)) {
      removedIssueIds.push(issue.id);
    }
  }

  if (removedIssueIds.length > 0) {
    const placeholders = removedIssueIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM issues WHERE id IN (${placeholders})`).run(...removedIssueIds);
    console.log(`Cleaned up ${removedIssueIds.length} missing issues`);
  }

  // Merge duplicate series (same normalized folder_path with different slashes)
  const allSeries = db.prepare('SELECT * FROM series ORDER BY id').all();
  const pathMap = new Map();
  for (const s of allSeries) {
    const norm = path.resolve(s.folder_path);
    if (pathMap.has(norm)) {
      const keeper = pathMap.get(norm);
      // Prefer the one with comicvine_id
      const [keep, remove] = keeper.comicvine_id ? [keeper, s] : (s.comicvine_id ? [s, keeper] : [keeper, s]);
      if (keep !== keeper) pathMap.set(norm, keep);
      // Move issues from duplicate to keeper
      db.prepare('UPDATE issues SET series_id = ? WHERE series_id = ?').run(keep.id, remove.id);
      // Copy metadata if keeper is missing it
      if (!keep.comicvine_id && remove.comicvine_id) {
        db.prepare('UPDATE series SET comicvine_id = ?, description = ?, publisher = ?, start_year = ? WHERE id = ?')
          .run(remove.comicvine_id, remove.description, remove.publisher, remove.start_year, keep.id);
      }
      db.prepare('DELETE FROM series WHERE id = ?').run(remove.id);
      console.log(`Merged duplicate series: "${remove.name}" (id=${remove.id}) into "${keep.name}" (id=${keep.id})`);
    } else {
      pathMap.set(norm, s);
    }
  }

  // Remove empty series
  db.prepare('DELETE FROM series WHERE id NOT IN (SELECT DISTINCT series_id FROM issues)').run();

  // Update issue counts
  db.prepare(`
    UPDATE series SET issue_count = (
      SELECT COUNT(*) FROM issues WHERE issues.series_id = series.id
    )
  `).run();
}

/**
 * Get all configured comic paths (comma-separated in COMICS_PATH).
 */
function getComicsPaths() {
  const raw = process.env.COMICS_PATH || '';
  return raw.split(',').map(p => p.trim()).filter(Boolean);
}

/**
 * Scan all configured comic paths.
 */
async function scanAllPaths(progressCallback) {
  const paths = getComicsPaths();
  if (paths.length === 0) throw new Error('No COMICS_PATH configured');

  const combined = { seriesAdded: 0, issuesAdded: 0, issuesUpdated: 0, errors: [] };

  for (const comicsPath of paths) {
    try {
      const result = await scanLibrary(comicsPath, progressCallback);
      combined.seriesAdded += result.seriesAdded;
      combined.issuesAdded += result.issuesAdded;
      combined.issuesUpdated += result.issuesUpdated;
      combined.errors.push(...result.errors);
    } catch (err) {
      combined.errors.push({ file: comicsPath, error: err.message });
    }
  }

  return combined;
}

module.exports = { scanLibrary, scanAllPaths, getComicsPaths, parseIssueNumber };
