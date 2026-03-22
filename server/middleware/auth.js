/**
 * Auth middleware — session-based authentication.
 */

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) {
    return next();
  }
  // API requests get 401, page requests redirect to login
  if (req.path.startsWith('/api')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  return res.redirect('/login.html');
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) {
    return next();
  }
  if (req.path.startsWith('/api')) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  return res.redirect('/');
}

/**
 * Attach user info to all requests (if logged in).
 */
function attachUser(req, res, next) {
  if (req.session && req.session.userId) {
    res.locals.user = {
      id: req.session.userId,
      username: req.session.username,
      isAdmin: req.session.isAdmin || false,
    };
  }
  next();
}

module.exports = { requireAuth, requireAdmin, attachUser };
