/**
 * OPDS 1.2 Catalog Feed for Longbox.
 *
 * Provides Atom/OPDS XML feeds so external reader apps (Panels, Chunky,
 * KOReader, etc.) can browse and download comics via HTTP Basic Auth.
 */

const express = require('express');
const bcrypt = require('bcrypt');
const path = require('path');
const fs = require('fs');
const { getDb } = require('../db');

const router = express.Router();

// ─── XML helpers ──────────────────────────────────────────────────────

/** Escape special XML characters in user-supplied strings. */
function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** ISO-8601 timestamp (fallback to now). */
function isoDate(d) {
  if (!d) return new Date().toISOString();
  const parsed = new Date(d);
  return isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

/** Derive MIME type from comic filename. */
function comicMime(filename) {
  const ext = String(filename).toLowerCase().split('.').pop();
  if (ext === 'cbz') return 'application/x-cbz';
  if (ext === 'cbr') return 'application/x-cbr';
  if (ext === 'cb7') return 'application/x-cb7';
  if (ext === 'pdf') return 'application/pdf';
  return 'application/octet-stream';
}

/** Build the absolute base URL from the incoming request. */
function baseUrl(req) {
  const proto = req.get('x-forwarded-proto') || req.protocol;
  const host = req.get('x-forwarded-host') || req.get('host');
  return `${proto}://${host}`;
}

// ─── Basic Auth middleware (OPDS-only) ────────────────────────────────

async function opdsAuth(req, res, next) {
  // 1. Already authenticated via session? Allow through.
  if (req.session && req.session.userId) {
    return next();
  }

  // 2. Check for HTTP Basic Auth header.
  const authHeader = req.get('Authorization');
  if (authHeader && authHeader.startsWith('Basic ')) {
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
    const sepIdx = decoded.indexOf(':');
    if (sepIdx > 0) {
      const username = decoded.slice(0, sepIdx);
      const password = decoded.slice(sepIdx + 1);

      const db = getDb();
      const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);

      if (user) {
        try {
          const match = await bcrypt.compare(password, user.password_hash);
          if (match) {
            // Attach minimal user info so downstream code can rely on it.
            req.session = req.session || {};
            req.session.userId = user.id;
            req.session.username = user.username;
            req.session.isAdmin = user.is_admin === 1;
            return next();
          }
        } catch (_) {
          // bcrypt error — fall through to 401
        }
      }
    }
  }

  // 3. Not authenticated — request Basic Auth credentials.
  res.set('WWW-Authenticate', 'Basic realm="Longbox OPDS"');
  return res.status(401).type('text/plain').send('Authentication required');
}

router.use(opdsAuth);

// ─── Feed builders ────────────────────────────────────────────────────

function feedHeader(req, { id, title, selfHref }) {
  const base = baseUrl(req);
  const updated = new Date().toISOString();
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opds="http://opds-spec.org/2010/catalog"
      xmlns:dc="http://purl.org/dc/elements/1.1/">
  <id>${esc(id)}</id>
  <title>${esc(title)}</title>
  <updated>${updated}</updated>
  <author><name>Longbox</name></author>
  <link rel="self" href="${esc(base + selfHref)}" type="application/atom+xml;profile=opds-catalog;kind=navigation"/>
  <link rel="start" href="${esc(base)}/opds" type="application/atom+xml;profile=opds-catalog;kind=navigation"/>
  <link rel="search" href="${esc(base)}/opds/opensearch.xml" type="application/opensearchdescription+xml"/>
`;
}

// ─── Routes ───────────────────────────────────────────────────────────

/** GET /opds — Root navigation catalog */
router.get('/', (req, res) => {
  const base = baseUrl(req);
  let xml = feedHeader(req, {
    id: 'urn:longbox:root',
    title: 'Longbox',
    selfHref: '/opds',
  });

  xml += `
  <entry>
    <title>All Series</title>
    <id>urn:longbox:series</id>
    <updated>${new Date().toISOString()}</updated>
    <content type="text">Browse all comic series</content>
    <link rel="subsection" href="${esc(base)}/opds/series" type="application/atom+xml;profile=opds-catalog;kind=navigation"/>
  </entry>
  <entry>
    <title>Recently Added</title>
    <id>urn:longbox:recent</id>
    <updated>${new Date().toISOString()}</updated>
    <content type="text">Recently added issues</content>
    <link rel="subsection" href="${esc(base)}/opds/recent" type="application/atom+xml;profile=opds-catalog;kind=acquisition"/>
  </entry>
</feed>`;

  res.type('application/atom+xml;profile=opds-catalog;kind=navigation').send(xml);
});

/** GET /opds/opensearch.xml — OpenSearch description document */
router.get('/opensearch.xml', (req, res) => {
  const base = baseUrl(req);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
  <ShortName>Longbox</ShortName>
  <Description>Search Longbox library</Description>
  <Url type="application/atom+xml;profile=opds-catalog" template="${esc(base)}/opds/search?q={searchTerms}"/>
</OpenSearchDescription>`;
  res.type('application/opensearchdescription+xml').send(xml);
});

/** GET /opds/series — List all series (navigation feed) */
router.get('/series', (req, res) => {
  const db = getDb();
  const base = baseUrl(req);
  const allSeries = db.prepare('SELECT * FROM series ORDER BY name ASC').all();

  let xml = feedHeader(req, {
    id: 'urn:longbox:series',
    title: 'All Series',
    selfHref: '/opds/series',
  });

  for (const s of allSeries) {
    xml += `
  <entry>
    <title>${esc(s.name)}</title>
    <id>urn:longbox:series:${s.id}</id>
    <updated>${isoDate(s.created_at)}</updated>
    <content type="text">${esc(s.description || '')}${s.issue_count ? ' (' + s.issue_count + ' issues)' : ''}</content>`;

    if (s.publisher) {
      xml += `
    <dc:publisher>${esc(s.publisher)}</dc:publisher>`;
    }

    if (s.thumbnail_path) {
      xml += `
    <link rel="http://opds-spec.org/image" href="${esc(base)}/api/thumbnails/${esc(path.basename(s.thumbnail_path))}" type="image/jpeg"/>
    <link rel="http://opds-spec.org/image/thumbnail" href="${esc(base)}/api/thumbnails/${esc(path.basename(s.thumbnail_path))}" type="image/jpeg"/>`;
    }

    xml += `
    <link rel="subsection" href="${esc(base)}/opds/series/${s.id}" type="application/atom+xml;profile=opds-catalog;kind=acquisition"/>
  </entry>`;
  }

  xml += `
</feed>`;
  res.type('application/atom+xml;profile=opds-catalog;kind=navigation').send(xml);
});

/** GET /opds/series/:id — Issues in a series (acquisition feed) */
router.get('/series/:id', (req, res) => {
  const db = getDb();
  const base = baseUrl(req);
  const series = db.prepare('SELECT * FROM series WHERE id = ?').get(req.params.id);

  if (!series) {
    return res.status(404).type('text/plain').send('Series not found');
  }

  const issues = db.prepare(
    'SELECT * FROM issues WHERE series_id = ? ORDER BY issue_number ASC, filename ASC'
  ).all(series.id);

  let xml = feedHeader(req, {
    id: `urn:longbox:series:${series.id}`,
    title: series.name,
    selfHref: `/opds/series/${series.id}`,
  });

  for (const issue of issues) {
    xml += issueEntry(base, issue, series.name);
  }

  xml += `
</feed>`;
  res.type('application/atom+xml;profile=opds-catalog;kind=acquisition').send(xml);
});

/** GET /opds/recent — Recently added issues (acquisition feed) */
router.get('/recent', (req, res) => {
  const db = getDb();
  const base = baseUrl(req);

  const issues = db.prepare(`
    SELECT i.*, s.name as series_name
    FROM issues i
    JOIN series s ON s.id = i.series_id
    ORDER BY i.created_at DESC
    LIMIT 50
  `).all();

  let xml = feedHeader(req, {
    id: 'urn:longbox:recent',
    title: 'Recently Added',
    selfHref: '/opds/recent',
  });

  for (const issue of issues) {
    xml += issueEntry(base, issue, issue.series_name);
  }

  xml += `
</feed>`;
  res.type('application/atom+xml;profile=opds-catalog;kind=acquisition').send(xml);
});

/** GET /opds/search?q= — Search series by name */
router.get('/search', (req, res) => {
  const db = getDb();
  const base = baseUrl(req);
  const q = req.query.q || '';

  const results = db.prepare(
    'SELECT * FROM series WHERE name LIKE ? ORDER BY name ASC'
  ).all(`%${q}%`);

  let xml = feedHeader(req, {
    id: 'urn:longbox:search',
    title: `Search: ${q}`,
    selfHref: `/opds/search?q=${encodeURIComponent(q)}`,
  });

  for (const s of results) {
    xml += `
  <entry>
    <title>${esc(s.name)}</title>
    <id>urn:longbox:series:${s.id}</id>
    <updated>${isoDate(s.created_at)}</updated>
    <content type="text">${esc(s.description || '')}${s.issue_count ? ' (' + s.issue_count + ' issues)' : ''}</content>`;

    if (s.thumbnail_path) {
      xml += `
    <link rel="http://opds-spec.org/image" href="${esc(base)}/api/thumbnails/${esc(path.basename(s.thumbnail_path))}" type="image/jpeg"/>
    <link rel="http://opds-spec.org/image/thumbnail" href="${esc(base)}/api/thumbnails/${esc(path.basename(s.thumbnail_path))}" type="image/jpeg"/>`;
    }

    xml += `
    <link rel="subsection" href="${esc(base)}/opds/series/${s.id}" type="application/atom+xml;profile=opds-catalog;kind=acquisition"/>
  </entry>`;
  }

  xml += `
</feed>`;
  res.type('application/atom+xml;profile=opds-catalog;kind=navigation').send(xml);
});

/** GET /opds/download/:issueId — Stream the actual comic file */
router.get('/download/:issueId', (req, res) => {
  const db = getDb();
  const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(req.params.issueId);

  if (!issue) {
    return res.status(404).type('text/plain').send('Issue not found');
  }

  const filePath = issue.file_path;
  if (!fs.existsSync(filePath)) {
    return res.status(404).type('text/plain').send('File not found on disk');
  }

  const mime = comicMime(issue.filename);
  const stat = fs.statSync(filePath);

  res.set('Content-Type', mime);
  res.set('Content-Disposition', `attachment; filename="${esc(issue.filename)}"`);
  res.set('Content-Length', stat.size);

  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
});

// ─── Shared entry builder for issues ──────────────────────────────────

function issueEntry(base, issue, seriesName) {
  const title = issue.title || issue.filename;
  const mime = comicMime(issue.filename);

  let xml = `
  <entry>
    <title>${esc(title)}</title>
    <id>urn:longbox:issue:${issue.id}</id>
    <updated>${isoDate(issue.created_at)}</updated>
    <author><name>${esc(seriesName)}</name></author>
    <content type="text">${esc(issue.description || '')}</content>`;

  if (issue.file_size) {
    xml += `
    <link rel="http://opds-spec.org/acquisition" href="${esc(base)}/opds/download/${issue.id}" type="${mime}" length="${issue.file_size}"/>`;
  } else {
    xml += `
    <link rel="http://opds-spec.org/acquisition" href="${esc(base)}/opds/download/${issue.id}" type="${mime}"/>`;
  }

  if (issue.thumbnail_path) {
    xml += `
    <link rel="http://opds-spec.org/image" href="${esc(base)}/api/thumbnails/${esc(path.basename(issue.thumbnail_path))}" type="image/jpeg"/>
    <link rel="http://opds-spec.org/image/thumbnail" href="${esc(base)}/api/thumbnails/${esc(path.basename(issue.thumbnail_path))}" type="image/jpeg"/>`;
  }

  if (issue.cover_date) {
    xml += `
    <dc:date>${esc(issue.cover_date)}</dc:date>`;
  }

  xml += `
  </entry>`;
  return xml;
}

module.exports = router;
