const pool = require('../config/db');
const env = require('../config/env');

const buildNameParts = (profile) => {
  const emailPrefix = profile.emails?.[0]?.value?.split('@')[0] || 'google-user';
  const fallbackName = profile.displayName || emailPrefix;

  return {
    firstName: profile.name?.givenName || fallbackName,
    lastName: profile.name?.familyName || 'Sin apellido',
  };
};

const mapGoogleProfile = (profile) => {
  const { firstName, lastName } = buildNameParts(profile);

  return {
    googleId: profile.id,
    email: profile.emails?.[0]?.value || null,
    firstName,
    lastName,
    displayName: profile.displayName || `${firstName} ${lastName}`.trim(),
    profileImageUrl: profile.photos?.[0]?.value || null,
  };
};

const getOrCreateVolunteerRole = async (connection) => {
  const [existingRoles] = await connection.execute('SELECT * FROM roles WHERE name = ? LIMIT 1', [
    env.defaultVolunteerRoleName,
  ]);

  if (existingRoles.length) return existingRoles[0];

  await connection.execute(
    'INSERT IGNORE INTO roles (name, description, permissions) VALUES (?, ?, ?)',
    [env.defaultVolunteerRoleName, 'Rol asignado automáticamente al iniciar sesión con Google', JSON.stringify([])]
  );

  const [roles] = await connection.execute('SELECT * FROM roles WHERE name = ? LIMIT 1', [
    env.defaultVolunteerRoleName,
  ]);
  return roles[0];
};

const getOrCreateCountry = async (connection, registrationCountry) => {
  const [existingCountries] = await connection.execute('SELECT * FROM countries WHERE code = ? LIMIT 1', [
    registrationCountry.code,
  ]);

  if (existingCountries.length) return existingCountries[0];

  await connection.execute(
    'INSERT IGNORE INTO countries (code, name, region, status) VALUES (?, ?, ?, ?)',
    [registrationCountry.code, registrationCountry.name, registrationCountry.region || null, 'active']
  );

  const [countries] = await connection.execute('SELECT * FROM countries WHERE code = ? LIMIT 1', [
    registrationCountry.code,
  ]);
  return countries[0];
};

const getUserRole = async (connection, roleId) => {
  const [roles] = await connection.execute('SELECT * FROM roles WHERE id = ? LIMIT 1', [roleId]);
  return roles[0] || null;
};

const getUserCountry = async (connection, countryId) => {
  const [countries] = await connection.execute('SELECT * FROM countries WHERE id = ? LIMIT 1', [countryId]);
  return countries[0] || null;
};

const findExistingUser = async (connection, googleUser) => {
  const [users] = await connection.execute(
    'SELECT * FROM users WHERE google_id = ? OR email = ? LIMIT 1',
    [googleUser.googleId, googleUser.email]
  );

  return users[0] || null;
};

const updateExistingGoogleUser = async (connection, googleUser, existingUser) => {
  await connection.execute(
    `UPDATE users
     SET google_id = ?, email = ?, first_name = ?, last_name = ?, profile_image_url = ?, status = 'active', last_login_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      googleUser.googleId,
      googleUser.email,
      googleUser.firstName,
      googleUser.lastName,
      googleUser.profileImageUrl,
      existingUser.id,
    ]
  );

  const [users] = await connection.execute('SELECT * FROM users WHERE id = ? LIMIT 1', [existingUser.id]);
  return users[0];
};

const createGoogleUser = async (connection, googleUser, role, country) => {
  const [result] = await connection.execute(
    `INSERT INTO users (google_id, email, first_name, last_name, profile_image_url, role_id, country_id, status, last_login_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', CURRENT_TIMESTAMP)`,
    [
      googleUser.googleId,
      googleUser.email,
      googleUser.firstName,
      googleUser.lastName,
      googleUser.profileImageUrl,
      role.id,
      country.id,
    ]
  );

  const [users] = await connection.execute('SELECT * FROM users WHERE id = ? LIMIT 1', [result.insertId]);
  return users[0];
};

const buildMissingCountryError = () => {
  const error = new Error('No se pudo crear el usuario porque no se detectó país de la sesión ni de la ubicación del usuario');
  error.code = 'COUNTRY_NOT_DETECTED';
  error.statusCode = 422;
  error.details = {
    requiredAction:
      'Para usuarios nuevos, inicia el login desde un portal configurado o envía country/entryUrl al endpoint /api/auth/google. Ejemplo: /auth/google?country=SV o /auth/registration-country con POST.',
  };
  return error;
};

/**
 * Determine which country to use for new user
 * Priority: portal country > IP-detected country > error
 */
const resolveCountryForNewUser = async (connection, portalCountry, ipDetectedCountry) => {
  const countryToUse = portalCountry || ipDetectedCountry;

  if (!countryToUse?.code || !countryToUse?.name) {
    throw buildMissingCountryError();
  }

  // Verify country exists or create it
  const country = await getOrCreateCountry(connection, countryToUse);
  
  return {
    country,
    source: portalCountry?.source || ipDetectedCountry?.source,
    priority: portalCountry ? 'portal' : 'ip_geolocation',
  };
};

const persistGoogleUser = async (profile, registrationCountry, ipDetectedCountry) => {
  const googleUser = mapGoogleProfile(profile);

  if (!googleUser.email) {
    throw new Error('Google no devolvió un email para el usuario autenticado');
  }

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const existingUser = await findExistingUser(connection, googleUser);
    let user;

    if (existingUser) {
      user = await updateExistingGoogleUser(connection, googleUser, existingUser);
    } else {
      const countryResolution = await resolveCountryForNewUser(connection, registrationCountry, ipDetectedCountry);
      
      const role = await getOrCreateVolunteerRole(connection);
      user = await createGoogleUser(connection, googleUser, role, countryResolution.country);

      console.log('Country resolved for new user', {
        priority: countryResolution.priority,
        source: countryResolution.source,
        country: {
          id: countryResolution.country.id,
          code: countryResolution.country.code,
        },
      });
    }

    const assignedRole = await getUserRole(connection, user.role_id);
    const assignedCountry = await getUserCountry(connection, user.country_id);

    await connection.commit();

    const persistedUser = {
      provider: 'google',
      id: user.id,
      googleId: user.google_id,
      displayName: googleUser.displayName,
      firstName: user.first_name,
      lastName: user.last_name,
      email: user.email,
      photo: user.profile_image_url,
      status: user.status,
      role: {
        id: assignedRole?.id,
        name: assignedRole?.name,
      },
      country: {
        id: assignedCountry?.id,
        code: assignedCountry?.code,
        name: assignedCountry?.name,
        source: registrationCountry?.source || ipDetectedCountry?.source || 'unknown',
      },
    };

    console.log('Google SSO user assigned with role and country', {
      user: persistedUser,
      role: persistedUser.role,
      country: persistedUser.country,
    });

    return persistedUser;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
};

module.exports = {
  persistGoogleUser,
};
