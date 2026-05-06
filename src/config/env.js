require('dotenv').config();

const port = Number(process.env.PORT || 3000);
const apiBaseUrl = process.env.API_BASE_URL || `http://localhost:${port}`;
const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';
const googleCallbackUrl =
  process.env.GOOGLE_CALLBACK_URL || `${apiBaseUrl}/api/auth/google/callback`;
const frontendSuccessUrl = process.env.FRONTEND_SUCCESS_URL || `${clientUrl}/auth/success`;

module.exports = {
  port,
  apiBaseUrl,
  clientUrl,
  googleCallbackUrl,
  frontendSuccessUrl,
  sessionSecret: process.env.SESSION_SECRET || 'dev-secret',
  googleClientId: process.env.GOOGLE_CLIENT_ID,
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
  defaultVolunteerRoleName: process.env.DEFAULT_VOLUNTEER_ROLE_NAME || 'Volunteer',
  defaultCountryCode: process.env.DEFAULT_COUNTRY_CODE || 'SV',
  defaultCountryName: process.env.DEFAULT_COUNTRY_NAME || 'El Salvador',
  defaultCountryRegion: process.env.DEFAULT_COUNTRY_REGION || 'Central America',
};
