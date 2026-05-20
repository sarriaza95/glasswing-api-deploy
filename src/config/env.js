require('dotenv').config();

const port = Number(process.env.PORT || 3000);
const apiBaseUrl = process.env.API_BASE_URL || `http://localhost:${port}`;
const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';
const googleCallbackUrl =
  process.env.GOOGLE_CALLBACK_URL || `${apiBaseUrl}/api/auth/google/callback`;
const frontendSuccessUrl = process.env.FRONTEND_SUCCESS_URL || `${clientUrl}/auth/success`;
const frontendErrorUrl = process.env.FRONTEND_AUTH_ERROR_URL || `${clientUrl}/auth/error`;

const { parseCountryPortalMappings } = require('../services/countryPortalService');

const googleOAuthScopes = ['profile', 'email'];
const countryPortalMappings = parseCountryPortalMappings(process.env.COUNTRY_PORTAL_MAPPINGS);

module.exports = {
  port,
  apiBaseUrl,
  clientUrl,
  googleCallbackUrl,
  frontendSuccessUrl,
  frontendErrorUrl,
  sessionSecret: process.env.SESSION_SECRET || 'dev-secret',
  googleClientId: process.env.GOOGLE_CLIENT_ID,
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
  googleOAuthScopes,
  countryPortalMappings,
  defaultVolunteerRoleName: process.env.DEFAULT_VOLUNTEER_ROLE_NAME || 'Volunteer',
};
