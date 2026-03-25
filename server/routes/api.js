const express = require('express');
const path = require('path');
const mime = require('mime-types');
const { getDb } = require('../db');
const { extractPage, listPages } = require('../services/parser');

const router = express.Router();

// GET /api/series — list all series
router.get('/series', (req, res) => {
  const db = getDb();
  const { search, sort = 'name', order = 'asc' } = req.query;

  const validSorts = ['name', 'issue_count', 'created_at'];
  const sortCol = validSorts.includes(sort) ? sort : 'name';
  const sortOrder = order === 'desc' ? 'DESC' : 'ASC';

  let query = `SELECT s.*, (SELECT MAX(i.cover_date) FROM issues i WHERE i.series_id = s.id AND i.cover_date IS NOT NULL) as latest_cover_date FROM series s`;
  const params = [];

  if (search) {
    query += ` WHERE s.name LIKE ?`;
    params.push(`%${search}%`);
  }

  query += ` ORDER BY s.${sortCol} ${sortOrder}`;

  const series = db.prepare(query).all(...params);
  res.json(series);
});

// GET /api/series/:id — single series with its issues
router.get('/series/:id', (req, res) => {
  const db = getDb();
  const series = db.prepare('SELECT * FROM series WHERE id = ?').get(req.params.id);

  if (!series) {
    return res.status(404).json({ error: 'Series not found' });
  }

  const issues = db.prepare(
    'SELECT * FROM issues WHERE series_id = ? ORDER BY issue_number ASC, filename ASC'
  ).all(req.params.id);

  // Group variants: issues with the same issue_number are variants of each other.
  // The first one (by filename) is the "primary", the rest are variants.
  const grouped = [];
  const variantMap = new Map();

  for (const issue of issues) {
    const key = issue.issue_number != null ? `num_${issue.issue_number}` : `id_${issue.id}`;

    if (variantMap.has(key)) {
      variantMap.get(key).variants.push({
        id: issue.id,
        title: issue.title,
        thumbnail_path: issue.thumbnail_path,
        filename: issue.filename,
      });
    } else {
      const entry = { ...issue, variants: [] };
      variantMap.set(key, entry);
      grouped.push(entry);
    }
  }

  res.json({ ...series, issues: grouped });
});

// GET /api/issues/:id — single issue detail
router.get('/issues/:id', (req, res) => {
  const db = getDb();
  const issue = db.prepare(`
    SELECT issues.*, series.name as series_name
    FROM issues
    JOIN series ON series.id = issues.series_id
    WHERE issues.id = ?
  `).get(req.params.id);

  if (!issue) {
    return res.status(404).json({ error: 'Issue not found' });
  }

  res.json(issue);
});

// GET /api/issues/:id/pages — list pages for an issue
router.get('/issues/:id/pages', async (req, res) => {
  const db = getDb();
  const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(req.params.id);

  if (!issue) {
    return res.status(404).json({ error: 'Issue not found' });
  }

  try {
    const pages = await listPages(issue.file_path);
    res.json({ issue_id: issue.id, page_count: pages.length, pages: pages.map((p, i) => ({ index: i, name: p })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/issues/:id/pages/:page — serve a specific page image
router.get('/issues/:id/pages/:page', async (req, res) => {
  const db = getDb();
  const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(req.params.id);

  if (!issue) {
    return res.status(404).json({ error: 'Issue not found' });
  }

  const pageIndex = parseInt(req.params.page, 10);
  if (isNaN(pageIndex) || pageIndex < 0) {
    return res.status(400).json({ error: 'Invalid page number' });
  }

  try {
    const result = await extractPage(issue.file_path, pageIndex);
    if (!result) {
      return res.status(404).json({ error: 'Page not found' });
    }

    const contentType = mime.lookup(result.filename) || 'image/jpeg';
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(result.buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/progress/summary — per-series and per-issue read status for current user
router.get('/progress/summary', (req, res) => {
  const db = getDb();
  const userId = req.session.userId;

  // Per-issue progress
  const issueProgress = db.prepare(`
    SELECT issue_id, current_page, is_read FROM reading_progress WHERE user_id = ?
  `).all(userId);

  // Build issue map
  const issues = {};
  for (const p of issueProgress) {
    issues[p.issue_id] = { currentPage: p.current_page, isRead: p.is_read === 1 };
  }

  // Per-series: count read vs total (grouped by issue_number to exclude variant duplicates)
  const seriesStats = db.prepare(`
    SELECT series_id, COUNT(*) as total,
      SUM(CASE WHEN grp_read > 0 THEN 1 ELSE 0 END) as read,
      SUM(CASE WHEN grp_started > 0 THEN 1 ELSE 0 END) as started
    FROM (
      SELECT i.series_id,
        COALESCE(i.issue_number, i.id) as grp_key,
        MAX(CASE WHEN rp.is_read = 1 THEN 1 ELSE 0 END) as grp_read,
        MAX(CASE WHEN rp.id IS NOT NULL THEN 1 ELSE 0 END) as grp_started
      FROM issues i
      LEFT JOIN reading_progress rp ON rp.issue_id = i.id AND rp.user_id = ?
      GROUP BY i.series_id, grp_key
    )
    GROUP BY series_id
  `).all(userId);

  const series = {};
  for (const s of seriesStats) {
    if (s.read > 0) {
      series[s.series_id] = {
        total: s.total,
        read: s.read,
        started: s.started,
        allRead: s.read >= s.total && s.total > 0,
      };
    }
  }

  res.json({ issues, series });
});

// GET /api/progress — get reading progress for current user
router.get('/progress', (req, res) => {
  const db = getDb();
  const userId = req.session.userId;

  const progress = db.prepare(`
    SELECT rp.*, i.title, i.thumbnail_path, i.issue_number, i.page_count, i.file_size,
           i.cover_date, i.series_id, s.name as series_name
    FROM reading_progress rp
    JOIN issues i ON i.id = rp.issue_id
    JOIN series s ON s.id = i.series_id
    WHERE rp.user_id = ?
    ORDER BY rp.updated_at DESC
  `).all(userId);

  res.json(progress);
});

// POST /api/progress/:issueId — update reading progress
router.post('/progress/:issueId', (req, res) => {
  const db = getDb();
  const userId = req.session.userId;
  const issueId = parseInt(req.params.issueId, 10);
  const { current_page, is_read } = req.body;

  db.prepare(`
    INSERT INTO reading_progress (user_id, issue_id, current_page, is_read, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id, issue_id) DO UPDATE SET
      current_page = COALESCE(?, current_page),
      is_read = COALESCE(?, is_read),
      updated_at = datetime('now')
  `).run(userId, issueId, current_page || 0, is_read ? 1 : 0, current_page, is_read != null ? (is_read ? 1 : 0) : null);

  // Propagate read status to variant issues (same series + issue_number)
  if (is_read != null) {
    const issue = db.prepare('SELECT series_id, issue_number FROM issues WHERE id = ?').get(issueId);
    if (issue && issue.issue_number != null) {
      const variants = db.prepare(
        'SELECT id FROM issues WHERE series_id = ? AND issue_number = ? AND id != ?'
      ).all(issue.series_id, issue.issue_number, issueId);

      const readVal = is_read ? 1 : 0;
      if (!is_read) {
        // When unchecking, remove progress rows where user never actually read pages
        db.prepare(
          'DELETE FROM reading_progress WHERE user_id = ? AND issue_id = ? AND current_page = 0'
        ).run(userId, issueId);
        for (const v of variants) {
          db.prepare(
            'DELETE FROM reading_progress WHERE user_id = ? AND issue_id = ? AND current_page = 0'
          ).run(userId, v.id);
        }
        // For rows where user did read pages, just clear is_read
        db.prepare(
          'UPDATE reading_progress SET is_read = 0, updated_at = datetime(\'now\') WHERE user_id = ? AND issue_id = ? AND current_page > 0'
        ).run(userId, issueId);
        for (const v of variants) {
          db.prepare(
            'UPDATE reading_progress SET is_read = 0, updated_at = datetime(\'now\') WHERE user_id = ? AND issue_id = ? AND current_page > 0'
          ).run(userId, v.id);
        }
      } else {
        const stmt = db.prepare(`
          INSERT INTO reading_progress (user_id, issue_id, current_page, is_read, updated_at)
          VALUES (?, ?, 0, ?, datetime('now'))
          ON CONFLICT(user_id, issue_id) DO UPDATE SET
            is_read = ?,
            updated_at = datetime('now')
        `);
        for (const v of variants) {
          stmt.run(userId, v.id, readVal, readVal);
        }
      }
    }
  }

  // Log activity when marking as completed — group by series within 10 minutes
  if (is_read) {
    const issue = db.prepare('SELECT series_id FROM issues WHERE id = ?').get(issueId);
    if (issue) {
      const recentSeries = db.prepare(
        "SELECT id, issue_id FROM activity WHERE user_id = ? AND action_type = 'completed' AND series_id = ? AND created_at > datetime('now', '-10 minutes')"
      ).get(userId, issue.series_id);
      if (recentSeries) {
        // Update existing activity to latest issue, refresh timestamp
        db.prepare("UPDATE activity SET issue_id = ?, created_at = datetime('now') WHERE id = ?")
          .run(issueId, recentSeries.id);
      } else {
        db.prepare('INSERT INTO activity (user_id, action_type, series_id, issue_id) VALUES (?, ?, ?, ?)')
          .run(userId, 'completed', issue.series_id, issueId);
      }
    }
  }

  res.json({ ok: true });
});

// POST /api/bookmarks — create a bookmark
router.post('/bookmarks', (req, res) => {
  const db = getDb();
  const userId = req.session.userId;
  const { issue_id, page_number, note } = req.body;

  if (!issue_id || page_number == null) {
    return res.status(400).json({ error: 'issue_id and page_number are required' });
  }

  const result = db.prepare(`
    INSERT INTO bookmarks (user_id, issue_id, page_number, note)
    VALUES (?, ?, ?, ?)
  `).run(userId, issue_id, page_number, note || null);

  res.json({ ok: true, id: result.lastInsertRowid });
});

// GET /api/bookmarks — list user's bookmarks with issue/series info
router.get('/bookmarks', (req, res) => {
  const db = getDb();
  const userId = req.session.userId;

  const bookmarks = db.prepare(`
    SELECT b.*, i.title as issue_title, i.thumbnail_path, i.issue_number,
           i.series_id, s.name as series_name
    FROM bookmarks b
    JOIN issues i ON i.id = b.issue_id
    JOIN series s ON s.id = i.series_id
    WHERE b.user_id = ?
    ORDER BY b.created_at DESC
  `).all(userId);

  res.json(bookmarks);
});

// DELETE /api/bookmarks/:id — remove a bookmark
router.delete('/bookmarks/:id', (req, res) => {
  const db = getDb();
  const userId = req.session.userId;
  const id = parseInt(req.params.id, 10);

  const result = db.prepare('DELETE FROM bookmarks WHERE id = ? AND user_id = ?').run(id, userId);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Bookmark not found' });
  }

  res.json({ ok: true });
});

// ============================================
// Reading Lists
// ============================================

// GET /api/lists — user's reading lists with item counts
router.get('/lists', (req, res) => {
  const db = getDb();
  const userId = req.session.userId;

  const lists = db.prepare(`
    SELECT rl.*, COUNT(rli.id) as item_count
    FROM reading_lists rl
    LEFT JOIN reading_list_items rli ON rli.list_id = rl.id
    WHERE rl.user_id = ?
    GROUP BY rl.id
    ORDER BY rl.created_at ASC
  `).all(userId);

  res.json(lists);
});

// POST /api/lists — create a list
router.post('/lists', (req, res) => {
  const db = getDb();
  const userId = req.session.userId;
  const { name } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Name is required' });
  }

  const result = db.prepare(`
    INSERT INTO reading_lists (user_id, name) VALUES (?, ?)
  `).run(userId, name.trim());

  res.json({ ok: true, id: Number(result.lastInsertRowid), name: name.trim() });
});

// PUT /api/lists/:id — rename a list
router.put('/lists/:id', (req, res) => {
  const db = getDb();
  const userId = req.session.userId;
  const id = parseInt(req.params.id, 10);
  const { name } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Name is required' });
  }

  const result = db.prepare('UPDATE reading_lists SET name = ? WHERE id = ? AND user_id = ?')
    .run(name.trim(), id, userId);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'List not found' });
  }

  res.json({ ok: true });
});

// DELETE /api/lists/:id — delete a list and its items
router.delete('/lists/:id', (req, res) => {
  const db = getDb();
  const userId = req.session.userId;
  const id = parseInt(req.params.id, 10);

  const list = db.prepare('SELECT * FROM reading_lists WHERE id = ? AND user_id = ?').get(id, userId);
  if (!list) {
    return res.status(404).json({ error: 'List not found' });
  }

  db.prepare('DELETE FROM reading_list_items WHERE list_id = ?').run(id);
  db.prepare('DELETE FROM reading_lists WHERE id = ?').run(id);

  res.json({ ok: true });
});

// GET /api/lists/:id — list detail with items
router.get('/lists/:id', (req, res) => {
  const db = getDb();
  const userId = req.session.userId;
  const id = parseInt(req.params.id, 10);

  const list = db.prepare('SELECT * FROM reading_lists WHERE id = ? AND user_id = ?').get(id, userId);
  if (!list) {
    return res.status(404).json({ error: 'List not found' });
  }

  const items = db.prepare(`
    SELECT rli.id as item_id, rli.sort_order, i.id as issue_id, i.title, i.thumbnail_path,
           i.issue_number, i.series_id, s.name as series_name
    FROM reading_list_items rli
    JOIN issues i ON i.id = rli.issue_id
    JOIN series s ON s.id = i.series_id
    WHERE rli.list_id = ?
    ORDER BY rli.sort_order ASC
  `).all(id);

  res.json({ ...list, items });
});

// POST /api/lists/:id/items — add issue to list
router.post('/lists/:id/items', (req, res) => {
  const db = getDb();
  const userId = req.session.userId;
  const listId = parseInt(req.params.id, 10);
  const { issue_id } = req.body;

  if (!issue_id) {
    return res.status(400).json({ error: 'issue_id is required' });
  }

  const list = db.prepare('SELECT * FROM reading_lists WHERE id = ? AND user_id = ?').get(listId, userId);
  if (!list) {
    return res.status(404).json({ error: 'List not found' });
  }

  // Get max sort_order
  const maxRow = db.prepare('SELECT MAX(sort_order) as max_order FROM reading_list_items WHERE list_id = ?').get(listId);
  const sortOrder = (maxRow.max_order || 0) + 1;

  try {
    const result = db.prepare(`
      INSERT INTO reading_list_items (list_id, issue_id, sort_order) VALUES (?, ?, ?)
    `).run(listId, issue_id, sortOrder);

    // Log activity — one per series+list, not per issue
    const issue = db.prepare('SELECT series_id FROM issues WHERE id = ?').get(issue_id);
    if (issue) {
      const recentAdd = db.prepare(
        "SELECT id FROM activity WHERE user_id = ? AND action_type = 'added_to_list' AND series_id = ? AND list_name = ? AND created_at > datetime('now', '-5 minutes')"
      ).get(userId, issue.series_id, list.name);
      if (!recentAdd) {
        db.prepare('INSERT INTO activity (user_id, action_type, series_id, list_name) VALUES (?, ?, ?, ?)')
          .run(userId, 'added_to_list', issue.series_id, list.name);
      }
    }

    res.json({ ok: true, id: Number(result.lastInsertRowid) });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Issue already in list' });
    }
    throw err;
  }
});

// DELETE /api/lists/:id/items/:issueId — remove issue from list
router.delete('/lists/:id/items/:issueId', (req, res) => {
  const db = getDb();
  const userId = req.session.userId;
  const listId = parseInt(req.params.id, 10);
  const issueId = parseInt(req.params.issueId, 10);

  const list = db.prepare('SELECT * FROM reading_lists WHERE id = ? AND user_id = ?').get(listId, userId);
  if (!list) {
    return res.status(404).json({ error: 'List not found' });
  }

  const result = db.prepare('DELETE FROM reading_list_items WHERE list_id = ? AND issue_id = ?').run(listId, issueId);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Item not found in list' });
  }

  res.json({ ok: true });
});

// PUT /api/lists/:id/reorder — reorder items
router.put('/lists/:id/reorder', (req, res) => {
  const db = getDb();
  const userId = req.session.userId;
  const listId = parseInt(req.params.id, 10);
  const { issue_ids } = req.body;

  if (!Array.isArray(issue_ids)) {
    return res.status(400).json({ error: 'issue_ids array is required' });
  }

  const list = db.prepare('SELECT * FROM reading_lists WHERE id = ? AND user_id = ?').get(listId, userId);
  if (!list) {
    return res.status(404).json({ error: 'List not found' });
  }

  const update = db.prepare('UPDATE reading_list_items SET sort_order = ? WHERE list_id = ? AND issue_id = ?');
  const txn = db.transaction(() => {
    for (let i = 0; i < issue_ids.length; i++) {
      update.run(i + 1, listId, issue_ids[i]);
    }
  });
  txn();

  res.json({ ok: true });
});

// GET /api/creators/:name/series — find local series by creator name
router.get('/creators/:name/series', (req, res) => {
  const db = getDb();
  const creatorName = req.params.name;

  // Search all issues whose creators JSON field contains the given name
  // creators is stored as a JSON string like [{"name":"John Doe","role":"writer"},...]
  const issues = db.prepare(`
    SELECT DISTINCT s.id, s.name, s.thumbnail_path, s.publisher, s.start_year, s.issue_count
    FROM issues i
    JOIN series s ON s.id = i.series_id
    WHERE i.creators LIKE ?
    ORDER BY s.name ASC
  `).all(`%${creatorName}%`);

  // Further filter: parse JSON to confirm exact name match (not just substring)
  const confirmed = [];
  const seenIds = new Set();

  const allIssues = db.prepare(`
    SELECT i.series_id, i.creators
    FROM issues i
    WHERE i.creators LIKE ?
  `).all(`%${creatorName}%`);

  for (const issue of allIssues) {
    if (!issue.creators) continue;
    try {
      const creators = JSON.parse(issue.creators);
      const match = creators.some(c =>
        c.name && c.name.toLowerCase() === creatorName.toLowerCase()
      );
      if (match && !seenIds.has(issue.series_id)) {
        seenIds.add(issue.series_id);
      }
    } catch (e) {
      // Skip malformed JSON
    }
  }

  const result = issues.filter(s => seenIds.has(s.id));
  res.json(result);
});

// GET /api/thumbnails/:filename — serve thumbnail images
router.get('/thumbnails/:filename', (req, res) => {
  const dataDir = process.env.DATA_DIR || './data';
  const thumbPath = path.join(dataDir, 'thumbnails', req.params.filename);
  res.sendFile(path.resolve(thumbPath));
});

// ---- Ratings & Reviews ----

// POST /api/ratings — create or update a rating
router.post('/ratings', (req, res) => {
  const db = getDb();
  const userId = req.session.userId;
  const { series_id, rating, review } = req.body;

  if (!series_id || !rating || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'series_id and rating (1-5) are required' });
  }

  const existing = db.prepare('SELECT id FROM ratings WHERE user_id = ? AND series_id = ?').get(userId, series_id);

  if (existing) {
    db.prepare('UPDATE ratings SET rating = ?, review = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(rating, review || null, existing.id);
    // Update existing activity or create new one
    const recentActivity = db.prepare(
      "SELECT id FROM activity WHERE user_id = ? AND action_type = 'rated' AND series_id = ?"
    ).get(userId, series_id);
    if (recentActivity) {
      db.prepare('UPDATE activity SET rating = ?, created_at = datetime(\'now\') WHERE id = ?')
        .run(rating, recentActivity.id);
    } else {
      db.prepare('INSERT INTO activity (user_id, action_type, series_id, rating) VALUES (?, ?, ?, ?)')
        .run(userId, 'rated', series_id, rating);
    }
    return res.json({ ok: true, id: existing.id, updated: true });
  }

  const result = db.prepare(
    'INSERT INTO ratings (user_id, series_id, rating, review) VALUES (?, ?, ?, ?)'
  ).run(userId, series_id, rating, review || null);

  // Log activity
  db.prepare('INSERT INTO activity (user_id, action_type, series_id, rating) VALUES (?, ?, ?, ?)')
    .run(userId, 'rated', series_id, rating);

  res.json({ ok: true, id: result.lastInsertRowid, updated: false });
});

// GET /api/ratings/series/:id — all ratings for a series
router.get('/ratings/series/:id', (req, res) => {
  const db = getDb();
  const seriesId = parseInt(req.params.id, 10);

  const ratings = db.prepare(`
    SELECT r.id, r.rating, r.review, r.created_at, r.updated_at, r.user_id,
           u.username, u.display_name, u.avatar_path
    FROM ratings r
    JOIN users u ON u.id = r.user_id
    WHERE r.series_id = ?
    ORDER BY r.updated_at DESC
  `).all(seriesId);

  // Average
  const avg = db.prepare('SELECT AVG(rating) as avg, COUNT(*) as count FROM ratings WHERE series_id = ?').get(seriesId);

  res.json({
    ratings,
    average: avg.avg ? Math.round(avg.avg * 10) / 10 : null,
    count: avg.count,
  });
});

// GET /api/ratings/me — current user's ratings
router.get('/ratings/me', (req, res) => {
  const db = getDb();
  const userId = req.session.userId;

  const ratings = db.prepare(`
    SELECT r.id, r.series_id, r.rating, r.review, r.updated_at,
           s.name as series_name, s.thumbnail_path, s.publisher
    FROM ratings r
    JOIN series s ON s.id = r.series_id
    WHERE r.user_id = ?
    ORDER BY r.updated_at DESC
  `).all(userId);

  res.json(ratings);
});

// DELETE /api/ratings/:id — delete own rating
router.delete('/ratings/:id', (req, res) => {
  const db = getDb();
  const userId = req.session.userId;
  const id = parseInt(req.params.id, 10);

  const rating = db.prepare('SELECT * FROM ratings WHERE id = ? AND user_id = ?').get(id, userId);
  if (!rating) {
    return res.status(404).json({ error: 'Rating not found' });
  }

  db.prepare('DELETE FROM ratings WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ---- User Profiles (public) ----

// GET /api/users/:id — public user profile
router.get('/users/:id', (req, res) => {
  const db = getDb();
  const userId = parseInt(req.params.id, 10);

  const user = db.prepare('SELECT id, username, display_name, avatar_path, is_admin, created_at FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const stats = db.prepare(`
    SELECT
      SUM(CASE WHEN current_page > 0 OR is_read = 1 THEN 1 ELSE 0 END) as started,
      SUM(CASE WHEN is_read = 1 THEN 1 ELSE 0 END) as completed
    FROM reading_progress WHERE user_id = ?
  `).get(userId);

  const ratings = db.prepare(`
    SELECT r.id, r.series_id, r.rating, r.review, r.updated_at,
           s.name as series_name, s.thumbnail_path, s.publisher
    FROM ratings r
    JOIN series s ON s.id = r.series_id
    WHERE r.user_id = ?
    ORDER BY r.updated_at DESC
  `).all(userId);

  // Reading progress
  const progress = db.prepare(`
    SELECT rp.issue_id, rp.current_page, rp.is_read,
           i.title, i.issue_number, i.thumbnail_path, i.page_count, i.series_id,
           s.name as series_name
    FROM reading_progress rp
    JOIN issues i ON i.id = rp.issue_id
    JOIN series s ON s.id = i.series_id
    WHERE rp.user_id = ?
    ORDER BY rp.updated_at DESC
  `).all(userId);

  // Reading lists
  const lists = db.prepare(`
    SELECT rl.id, rl.name, COUNT(rli.id) as item_count
    FROM reading_lists rl
    LEFT JOIN reading_list_items rli ON rli.list_id = rl.id
    WHERE rl.user_id = ?
    GROUP BY rl.id
    ORDER BY rl.created_at DESC
  `).all(userId);

  // Get first cover for each list
  for (const l of lists) {
    const firstItem = db.prepare(`
      SELECT i.thumbnail_path FROM reading_list_items rli
      JOIN issues i ON i.id = rli.issue_id
      WHERE rli.list_id = ? AND i.thumbnail_path IS NOT NULL
      ORDER BY rli.sort_order ASC LIMIT 1
    `).get(l.id);
    l.cover = firstItem ? firstItem.thumbnail_path : null;
  }

  // Bookmarks
  const bookmarks = db.prepare(`
    SELECT b.id, b.page_number, b.note, b.issue_id,
           i.title as issue_title, i.thumbnail_path, i.series_id,
           s.name as series_name
    FROM bookmarks b
    JOIN issues i ON i.id = b.issue_id
    JOIN series s ON s.id = i.series_id
    WHERE b.user_id = ?
    ORDER BY b.created_at DESC
  `).all(userId);

  res.json({
    id: user.id,
    username: user.username,
    displayName: user.display_name || user.username,
    avatarPath: user.avatar_path || null,
    isAdmin: user.is_admin === 1,
    createdAt: user.created_at,
    stats: {
      issuesStarted: stats.started || 0,
      issuesCompleted: stats.completed || 0,
    },
    ratings,
    progress,
    lists,
    bookmarks,
  });
});

// ---- Activity Feed ----

// GET /api/activity — paginated feed (all users)
router.get('/activity', (req, res) => {
  const db = getDb();
  const limit = parseInt(req.query.limit) || 30;
  const offset = parseInt(req.query.offset) || 0;

  const items = db.prepare(`
    SELECT a.id, a.user_id, a.action_type, a.series_id, a.issue_id, a.rating, a.list_name, a.created_at,
           u.username, u.display_name, u.avatar_path,
           s.name as series_name, s.thumbnail_path as series_thumb,
           i.title as issue_title, i.issue_number, i.thumbnail_path as issue_thumb,
           (SELECT COUNT(*) FROM activity_reactions ar WHERE ar.activity_id = a.id) as reaction_count,
           (SELECT COUNT(*) FROM activity_reactions ar WHERE ar.activity_id = a.id AND ar.user_id = ?) as user_reacted
    FROM activity a
    JOIN users u ON u.id = a.user_id
    LEFT JOIN series s ON s.id = a.series_id
    LEFT JOIN issues i ON i.id = a.issue_id
    ORDER BY a.created_at DESC
    LIMIT ? OFFSET ?
  `).all(req.session.userId, limit, offset);

  const total = db.prepare('SELECT COUNT(*) as c FROM activity').get().c;

  res.json({ items, total, limit, offset });
});

// GET /api/activity/user/:id — feed for a specific user
router.get('/activity/user/:id', (req, res) => {
  const db = getDb();
  const targetUserId = parseInt(req.params.id, 10);
  const limit = parseInt(req.query.limit) || 30;
  const offset = parseInt(req.query.offset) || 0;

  const items = db.prepare(`
    SELECT a.id, a.user_id, a.action_type, a.series_id, a.issue_id, a.rating, a.list_name, a.created_at,
           u.username, u.display_name, u.avatar_path,
           s.name as series_name, s.thumbnail_path as series_thumb,
           i.title as issue_title, i.issue_number, i.thumbnail_path as issue_thumb,
           (SELECT COUNT(*) FROM activity_reactions ar WHERE ar.activity_id = a.id) as reaction_count,
           (SELECT COUNT(*) FROM activity_reactions ar WHERE ar.activity_id = a.id AND ar.user_id = ?) as user_reacted
    FROM activity a
    JOIN users u ON u.id = a.user_id
    LEFT JOIN series s ON s.id = a.series_id
    LEFT JOIN issues i ON i.id = a.issue_id
    WHERE a.user_id = ?
    ORDER BY a.created_at DESC
    LIMIT ? OFFSET ?
  `).all(req.session.userId, targetUserId, limit, offset);

  res.json({ items, limit, offset });
});

// POST /api/activity/:id/react — toggle reaction
router.post('/activity/:id/react', (req, res) => {
  const db = getDb();
  const userId = req.session.userId;
  const activityId = parseInt(req.params.id, 10);

  const existing = db.prepare('SELECT id FROM activity_reactions WHERE activity_id = ? AND user_id = ?')
    .get(activityId, userId);

  if (existing) {
    db.prepare('DELETE FROM activity_reactions WHERE id = ?').run(existing.id);
    res.json({ ok: true, reacted: false });
  } else {
    db.prepare('INSERT INTO activity_reactions (activity_id, user_id) VALUES (?, ?)')
      .run(activityId, userId);
    res.json({ ok: true, reacted: true });
  }
});

module.exports = router;
