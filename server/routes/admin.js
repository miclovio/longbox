const express = require('express');
const bcrypt = require('bcrypt');
const fs = require('fs');
const path = require('path');
const { scanAllPaths, getComicsPaths } = require('../services/scanner');
const { getDb } = require('../db');

const router = express.Router();
const SALT_ROUNDS = 10;

let scanInProgress = false;
let lastScanResult = null;

// POST /api/admin/scan — trigger a library scan
router.post('/scan', async (req, res) => {
  if (scanInProgress) {
    return res.status(409).json({ error: 'Scan already in progress' });
  }

  const paths = getComicsPaths();
  if (paths.length === 0) {
    return res.status(500).json({ error: 'No COMICS_PATH configured' });
  }

  scanInProgress = true;
  res.json({ message: 'Scan started' });

  try {
    lastScanResult = await scanAllPaths((progress) => {
      console.log(`Scanning: ${progress.processed}/${progress.total} — ${progress.seriesName}`);
    });
    console.log('Scan complete:', lastScanResult);
  } catch (err) {
    console.error('Scan failed:', err);
    lastScanResult = { error: err.message };
  } finally {
    scanInProgress = false;
  }
});

// GET /api/admin/scan/status — check scan status
router.get('/scan/status', (req, res) => {
  res.json({
    scanning: scanInProgress,
    lastResult: lastScanResult,
  });
});

// GET /api/admin/users — list all users
router.get('/users', (req, res) => {
  const db = getDb();
  const users = db.prepare(`
    SELECT id, username, is_admin, created_at FROM users ORDER BY created_at ASC
  `).all();
  res.json(users.map(u => ({
    id: u.id,
    username: u.username,
    isAdmin: u.is_admin === 1,
    createdAt: u.created_at,
  })));
});

// DELETE /api/admin/users/:id — delete a non-admin user
router.delete('/users/:id', (req, res) => {
  const db = getDb();
  const targetId = parseInt(req.params.id, 10);

  const target = db.prepare('SELECT id, username, is_admin FROM users WHERE id = ?').get(targetId);
  if (!target) {
    return res.status(404).json({ error: 'User not found' });
  }

  if (target.is_admin === 1) {
    return res.status(403).json({ error: 'Cannot delete an admin user' });
  }

  // Delete user's reading progress first
  db.prepare('DELETE FROM reading_progress WHERE user_id = ?').run(targetId);
  db.prepare('DELETE FROM users WHERE id = ?').run(targetId);

  res.json({ message: `User "${target.username}" deleted` });
});

// POST /api/admin/users — create a new user
router.post('/users', async (req, res) => {
  const { username, password, isAdmin } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const db = getDb();
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    return res.status(409).json({ error: 'Username already taken' });
  }

  const hash = await bcrypt.hash(password, SALT_ROUNDS);
  db.prepare('INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, ?)')
    .run(username, hash, isAdmin ? 1 : 0);

  res.json({ message: `User "${username}" created` });
});

// PUT /api/admin/users/:id/toggle-admin — toggle admin status
router.put('/users/:id/toggle-admin', (req, res) => {
  const db = getDb();
  const targetId = parseInt(req.params.id, 10);
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);

  if (!target) return res.status(404).json({ error: 'User not found' });

  // Don't let the only admin demote themselves
  if (target.is_admin === 1) {
    const adminCount = db.prepare('SELECT COUNT(*) as c FROM users WHERE is_admin = 1').get().c;
    if (adminCount <= 1) {
      return res.status(400).json({ error: 'Cannot demote the only admin' });
    }
  }

  const newVal = target.is_admin === 1 ? 0 : 1;
  db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(newVal, targetId);
  res.json({ message: `${target.username} is now ${newVal ? 'admin' : 'member'}` });
});

// GET /api/admin/paths — list configured comic folder paths
router.get('/paths', (req, res) => {
  res.json(getComicsPaths());
});

// POST /api/admin/paths — add a new comics folder path
router.post('/paths', (req, res) => {
  const { path: newPath } = req.body;
  if (!newPath || !newPath.trim()) {
    return res.status(400).json({ error: 'Path is required' });
  }

  const cleaned = newPath.trim().replace(/\\/g, '/');

  // Check it exists on disk
  if (!fs.existsSync(cleaned)) {
    return res.status(400).json({ error: `Path does not exist: ${cleaned}` });
  }

  const current = getComicsPaths();
  if (current.includes(cleaned)) {
    return res.status(409).json({ error: 'Path already added' });
  }

  current.push(cleaned);
  updateEnvPaths(current);

  res.json({ message: 'Path added', paths: current });
});

// DELETE /api/admin/paths — remove a comics folder path
router.delete('/paths', (req, res) => {
  const { path: removePath } = req.body;
  if (!removePath) {
    return res.status(400).json({ error: 'Path is required' });
  }

  const current = getComicsPaths();
  const filtered = current.filter(p => p !== removePath);

  if (filtered.length === current.length) {
    return res.status(404).json({ error: 'Path not found' });
  }

  updateEnvPaths(filtered);
  res.json({ message: 'Path removed', paths: filtered });
});

function updateEnvPaths(paths) {
  const envPath = path.join(process.cwd(), '.env');
  let envContent = fs.readFileSync(envPath, 'utf8');
  const newValue = paths.join(',');

  if (envContent.match(/^COMICS_PATH=.*/m)) {
    envContent = envContent.replace(/^COMICS_PATH=.*/m, `COMICS_PATH=${newValue}`);
  } else {
    envContent += `\nCOMICS_PATH=${newValue}\n`;
  }

  fs.writeFileSync(envPath, envContent);
  process.env.COMICS_PATH = newValue;
}

// GET /api/admin/stats — detailed server stats
router.get('/stats', (req, res) => {
  const db = getDb();
  const series = db.prepare('SELECT COUNT(*) as c FROM series').get().c;
  const issues = db.prepare('SELECT COUNT(*) as c FROM issues').get().c;
  const users = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  const thumbsDir = path.join(process.env.DATA_DIR || './data', 'thumbnails');
  const matched = db.prepare('SELECT COUNT(*) as c FROM series WHERE comicvine_id IS NOT NULL').get().c;
  const withThumbs = db.prepare('SELECT COUNT(*) as c FROM issues WHERE thumbnail_path IS NOT NULL').get().c;
  const totalSize = db.prepare('SELECT SUM(file_size) as s FROM issues').get().s || 0;

  // Count thumbnail files
  let thumbCount = 0;
  try { thumbCount = fs.readdirSync(thumbsDir).length; } catch(e) {}

  res.json({
    series, issues, users, matched,
    thumbnails: thumbCount,
    issuesWithThumbs: withThumbs,
    totalFileSize: totalSize,
    comicsPath: process.env.COMICS_PATH || 'NOT SET',
    port: process.env.PORT || 3000,
    comicVineKey: process.env.COMICVINE_API_KEY ? 'Configured' : 'Not set',
  });
});

// GET /api/admin/unmatched — series not matched to Comic Vine
router.get('/unmatched', (req, res) => {
  const db = getDb();
  const unmatched = db.prepare(`
    SELECT id, name, issue_count, thumbnail_path FROM series
    WHERE comicvine_id IS NULL ORDER BY name
  `).all();
  res.json(unmatched);
});

module.exports = router;
