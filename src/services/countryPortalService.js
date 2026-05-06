const env = require('../config/env');

const defaultCountryPortalMappings = [
  {
    code: 'SV',
    name: 'El Salvador',
    region: 'Central America',
    hosts: ['sv', 'elsalvador', 'el-salvador', 'el_salvador', 'salvador'],
  },
];

const normalize = (value) => value?.toString().trim().toLowerCase() || '';

const parseCountryPortalMappings = () => {
  if (!env.countryPortalMappings) return defaultCountryPortalMappings;

  try {
    const parsedMappings = JSON.parse(env.countryPortalMappings);
    if (Array.isArray(parsedMappings) && parsedMappings.length) return parsedMappings;
  } catch (_error) {
    return defaultCountryPortalMappings;
  }

  return defaultCountryPortalMappings;
};

const countryPortalMappings = parseCountryPortalMappings();

const getHostnameParts = (hostname) => normalize(hostname).split('.').filter(Boolean);

const buildUrlCandidate = (value) => {
  if (!value) return null;

  try {
    return new URL(value);
  } catch (_error) {
    try {
      return new URL(`http://${value}`);
    } catch (_nestedError) {
      return null;
    }
  }
};

const getRequestUrlCandidates = (req) => {
  const forwardedProto = req.get('x-forwarded-proto') || req.protocol || 'http';
  const forwardedHost = req.get('x-forwarded-host') || req.get('host');
  const fullRequestUrl = forwardedHost ? `${forwardedProto}://${forwardedHost}${req.originalUrl}` : null;

  return [
    req.query.entryUrl,
    req.query.portalUrl,
    req.get('x-entry-url'),
    req.get('x-portal-url'),
    req.get('referer'),
    req.get('origin'),
    fullRequestUrl,
    req.get('x-forwarded-host'),
    req.get('host'),
  ].filter(Boolean);
};

const findMappingByUrl = (rawUrl) => {
  const url = buildUrlCandidate(rawUrl);
  if (!url) return null;

  const hostname = normalize(url.hostname);
  const hostnameParts = getHostnameParts(hostname);
  const pathname = normalize(url.pathname);

  return (
    countryPortalMappings.find((mapping) => {
      const hostTokens = mapping.hosts || [];

      return hostTokens.some((hostToken) => {
        const normalizedHostToken = normalize(hostToken);

        return (
          hostname === normalizedHostToken ||
          hostnameParts.includes(normalizedHostToken) ||
          hostname.includes(normalizedHostToken) ||
          pathname.includes(normalizedHostToken)
        );
      });
    }) || null
  );
};

const detectCountryFromRequest = (req) => {
  const requestUrlCandidates = getRequestUrlCandidates(req);

  for (const candidate of requestUrlCandidates) {
    const mapping = findMappingByUrl(candidate);
    if (mapping) return mapping;
  }

  return null;
};

module.exports = {
  countryPortalMappings,
  detectCountryFromRequest,
};
