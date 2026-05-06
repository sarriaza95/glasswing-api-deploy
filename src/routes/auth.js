const express = require('express');
const passport = require('../config/passport');
const env = require('../config/env');

const router = express.Router();

const appendErrorParams = (url, error) => {
  const redirectUrl = new URL(url);
  redirectUrl.searchParams.set('code', error.code || 'AUTH_ERROR');
  redirectUrl.searchParams.set('message', error.message || 'Error autenticando con Google');

  if (error.details) {
    redirectUrl.searchParams.set('details', JSON.stringify(error.details));
  }

  return redirectUrl.toString();
};

router.get('/google/config', (_req, res) => {
  res.json({
    loginUrl: `${env.apiBaseUrl}/api/auth/google`,
    callbackUrl: env.googleCallbackUrl,
    googleCloudAuthorizedRedirectUri: env.googleCallbackUrl,
    googleOAuthScopes: env.googleOAuthScopes,
    googlePeopleApiEnabled: env.googlePeopleApiEnabled,
    note: 'Este callbackUrl debe existir exactamente igual en Google Cloud > Authorized redirect URIs.',
  });
});

router.get(
  '/google',
  passport.authenticate('google', {
    scope: env.googleOAuthScopes,
    session: true,
  })
);

router.get('/google/callback', (req, res, next) => {
  passport.authenticate('google', { session: true }, (error, user) => {
    if (error) {
      console.error('Google authentication failed', {
        code: error.code,
        message: error.message,
        details: error.details,
      });

      if (env.frontendErrorUrl) {
        return res.redirect(appendErrorParams(env.frontendErrorUrl, error));
      }

      return res.status(error.statusCode || 401).json({
        message: 'Error autenticando con Google',
        code: error.code,
        detail: error.message,
        details: error.details,
      });
    }

    if (!user) {
      return res.redirect('/api/auth/failure');
    }

    return req.logIn(user, (loginError) => {
      if (loginError) return next(loginError);

      if (env.frontendSuccessUrl) {
        return res.redirect(env.frontendSuccessUrl);
      }

      return res.json({
        message: 'Login con Google completado',
        user: req.user,
      });
    });
  })(req, res, next);
});

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
