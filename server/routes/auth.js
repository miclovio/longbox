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

  // Create default reading list
  db.prepare('INSERT INTO reading_lists (user_id, name) VALUES (?, ?)').run(result.lastInsertRowid, 'Want to Read');

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

  // Ensure default reading list exists
  const hasLists = db.prepare('SELECT COUNT(*) as c FROM reading_lists WHERE user_id = ?').get(user.id).c;
  if (hasLists === 0) {
    db.prepare('INSERT INTO reading_lists (user_id, name) VALUES (?, ?)').run(user.id, 'Want to Read');
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
  const user = db.prepare('SELECT id, username, display_name, avatar_path, is_admin, created_at FROM users WHERE id = ?')
    .get(req.session.userId);

  if (!user) {
    return res.json({ authenticated: false });
  }

  // Get reading stats
  const stats = db.prepare(`
    SELECT
      SUM(CASE WHEN current_page > 0 OR is_read = 1 THEN 1 ELSE 0 END) as started,
      SUM(CASE WHEN is_read = 1 THEN 1 ELSE 0 END) as completed
    FROM reading_progress WHERE user_id = ?
  `).get(user.id);

  res.json({
    authenticated: true,
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
  });
});

// PUT /api/auth/profile — update username
router.put('/profile', (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const db = getDb();
  const { displayName } = req.body;
  if (!displayName || !displayName.trim()) {
    return res.status(400).json({ error: 'Username is required' });
  }
  const name = displayName.trim();
  // Check if username is taken by another user
  const existing = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(name, req.session.userId);
  if (existing) {
    return res.status(409).json({ error: 'Username already taken' });
  }
  db.prepare('UPDATE users SET username = ?, display_name = ? WHERE id = ?').run(name, name, req.session.userId);
  res.json({ ok: true });
});

// POST /api/auth/avatar — upload profile picture
router.post('/avatar', (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const buffer = Buffer.concat(chunks);
    if (buffer.length === 0) {
      return res.status(400).json({ error: 'No image data' });
    }
    if (buffer.length > 5 * 1024 * 1024) {
      return res.status(400).json({ error: 'Image too large (max 5MB)' });
    }

    const dataDir = process.env.DATA_DIR || './data';
    const avatarDir = require('path').join(dataDir, 'avatars');
    require('fs').mkdirSync(avatarDir, { recursive: true });

    const filename = 'user_' + req.session.userId + '.jpg';
    const filePath = require('path').join(avatarDir, filename);

    // Resize to 200x200 with sharp
    const sharp = require('sharp');
    sharp(buffer)
      .resize(200, 200, { fit: 'cover' })
      .jpeg({ quality: 85 })
      .toFile(filePath)
      .then(() => {
        const db = getDb();
        db.prepare('UPDATE users SET avatar_path = ? WHERE id = ?').run(filename, req.session.userId);
        res.json({ ok: true, avatarPath: filename });
      })
      .catch((err) => {
        res.status(500).json({ error: 'Failed to process image: ' + err.message });
      });
  });
});

// GET /api/auth/avatar/:filename — serve avatar image
router.get('/avatar/:filename', (req, res) => {
  const dataDir = process.env.DATA_DIR || './data';
  const filePath = require('path').join(dataDir, 'avatars', req.params.filename);
  if (!require('fs').existsSync(filePath)) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.type('image/jpeg').sendFile(require('path').resolve(filePath));
});

// GET /api/auth/setup — check if any users exist (for first-time setup)
router.get('/setup', (req, res) => {
  const db = getDb();
  const count = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  res.json({ needsSetup: count === 0 });
});

module.exports = router;
