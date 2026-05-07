const express = require('express');
const passport = require('../config/passport');
const env = require('../config/env');
const { detectCountryFromInput, detectCountryFromRequest } = require('../services/countryPortalService');
const { detectCountryFromRequestIp, getClientIp } = require('../services/geoLocationService');

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

const getSupportedCountries = () =>
  env.countryPortalMappings.map(({ code, name, region, aliases }) => ({
    code,
    name,
    region,
    aliases,
  }));

const buildCountryNotFoundResponse = (input) => ({
  message: 'No se pudo detectar país desde la información enviada por el sitio',
  code: 'PORTAL_COUNTRY_NOT_FOUND',
  received: input,
  supportedCountries: getSupportedCountries(),
  examples: [
    { country: 'SV' },
    { countryCode: 'NI' },
    { entryUrl: 'https://example.com/el-salvador/registro' },
  ],
});

router.post('/registration-country', (req, res) => {
  const registrationCountry = detectCountryFromInput(req.body, env.countryPortalMappings, 'site_entry_api');

  if (!registrationCountry) {
    return res.status(422).json(buildCountryNotFoundResponse(req.body));
  }

  req.session.registrationCountry = registrationCountry;

  return res.json({
    message: 'País de registro guardado en sesión',
    country: registrationCountry,
  });
});

router.get('/registration-country', (req, res) => {
  res.json({
    country: req.session.registrationCountry || null,
    supportedCountries: getSupportedCountries(),
  });
});

router.get('/ip-country', (req, res) => {
  const clientIp = getClientIp(req);
  const ipDetectedCountry = detectCountryFromRequestIp(req);

  res.json({
    clientIp,
    detectedCountry: ipDetectedCountry || null,
    message: ipDetectedCountry
      ? 'País detectado desde la IP del usuario'
      : 'No se pudo detectar país desde la IP (probablemente es localhost)',
  });
});

router.delete('/registration-country', (req, res) => {
  delete req.session.registrationCountry;
  res.json({ message: 'País de registro eliminado de sesión' });
});

router.get('/google/config', (_req, res) => {
  res.json({
    loginUrl: `${env.apiBaseUrl}/api/auth/google`,
    callbackUrl: env.googleCallbackUrl,
    googleCloudAuthorizedRedirectUri: env.googleCallbackUrl,
    googleOAuthScopes: env.googleOAuthScopes,
    countryPortalMappings: env.countryPortalMappings,
    registrationCountryApi: {
      set: `${env.apiBaseUrl}/api/auth/registration-country`,
      get: `${env.apiBaseUrl}/api/auth/registration-country`,
      clear: `${env.apiBaseUrl}/api/auth/registration-country`,
    },
    entryPortalExamples: [
      `${env.apiBaseUrl}/api/auth/google?country=SV`,
      `${env.apiBaseUrl}/api/auth/google?entryUrl=https://el-salvador.example.com/registro`,
      `${env.apiBaseUrl}/api/auth/google?entryUrl=https://example.com/nicaragua/registro`,
    ],
    note: 'Este callbackUrl debe existir exactamente igual en Google Cloud > Authorized redirect URIs. El país se detecta antes de enviar al usuario a Google usando country, entryUrl, Referer, Origin o URL actual.',
  });
});

router.get('/google', (req, res, next) => {
  const registrationCountry = detectCountryFromRequest(req, env.countryPortalMappings);

  if (registrationCountry) {
    req.session.registrationCountry = registrationCountry;
  } else if (!req.session.registrationCountry) {
    console.warn('Entry site country was not available before Google OAuth', {
      hint:
        'El login continuará. Si el usuario es nuevo, primero guarda el país con POST /api/auth/registration-country o inicia con ?country=SV.',
      referer: req.get('referer') || null,
      origin: req.get('origin') || null,
      currentUrl: `${req.protocol}://${req.get('host')}${req.originalUrl}`,
    });
  }

  return passport.authenticate('google', {
    scope: env.googleOAuthScopes,
    session: true,
  })(req, res, next);
});

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
