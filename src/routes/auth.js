const express = require('express');
const passport = require('../config/passport');

const router = express.Router();

const frontendSuccessUrl = process.env.FRONTEND_SUCCESS_URL || process.env.CLIENT_URL;

router.get(
  '/google',
  passport.authenticate('google', {
    scope: ['profile', 'email'],
    session: true,
  })
);

router.get(
  '/google/callback',
  passport.authenticate('google', {
    failureRedirect: '/api/auth/failure',
    session: true,
  }),
  (req, res) => {
    if (frontendSuccessUrl) {
      return res.redirect(frontendSuccessUrl);
    }

    return res.json({
      message: 'Login con Google completado',
      user: req.user,
    });
  }
);

router.get('/me', (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ message: 'No autenticado' });
  }

  return res.json({ user: req.user });
});

router.get('/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) {
      return next(err);
    }

    req.session.destroy(() => {
      res.clearCookie('connect.sid');
      res.json({ message: 'Sesión cerrada' });
    });
  });
});

router.get('/failure', (_req, res) => {
  res.status(401).json({ message: 'Error autenticando con Google' });
});

module.exports = router;
