const express = require('express');
const passport = require('../config/passport');
const env = require('../config/env');
const crypto = require('crypto');
const pool = require('../config/db');
const { detectCountryFromInput, detectCountryFromRequest } = require('../services/countryPortalService');

const router = express.Router();
const normalizeRoleName = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

const hashPassword = (password) => {
  const salt = crypto.randomBytes(16).toString('hex');
  const iterations = 310000;
  const digest = 'sha256';
  const hash = crypto.pbkdf2Sync(String(password), salt, iterations, 32, digest).toString('hex');
  return `pbkdf2:${digest}:${iterations}:${salt}:${hash}`;
};

const verifyPassword = (password, storedHash) => {
  if (!storedHash || !storedHash.startsWith('pbkdf2:')) return false;
  const [, digest, iterationsValue, salt, originalHash] = storedHash.split(':');
  const iterations = Number(iterationsValue);
  const candidate = crypto.pbkdf2Sync(String(password), salt, iterations, 32, digest).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(originalHash, 'hex'));
};

const getUserById = async (id) => {
  const [rows] = await pool.query(
    `SELECT
      u.id,
      u.google_id,
      u.email,
      u.first_name,
      u.last_name,
      u.phone,
      u.profile_image_url,
      u.role_id,
      u.country_id,
      u.status,
      u.last_login_at,
      r.name AS role_name,
      c.code AS country_code,
      c.name AS country_name
     FROM users u
     LEFT JOIN roles r ON r.id = u.role_id
     LEFT JOIN countries c ON c.id = u.country_id
     WHERE u.id = ?
     LIMIT 1`,
    [id]
  );
  return rows[0] || null;
};

const toSessionUser = (user) => ({
  provider: String(user.google_id || '').startsWith('local:') ? 'local' : 'google',
  id: user.id,
  googleId: user.google_id,
  displayName: [user.first_name, user.last_name].filter(Boolean).join(' ').trim() || user.email,
  firstName: user.first_name,
  lastName: user.last_name,
  email: user.email,
  phone: user.phone,
  photo: user.profile_image_url,
  status: user.status,
  role: {
    id: user.role_id,
    name: user.role_name,
  },
  country: {
    id: user.country_id,
    code: user.country_code,
    name: user.country_name,
  },
});

const ensureAuthenticated = (req, res, next) => {
  if (!req.isAuthenticated?.() || !req.user?.id) {
    return res.status(401).json({ message: 'No autenticado' });
  }
  return next();
};

const requireAdmin = async (req, res, next) => {
  try {
    if (!req.isAuthenticated?.() || !req.user?.id) {
      return res.status(401).json({ message: 'No autenticado' });
    }
    const freshUser = await getUserById(req.user.id);
    if (normalizeRoleName(freshUser?.role_name) !== 'admin' && normalizeRoleName(freshUser?.role_name) !== 'administrador') {
      return res.status(403).json({ message: 'No tienes permisos para realizar esta accion' });
    }
    req.freshUser = freshUser;
    return next();
  } catch (error) {
    return next(error);
  }
};

const validatePassword = (password) =>
  typeof password === 'string' && password.length >= 8;

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

const getDefaultRegistrationCountry = () => {
  const country = env.countryPortalMappings.find(
    (mapping) => mapping.code === env.defaultRegistrationCountryCode
  );

  return {
    ...(country || { code: 'SV', name: 'El Salvador', region: 'Central America', aliases: ['sv'] }),
    source: 'default_registration_country',
    matchedCandidates: [],
  };
};

const buildCountryNotFoundResponse = (input) => ({
  message: 'No se pudo detectar paÃ­s desde la informaciÃ³n enviada por el sitio',
  code: 'PORTAL_COUNTRY_NOT_FOUND',
  received: input,
  supportedCountries: getSupportedCountries(),
  examples: [
    { country: 'SV' },
    { countryCode: 'NI' },
    { entryUrl: 'https://example.com/el-salvador/registro' },
  ],
});


router.get('/countries', async (_req, res, next) => {
  try {
    const [countries] = await pool.query(
      `SELECT id, code, name
       FROM countries
       ORDER BY CASE WHEN code = 'SV' THEN 0 ELSE 1 END, name`
    );
    return res.json(countries);
  } catch (error) {
    return next(error);
  }
});
router.post('/registration-country', (req, res) => {
  const registrationCountry = detectCountryFromInput(req.body, env.countryPortalMappings, 'site_entry_api');

  if (!registrationCountry) {
    return res.status(422).json(buildCountryNotFoundResponse(req.body));
  }

  req.session.registrationCountry = registrationCountry;

  return res.json({
    message: 'PaÃ­s de registro guardado en sesiÃ³n',
    country: registrationCountry,
  });
});

router.get('/registration-country', (req, res) => {
  res.json({
    country: req.session.registrationCountry || null,
    supportedCountries: getSupportedCountries(),
  });
});

router.delete('/registration-country', (req, res) => {
  delete req.session.registrationCountry;
  res.json({ message: 'PaÃ­s de registro eliminado de sesiÃ³n' });
});

router.get('/google/config', (_req, res) => {
  res.json({
    loginUrl: `${env.apiBaseUrl}/api/auth/google`,
    callbackUrl: env.googleCallbackUrl,
    googleCloudAuthorizedRedirectUri: env.googleCallbackUrl,
    googleOAuthScopes: env.googleOAuthScopes,
    countryPortalMappings: env.countryPortalMappings,
    defaultRegistrationCountryCode: env.defaultRegistrationCountryCode,
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
    note: 'Este callbackUrl debe existir exactamente igual en Google Cloud > Authorized redirect URIs. El paÃ­s se detecta antes de enviar al usuario a Google usando country, entryUrl, Referer, Origin o URL actual.',
  });
});

router.get('/google', (req, res, next) => {
  const registrationCountry = detectCountryFromRequest(req, env.countryPortalMappings);

  if (registrationCountry) {
    req.session.registrationCountry = registrationCountry;
  } else if (!req.session.registrationCountry) {
    req.session.registrationCountry = getDefaultRegistrationCountry();
    console.warn('Entry site country was not available before Google OAuth; using default country', {
      hint:
        `El login continuara usando ${req.session.registrationCountry.name} por defecto. Puedes enviar ?country=SV u otro pais configurado para cambiarlo.`,
      referer: req.get('referer') || null,
      origin: req.get('origin') || null,
      currentUrl: `${req.protocol}://${req.get('host')}${req.originalUrl}`,
      defaultCountry: req.session.registrationCountry,
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



router.post('/register', async (req, res, next) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const firstName = String(req.body?.first_name || req.body?.firstName || '').trim();
    const lastName = String(req.body?.last_name || req.body?.lastName || '').trim();
    const phone = String(req.body?.phone || '').trim() || null;
    const countryId = req.body?.country_id || req.body?.countryId || null;
    const password = String(req.body?.password || '');

    if (!email || !firstName || !lastName || !password) {
      return res.status(400).json({ message: 'Correo, nombre, apellido y contrasena son requeridos' });
    }
    if (!validatePassword(password)) {
      return res.status(400).json({ message: 'La contrasena debe tener al menos 8 caracteres' });
    }

    const [existing] = await pool.query('SELECT id FROM users WHERE LOWER(email) = ? LIMIT 1', [email]);
    if (existing.length) {
      return res.status(409).json({ message: 'Ya existe una cuenta con ese correo' });
    }

    const [roles] = await pool.query(
      `SELECT id FROM roles
       WHERE LOWER(name) IN ('volunteer', 'voluntario')
       ORDER BY CASE WHEN LOWER(name) = 'volunteer' THEN 0 ELSE 1 END
       LIMIT 1`
    );
    const volunteerRoleId = roles[0]?.id;
    if (!volunteerRoleId) {
      return res.status(500).json({ message: 'No existe el rol voluntario en la base de datos' });
    }

    let finalCountryId = countryId || null;
    if (!finalCountryId) {
      const [defaultCountries] = await pool.query(
        `SELECT id FROM countries
         WHERE code = ? OR LOWER(name) = LOWER(?)
         ORDER BY CASE WHEN code = ? THEN 0 ELSE 1 END
         LIMIT 1`,
        ['SV', 'El Salvador', 'SV']
      );
      finalCountryId = defaultCountries[0]?.id || null;
    }
    if (!finalCountryId) {
      return res.status(500).json({ message: 'No existe un pais por defecto para registrar voluntarios' });
    }
    const [result] = await pool.query(
      `INSERT INTO users
       (google_id, email, first_name, last_name, phone, role_id, country_id, status, password_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [`local:${email}`, email, firstName, lastName, phone, volunteerRoleId, finalCountryId, 'active', hashPassword(password)]
    );

    const created = await getUserById(result.insertId);
    await pool.query('INSERT IGNORE INTO volunteers (user_id, status) VALUES (?, ?)', [created.id, 'active']);

    const sessionUser = toSessionUser(created);
    return req.logIn(sessionUser, (error) => {
      if (error) return next(error);
      return res.status(201).json({ user: sessionUser });
    });
  } catch (error) {
    return next(error);
  }
});
router.post('/login', async (req, res, next) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');

    if (!email || !password) {
      return res.status(400).json({ message: 'Correo y contrasena son requeridos' });
    }

    const [users] = await pool.query(
      `SELECT u.*, r.name AS role_name, c.code AS country_code, c.name AS country_name
       FROM users u
       LEFT JOIN roles r ON r.id = u.role_id
       LEFT JOIN countries c ON c.id = u.country_id
       WHERE LOWER(u.email) = ?
       LIMIT 1`,
      [email]
    );

    const user = users[0];
    if (!user || user.status !== 'active' || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ message: 'Credenciales invalidas' });
    }

    await pool.query('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?', [user.id]);
    const sessionUser = toSessionUser(user);
    return req.logIn(sessionUser, (error) => {
      if (error) return next(error);
      return res.json({ user: sessionUser });
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/profile', ensureAuthenticated, async (req, res, next) => {
  try {
    const user = await getUserById(req.user.id);
    if (!user) return res.status(404).json({ message: 'Usuario no encontrado' });
    return res.json({ user: toSessionUser(user) });
  } catch (error) {
    return next(error);
  }
});

router.put('/profile', ensureAuthenticated, async (req, res, next) => {
  try {
    const firstName = String(req.body?.first_name || req.body?.firstName || '').trim();
    const lastName = String(req.body?.last_name || req.body?.lastName || '').trim();
    const phone = String(req.body?.phone || '').trim() || null;
    const profileImageUrl = String(req.body?.profile_image_url || req.body?.profileImageUrl || '').trim() || null;

    if (!firstName || !lastName) {
      return res.status(400).json({ message: 'Nombre y apellido son requeridos' });
    }

    await pool.query(
      `UPDATE users
       SET first_name = ?,
           last_name = ?,
           phone = ?,
           profile_image_url = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [firstName, lastName, phone, profileImageUrl, req.user.id]
    );

    const user = await getUserById(req.user.id);
    const sessionUser = toSessionUser(user);
    req.session.passport.user = sessionUser;
    return res.json({ user: sessionUser });
  } catch (error) {
    return next(error);
  }
});

router.put('/profile/password', ensureAuthenticated, async (req, res, next) => {
  try {
    const currentPassword = String(req.body?.current_password || req.body?.currentPassword || '');
    const newPassword = String(req.body?.new_password || req.body?.newPassword || '');

    if (!validatePassword(newPassword)) {
      return res.status(400).json({ message: 'La nueva contrasena debe tener al menos 8 caracteres' });
    }

    const [users] = await pool.query('SELECT id, password_hash FROM users WHERE id = ? LIMIT 1', [req.user.id]);
    const user = users[0];
    if (!user) return res.status(404).json({ message: 'Usuario no encontrado' });
    if (user.password_hash && !verifyPassword(currentPassword, user.password_hash)) {
      return res.status(401).json({ message: 'La contrasena actual no es correcta' });
    }

    await pool.query(
      'UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [hashPassword(newPassword), req.user.id]
    );

    return res.json({ message: 'Contrasena actualizada correctamente' });
  } catch (error) {
    return next(error);
  }
});

router.get('/admin/users', requireAdmin, async (_req, res, next) => {
  try {
    const [users] = await pool.query(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.phone, u.profile_image_url, u.role_id, u.country_id, u.status,
        r.name AS role_name, c.name AS country_name
       FROM users u
       LEFT JOIN roles r ON r.id = u.role_id
       LEFT JOIN countries c ON c.id = u.country_id
       ORDER BY u.created_at DESC, u.id DESC
       LIMIT 500`
    );
    return res.json(users);
  } catch (error) {
    return next(error);
  }
});

router.post('/admin/users', requireAdmin, async (req, res, next) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const firstName = String(req.body?.first_name || req.body?.firstName || '').trim();
    const lastName = String(req.body?.last_name || req.body?.lastName || '').trim();
    const phone = String(req.body?.phone || '').trim() || null;
    const roleId = req.body?.role_id || req.body?.roleId;
    const countryId = req.body?.country_id || req.body?.countryId || null;
    const status = req.body?.status || 'active';
    const password = String(req.body?.password || '');

    if (!email || !firstName || !lastName || !roleId) {
      return res.status(400).json({ message: 'Correo, nombre, apellido y rol son requeridos' });
    }
    if (!validatePassword(password)) {
      return res.status(400).json({ message: 'La contrasena debe tener al menos 8 caracteres' });
    }

    const [existing] = await pool.query('SELECT id FROM users WHERE email = ? LIMIT 1', [email]);
    if (existing.length) return res.status(409).json({ message: 'Ya existe un usuario con ese correo' });

    const [result] = await pool.query(
      `INSERT INTO users
       (google_id, email, first_name, last_name, phone, role_id, country_id, status, password_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [`local:${email}`, email, firstName, lastName, phone, roleId, countryId, status, hashPassword(password)]
    );

    const created = await getUserById(result.insertId);
    if (normalizeRoleName(created?.role_name) === 'volunteer') {
      await pool.query('INSERT IGNORE INTO volunteers (user_id, status) VALUES (?, ?)', [created.id, 'active']);
    }

    return res.status(201).json({ user: toSessionUser(created) });
  } catch (error) {
    return next(error);
  }
});

router.put('/admin/users/:id', requireAdmin, async (req, res, next) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const firstName = String(req.body?.first_name || req.body?.firstName || '').trim();
    const lastName = String(req.body?.last_name || req.body?.lastName || '').trim();
    const phone = String(req.body?.phone || '').trim() || null;
    const roleId = req.body?.role_id || req.body?.roleId;
    const countryId = req.body?.country_id || req.body?.countryId || null;
    const status = req.body?.status || 'active';
    const password = String(req.body?.password || '');

    if (!email || !firstName || !lastName || !roleId) {
      return res.status(400).json({ message: 'Correo, nombre, apellido y rol son requeridos' });
    }

    const fields = [
      'email = ?',
      'first_name = ?',
      'last_name = ?',
      'phone = ?',
      'role_id = ?',
      'country_id = ?',
      'status = ?',
      'updated_at = CURRENT_TIMESTAMP',
    ];
    const params = [email, firstName, lastName, phone, roleId, countryId, status];

    if (password) {
      if (!validatePassword(password)) {
        return res.status(400).json({ message: 'La contrasena debe tener al menos 8 caracteres' });
      }
      fields.splice(fields.length - 1, 0, 'password_hash = ?');
      params.push(hashPassword(password));
    }

    params.push(req.params.id);
    await pool.query(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, params);

    const user = await getUserById(req.params.id);
    if (!user) return res.status(404).json({ message: 'Usuario no encontrado' });
    if (normalizeRoleName(user.role_name) === 'volunteer') {
      await pool.query('INSERT IGNORE INTO volunteers (user_id, status) VALUES (?, ?)', [user.id, 'active']);
    }

    return res.json({ user: toSessionUser(user) });
  } catch (error) {
    return next(error);
  }
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
      res.json({ message: 'SesiÃ³n cerrada' });
    });
  });
});

router.get('/failure', (_req, res) => {
  res.status(401).json({ message: 'Error autenticando con Google' });
});

module.exports = router;
