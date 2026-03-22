const express = require('express');
const bcrypt = require('bcrypt');
const { getDb } = require('../db');

const router = express.Router();
const SALT_ROUNDS = 10;

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  if (username.length < 3) {
    return res.status(400).json({ error: 'Username must be at least 3 characters' });
  }

  if (password.length < 4) {
    return res.status(400).json({ error: 'Password must be at least 4 characters' });
  }

  const db = getDb();

  // Check if username taken
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    return res.status(409).json({ error: 'Username already taken' });
  }

  // First user becomes admin
  const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  const isAdmin = userCount === 0 ? 1 : 0;

  const hash = await bcrypt.hash(password, SALT_ROUNDS);
  const result = db.prepare('INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, ?)')
    .run(username, hash, isAdmin);

  // Auto-login after registration
  req.session.userId = result.lastInsertRowid;
  req.session.username = username;
  req.session.isAdmin = isAdmin === 1;

  res.json({
    id: result.lastInsertRowid,
    username,
    isAdmin: isAdmin === 1,
    message: isAdmin ? 'Admin account created' : 'Account created',
  });
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);

  if (!user) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.isAdmin = user.is_admin === 1;

  res.json({
    id: user.id,
    username: user.username,
    isAdmin: user.is_admin === 1,
  });
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ message: 'Logged out' });
  });
});

// GET /api/auth/me — current user info
router.get('/me', (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.json({ authenticated: false });
  }

  const db = getDb();
  const user = db.prepare('SELECT id, username, is_admin, created_at FROM users WHERE id = ?')
    .get(req.session.userId);

  if (!user) {
    return res.json({ authenticated: false });
  }

  // Get reading stats
  const stats = db.prepare(`
    SELECT
      COUNT(*) as issues_read,
      SUM(CASE WHEN is_read = 1 THEN 1 ELSE 0 END) as completed
    FROM reading_progress WHERE user_id = ?
  `).get(user.id);

  res.json({
    authenticated: true,
    id: user.id,
    username: user.username,
    isAdmin: user.is_admin === 1,
    createdAt: user.created_at,
    stats: {
      issuesStarted: stats.issues_read || 0,
      issuesCompleted: stats.completed || 0,
    },
  });
});

// GET /api/auth/setup — check if any users exist (for first-time setup)
router.get('/setup', (req, res) => {
  const db = getDb();
  const count = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  res.json({ needsSetup: count === 0 });
});

module.exports = router;
