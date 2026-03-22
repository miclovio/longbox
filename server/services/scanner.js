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

  // Also check for loose comic files in the root
  const rootFiles = entries.filter(e =>
    e.isFile() && COMIC_EXTENSIONS.has(path.extname(e.name).toLowerCase())
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

  // Scan each subfolder as a series
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const seriesPath = path.join(comicsPath, entry.name);
    const seriesName = cleanSeriesName(entry.name);

    // Find all comic files in this folder (including subdirectories)
    const comicFiles = findComicFiles(seriesPath);

    if (comicFiles.length === 0) continue;

    await scanSeriesFolder(db, seriesPath, seriesName, seriesPath, thumbDir, comicFiles, stats);

    processed++;
    if (progressCallback) {
      progressCallback({ processed, total: totalFolders, seriesName });
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
      } else if (COMIC_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        files.push(fullPath);
      }
    }
  }

  walk(dirPath);
  // Return relative paths if called with absolute, or just filenames
  return files;
}

async function scanSeriesFolder(db, basePath, seriesName, seriesPath, thumbDir, comicFiles, stats) {
  // Upsert series
  let series = db.prepare('SELECT * FROM series WHERE folder_path = ?').get(seriesPath);

  if (!series) {
    const result = db.prepare('INSERT INTO series (name, folder_path) VALUES (?, ?)')
      .run(seriesName, seriesPath);
    series = { id: result.lastInsertRowid, name: seriesName, folder_path: seriesPath };
    stats.seriesAdded++;
  }

  let issueCount = 0;

  for (const filePath of comicFiles) {
    // Normalize: if filePath is just a filename, join with basePath
    const fullPath = path.isAbsolute(filePath) ? filePath : path.join(basePath, filePath);
    const filename = path.basename(fullPath);

    try {
      const fileStat = fs.statSync(fullPath);
      const existing = db.prepare('SELECT * FROM issues WHERE file_path = ?').get(fullPath);

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
