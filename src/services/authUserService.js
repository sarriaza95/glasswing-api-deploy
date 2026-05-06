const pool = require('../config/db');
const env = require('../config/env');
const { getCountryFromGoogle } = require('./googleProfileService');

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

const getOrCreateGoogleCountry = async (connection, googleCountry) => {
  const [existingCountries] = await connection.execute('SELECT * FROM countries WHERE code = ? LIMIT 1', [
    googleCountry.code,
  ]);

  if (existingCountries.length) return existingCountries[0];

  await connection.execute(
    'INSERT IGNORE INTO countries (code, name, region, status) VALUES (?, ?, ?, ?)',
    [googleCountry.code, googleCountry.name, googleCountry.region || null, 'active']
  );

  const [countries] = await connection.execute('SELECT * FROM countries WHERE code = ? LIMIT 1', [
    googleCountry.code,
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

const upsertGoogleUser = async (connection, googleUser, role, country) => {
  const existingUser = await findExistingUser(connection, googleUser);

  if (existingUser) {
    await connection.execute(
      `UPDATE users
       SET google_id = ?, email = ?, first_name = ?, last_name = ?, profile_image_url = ?, role_id = ?, country_id = ?, status = 'active', last_login_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        googleUser.googleId,
        googleUser.email,
        googleUser.firstName,
        googleUser.lastName,
        googleUser.profileImageUrl,
        role.id,
        country.id,
        existingUser.id,
      ]
    );

    const [users] = await connection.execute('SELECT * FROM users WHERE id = ? LIMIT 1', [existingUser.id]);
    return users[0];
  }

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

const persistGoogleUser = async (profile, accessToken) => {
  const googleUser = mapGoogleProfile(profile);

  if (!googleUser.email) {
    throw new Error('Google no devolvió un email para el usuario autenticado');
  }

  const googleCountry = await getCountryFromGoogle(accessToken, profile);

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const role = await getOrCreateVolunteerRole(connection);
    const googleAssignedCountry = await getOrCreateGoogleCountry(connection, googleCountry);
    const user = await upsertGoogleUser(connection, googleUser, role, googleAssignedCountry);
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
        source: googleCountry.source,
      },
    };

    console.log('Google SSO user assigned', {
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
