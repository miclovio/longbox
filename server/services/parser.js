const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');
const JSZip = require('jszip');
const yauzl = require('yauzl');

// Image extensions to include when listing pages
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);

function isImage(filename) {
  return IMAGE_EXTENSIONS.has(path.extname(filename).toLowerCase());
}

function naturalSort(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * Open a ZIP file with yauzl (streams from disk, supports files > 2GB).
 */
function openZip(filePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err);
      resolve(zipfile);
    });
  });
}

/**
 * List page filenames inside a CBZ (zip) archive, sorted naturally.
 * Uses yauzl to stream entries from disk (no 2GB limit).
 */
async function listCbzPages(filePath) {
  const zipfile = await openZip(filePath);
  const pages = [];

  return new Promise((resolve, reject) => {
    zipfile.on('entry', (entry) => {
      if (!/\/$/.test(entry.fileName) && isImage(entry.fileName)) {
        pages.push(entry.fileName);
      }
      zipfile.readEntry();
    });
    zipfile.on('end', () => {
      pages.sort(naturalSort);
      resolve(pages);
    });
    zipfile.on('error', reject);
    zipfile.readEntry();
  });
}

/**
 * Extract a specific page from a CBZ archive as a Buffer.
 * Uses yauzl to stream from disk (no 2GB limit).
 */
async function extractCbzPage(filePath, pageIndex) {
  const pages = await listCbzPages(filePath);

  if (pageIndex < 0 || pageIndex >= pages.length) {
    return null;
  }

  const targetFile = pages[pageIndex];
  const zipfile = await openZip(filePath);

  return new Promise((resolve, reject) => {
    zipfile.on('entry', (entry) => {
      if (entry.fileName === targetFile) {
        zipfile.openReadStream(entry, (err, readStream) => {
          if (err) return reject(err);
          const chunks = [];
          readStream.on('data', (chunk) => chunks.push(chunk));
          readStream.on('end', () => {
            zipfile.close();
            resolve({ buffer: Buffer.concat(chunks), filename: path.basename(targetFile) });
          });
          readStream.on('error', reject);
        });
      } else {
        zipfile.readEntry();
      }
    });
    zipfile.on('end', () => resolve(null));
    zipfile.on('error', reject);
    zipfile.readEntry();
  });
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
 * Check if system unrar binary is available.
 */
let hasSystemUnrar = null;
function checkSystemUnrar() {
  if (hasSystemUnrar !== null) return hasSystemUnrar;
  try {
    execSync('unrar --version', { stdio: 'ignore' });
    hasSystemUnrar = true;
  } catch {
    hasSystemUnrar = false;
  }
  return hasSystemUnrar;
}

/**
 * List pages using system unrar binary (handles RAR5 and older formats).
 */
function listCbrPagesSystem(filePath) {
  const output = execSync(`unrar lb "${filePath}"`, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
  const pages = output.split('\n').map(l => l.trim()).filter(l => l && isImage(l));
  pages.sort(naturalSort);
  return pages;
}

/**
 * Extract a page using system unrar binary.
 */
function extractCbrPageSystem(filePath, pageIndex) {
  const pages = listCbrPagesSystem(filePath);
  if (pageIndex < 0 || pageIndex >= pages.length) return null;

  const targetFile = pages[pageIndex];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'longbox-'));

  try {
    execSync(`unrar e -o+ "${filePath}" "${targetFile}" "${tmpDir}/"`, { stdio: 'ignore', maxBuffer: 50 * 1024 * 1024 });
    const extractedPath = path.join(tmpDir, path.basename(targetFile));
    if (fs.existsSync(extractedPath)) {
      const buffer = fs.readFileSync(extractedPath);
      return { buffer, filename: path.basename(targetFile) };
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  return null;
}

/**
 * Detect format and list pages.
 * Falls back to the other format if the primary one fails,
 * then tries system unrar as a last resort.
 */
async function listPages(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.cbz' || ext === '.zip') {
    try { return await listCbzPages(filePath); } catch (e) {
      try { return await listCbrPages(filePath); } catch (e2) {
        if (checkSystemUnrar()) return listCbrPagesSystem(filePath);
        throw e;
      }
    }
  } else if (ext === '.cbr' || ext === '.rar') {
    try { return await listCbrPages(filePath); } catch (e) {
      try { return await listCbzPages(filePath); } catch (e2) {
        if (checkSystemUnrar()) return listCbrPagesSystem(filePath);
        throw e;
      }
    }
  }
  throw new Error(`Unsupported format: ${ext}`);
}

/**
 * Detect format and extract a page.
 * Falls back to the other format if the primary one fails,
 * then tries system unrar as a last resort.
 */
async function extractPage(filePath, pageIndex) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.cbz' || ext === '.zip') {
    try { return await extractCbzPage(filePath, pageIndex); } catch (e) {
      try { return await extractCbrPage(filePath, pageIndex); } catch (e2) {
        if (checkSystemUnrar()) return extractCbrPageSystem(filePath, pageIndex);
        throw e;
      }
    }
  } else if (ext === '.cbr' || ext === '.rar') {
    try { return await extractCbrPage(filePath, pageIndex); } catch (e) {
      try { return await extractCbzPage(filePath, pageIndex); } catch (e2) {
        if (checkSystemUnrar()) return extractCbrPageSystem(filePath, pageIndex);
        throw e;
      }
    }
  }
  throw new Error(`Unsupported format: ${ext}`);
}

module.exports = { listPages, extractPage };
