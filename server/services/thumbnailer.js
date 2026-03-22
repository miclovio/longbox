const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const { extractPage } = require('./parser');

const THUMB_WIDTH = 300;
const THUMB_HEIGHT = 450;

/**
 * Generate a thumbnail for a comic issue from its first page.
 * Returns the relative path to the saved thumbnail.
 */
async function generateThumbnail(filePath, outputDir, issueId) {
  const thumbFilename = `issue_${issueId}.jpg`;
  const thumbPath = path.join(outputDir, thumbFilename);

  // Skip if thumbnail already exists
  if (fs.existsSync(thumbPath)) {
    return thumbFilename;
  }

  try {
    const page = await extractPage(filePath, 0);
    if (!page) return null;

    await sharp(page.buffer)
      .resize(THUMB_WIDTH, THUMB_HEIGHT, { fit: 'cover', position: 'top' })
      .jpeg({ quality: 80 })
      .toFile(thumbPath);

    return thumbFilename;
  } catch (err) {
    console.error(`Failed to generate thumbnail for ${filePath}:`, err.message);
    return null;
  }
}

/**
 * Generate a series thumbnail from the first issue's cover.
 */
async function generateSeriesThumbnail(filePath, outputDir, seriesId) {
  const thumbFilename = `series_${seriesId}.jpg`;
  const thumbPath = path.join(outputDir, thumbFilename);

  if (fs.existsSync(thumbPath)) {
    return thumbFilename;
  }

  try {
    const page = await extractPage(filePath, 0);
    if (!page) return null;

    await sharp(page.buffer)
      .resize(THUMB_WIDTH, THUMB_HEIGHT, { fit: 'cover', position: 'top' })
      .jpeg({ quality: 80 })
      .toFile(thumbPath);

    return thumbFilename;
  } catch (err) {
    console.error(`Failed to generate series thumbnail for ${filePath}:`, err.message);
    return null;
  }
}

module.exports = { generateThumbnail, generateSeriesThumbnail };
