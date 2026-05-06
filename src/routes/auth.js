const express = require('express');
const passport = require('../config/passport');
const env = require('../config/env');
const { countryPortalMappings, detectCountryFromRequest } = require('../services/countryPortalService');

const router = express.Router();

router.get('/google/config', (_req, res) => {
  res.json({
    loginUrl: `${env.apiBaseUrl}/api/auth/google`,
    callbackUrl: env.googleCallbackUrl,
    googleCloudAuthorizedRedirectUri: env.googleCallbackUrl,
    countryPortalMappings,
    note: 'Este callbackUrl debe existir exactamente igual en Google Cloud > Authorized redirect URIs.',
  });
});

router.get(
  '/google',
  (req, res, next) => {
    const detectedCountry = detectCountryFromRequest(req);

    if (!detectedCountry) {
      return res.status(400).json({
        message: 'No se pudo detectar el país desde la URL de entrada del portal',
        detail:
          'Abre el login desde un portal configurado por país o envía entryUrl con la URL original del portal. Ejemplo: /api/auth/google?entryUrl=https://sv.example.com',
        supportedCountryPortalMappings: countryPortalMappings,
      });
    }

    req.session.registrationCountry = detectedCountry;
    return next();
  },
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
    if (env.frontendSuccessUrl) {
      return res.redirect(env.frontendSuccessUrl);
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
