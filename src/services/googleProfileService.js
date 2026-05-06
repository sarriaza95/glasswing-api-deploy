const env = require('../config/env');
const countryDisplayNames = new Intl.DisplayNames(['es'], { type: 'region' });

class GoogleCountryDetectionError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'GoogleCountryDetectionError';
    this.code = 'GOOGLE_COUNTRY_NOT_FOUND';
    this.statusCode = 422;
    this.details = details;
  }
}

const normalizeCountryCode = (value) => {
  const normalizedValue = value?.toString().trim().toUpperCase();
  return normalizedValue && /^[A-Z]{2}$/.test(normalizedValue) ? normalizedValue : null;
};

const getCountryName = (countryCode, fallbackName) => {
  if (fallbackName) return fallbackName;
  return countryDisplayNames.of(countryCode) || countryCode;
};

const parseLocaleCountryCode = (localeValue) => {
  const parts = localeValue?.replace('_', '-').split('-') || [];
  const regionPart = parts.slice(1).find((part) => /^[A-Za-z]{2}$/.test(part));
  return normalizeCountryCode(regionPart);
};

const extractCountryFromPeopleProfile = (peopleProfile) => {
  const addresses = peopleProfile.addresses || [];
  const primaryAddress = addresses.find((address) => address.metadata?.primary) || addresses[0];
  const addressCountryCode = normalizeCountryCode(primaryAddress?.countryCode);

  if (addressCountryCode) {
    return {
      code: addressCountryCode,
      name: getCountryName(addressCountryCode, primaryAddress.country),
      source: 'google_people_address',
    };
  }

  const locales = peopleProfile.locales || [];
  const primaryLocale = locales.find((locale) => locale.metadata?.primary) || locales[0];
  const localeCountryCode = parseLocaleCountryCode(primaryLocale?.value);

  if (localeCountryCode) {
    return {
      code: localeCountryCode,
      name: getCountryName(localeCountryCode),
      source: 'google_people_locale',
    };
  }

  return null;
};

const fetchGooglePeopleProfile = async (accessToken) => {
  const response = await fetch('https://people.googleapis.com/v1/people/me?personFields=addresses,locales', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`No se pudo consultar Google People API: ${response.status} ${errorBody}`);
  }

  return response.json();
};

const getCountryFromGoogle = async (accessToken, profile) => {
  const profileLocaleCountryCode = parseLocaleCountryCode(profile?._json?.locale);

  if (profileLocaleCountryCode) {
    return {
      code: profileLocaleCountryCode,
      name: getCountryName(profileLocaleCountryCode),
      source: 'google_oauth_locale',
    };
  }

  if (!env.googlePeopleApiEnabled) {
    throw new GoogleCountryDetectionError(
      'Google no devolvió país en el locale del perfil OAuth y Google People API está desactivado',
      {
        profileLocale: profile?._json?.locale || null,
        googlePeopleApiEnabled: env.googlePeopleApiEnabled,
        requiredAction:
          'Si necesitas país desde Google cuando el locale no trae región, activa GOOGLE_PEOPLE_API_ENABLED=true y agrega el correo como Test user en Google Cloud OAuth consent screen o verifica la app.',
      }
    );
  }

  const peopleProfile = await fetchGooglePeopleProfile(accessToken);
  const peopleCountry = extractCountryFromPeopleProfile(peopleProfile);

  if (!peopleCountry) {
    throw new GoogleCountryDetectionError('Google People API no devolvió país ni código ISO de país', {
      profileLocale: profile?._json?.locale || null,
      googlePeopleApiEnabled: env.googlePeopleApiEnabled,
      peopleProfileFieldsReceived: Object.keys(peopleProfile || {}),
    });
  }

  return peopleCountry;
};

module.exports = {
  GoogleCountryDetectionError,
  getCountryFromGoogle,
};
