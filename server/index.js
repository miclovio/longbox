require('dotenv').config();

const express = require('express');
const session = require('express-session');
const path = require('path');
const { getDb } = require('./db');
const { requireAuth, requireAdmin, attachUser } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3000;
const publicDir = path.join(__dirname, '..', 'public');

// Initialize database
getDb();

// Middleware
app.use(express.json());

app.use(session({
  secret: process.env.SESSION_SECRET || 'longbox-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    httpOnly: true,
    sameSite: 'lax',
  },
}));

app.use(attachUser);

// Static assets (CSS, JS, images) — always public
app.use('/css', express.static(path.join(publicDir, 'css')));
app.use('/js', express.static(path.join(publicDir, 'js')));

// Login page — always accessible
app.get('/login.html', (req, res) => {
  res.sendFile(path.join(publicDir, 'login.html'));
});

// Public API routes (no auth needed)
app.use('/api/auth', require('./routes/auth'));

// OPDS catalog feed (Basic Auth + session auth handled inside the router)
app.use('/opds', require('./routes/opds'));

// Protected API routes (more specific paths first)
app.use('/api/admin', requireAuth, requireAdmin, require('./routes/admin'));
app.use('/api/comicvine', requireAuth, require('./routes/comicvine'));
app.use('/api', requireAuth, require('./routes/api'));

// All other pages — require auth
app.get('/{*splat}', (req, res) => {
  if (req.path.startsWith('/api')) return;

  // Check if setup needed (no users yet)
  const db = getDb();
  const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  if (userCount === 0) {
    return res.redirect('/login.html');
  }

  // Check auth
  if (!req.session || !req.session.userId) {
    return res.redirect('/login.html');
  }

  // Serve the requested file
  const reqPath = req.path === '/' ? '/index.html' : req.path;
  const filePath = path.join(publicDir, reqPath);

  res.sendFile(filePath, (err) => {
    if (err) res.sendFile(path.join(publicDir, 'index.html'));
  });
});

app.listen(PORT, () => {
  console.log(`Longbox server running at http://localhost:${PORT}`);
  console.log(`Comics path: ${process.env.COMICS_PATH || 'NOT SET'}`);
});
