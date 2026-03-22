const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

// Image extensions to include when listing pages
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);

function isImage(filename) {
  return IMAGE_EXTENSIONS.has(path.extname(filename).toLowerCase());
}

function naturalSort(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * List page filenames inside a CBZ (zip) archive, sorted naturally.
 */
async function listCbzPages(filePath) {
  const data = fs.readFileSync(filePath);
  const zip = await JSZip.loadAsync(data);
  const pages = [];

  zip.forEach((relativePath, entry) => {
    if (!entry.dir && isImage(relativePath)) {
      pages.push(relativePath);
    }
  });

  pages.sort(naturalSort);
  return pages;
}

/**
 * Extract a specific page from a CBZ archive as a Buffer.
 */
async function extractCbzPage(filePath, pageIndex) {
  const data = fs.readFileSync(filePath);
  const zip = await JSZip.loadAsync(data);
  const pages = [];

  zip.forEach((relativePath, entry) => {
    if (!entry.dir && isImage(relativePath)) {
      pages.push(relativePath);
    }
  });

  pages.sort(naturalSort);

  if (pageIndex < 0 || pageIndex >= pages.length) {
    return null;
  }

  const pageData = await zip.file(pages[pageIndex]).async('nodebuffer');
  return { buffer: pageData, filename: path.basename(pages[pageIndex]) };
}

/**
 * Read a RAR file into memory and create an extractor.
 * Uses createExtractorFromData because createExtractorFromFile
 * doesn't return extraction data on Windows.
 */
async function createRarExtractor(filePath) {
  const { createExtractorFromData } = require('node-unrar-js');
  const data = fs.readFileSync(filePath);
  return createExtractorFromData({ data });
}

/**
 * List page filenames inside a CBR (rar) archive, sorted naturally.
 */
async function listCbrPages(filePath) {
  const extractor = await createRarExtractor(filePath);
  const list = extractor.getFileList();
  const fileHeaders = [...list.fileHeaders];

  const pages = fileHeaders
    .filter(h => !h.flags.directory && isImage(h.name))
    .map(h => h.name);

  pages.sort(naturalSort);
  return pages;
}

/**
 * Extract a specific page from a CBR archive as a Buffer.
 */
async function extractCbrPage(filePath, pageIndex) {
  const pages = await listCbrPages(filePath);

  if (pageIndex < 0 || pageIndex >= pages.length) {
    return null;
  }

  const targetFile = pages[pageIndex];
  const extractor = await createRarExtractor(filePath);
  const extracted = extractor.extract({ files: [targetFile] });

  for (const file of extracted.files) {
    if (file.extraction) {
      return { buffer: Buffer.from(file.extraction), filename: path.basename(targetFile) };
    }
  }

  return null;
}

/**
 * Detect format and list pages.
 * Falls back to the other format if the primary one fails
 * (handles mislabeled .cbr files that are actually ZIPs and vice versa).
 */
async function listPages(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.cbz' || ext === '.zip') {
    try { return await listCbzPages(filePath); } catch (e) {
      return listCbrPages(filePath);
    }
  } else if (ext === '.cbr' || ext === '.rar') {
    try { return await listCbrPages(filePath); } catch (e) {
      return listCbzPages(filePath);
    }
  }
  throw new Error(`Unsupported format: ${ext}`);
}

/**
 * Detect format and extract a page.
 * Falls back to the other format if the primary one fails.
 */
async function extractPage(filePath, pageIndex) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.cbz' || ext === '.zip') {
    try { return await extractCbzPage(filePath, pageIndex); } catch (e) {
      return extractCbrPage(filePath, pageIndex);
    }
  } else if (ext === '.cbr' || ext === '.rar') {
    try { return await extractCbrPage(filePath, pageIndex); } catch (e) {
      return extractCbzPage(filePath, pageIndex);
    }
  }
  throw new Error(`Unsupported format: ${ext}`);
}

module.exports = { listPages, extractPage };
