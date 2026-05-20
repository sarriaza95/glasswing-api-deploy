const countryDisplayNames = new Intl.DisplayNames(['es'], { type: 'region' });

const DEFAULT_COUNTRY_PORTAL_MAPPINGS = [
  {
    code: 'SV',
    name: 'El Salvador',
    region: 'Central America',
    aliases: ['sv', 'el-salvador', 'elsalvador', 'el_salvador', 'salvador'],
  },
  {
    code: 'NI',
    name: 'Nicaragua',
    region: 'Central America',
    aliases: ['ni', 'nicaragua'],
  },
  {
    code: 'GT',
    name: 'Guatemala',
    region: 'Central America',
    aliases: ['gt', 'guatemala'],
  },
  {
    code: 'HN',
    name: 'Honduras',
    region: 'Central America',
    aliases: ['hn', 'honduras'],
  },
  {
    code: 'CR',
    name: 'Costa Rica',
    region: 'Central America',
    aliases: ['cr', 'costa-rica', 'costarica', 'costa_rica'],
  },
  {
    code: 'PA',
    name: 'Panamá',
    region: 'Central America',
    aliases: ['pa', 'panama', 'panamá'],
  },
  {
    code: 'BZ',
    name: 'Belize',
    region: 'Central America',
    aliases: ['bz', 'belize', 'belice'],
  },
];

class PortalCountryDetectionError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'PortalCountryDetectionError';
    this.code = 'PORTAL_COUNTRY_NOT_FOUND';
    this.statusCode = 422;
    this.details = details;
  }
}

const normalizeCountryCode = (value) => {
  const normalizedValue = value?.toString().trim().toUpperCase();
  return normalizedValue && /^[A-Z]{2}$/.test(normalizedValue) ? normalizedValue : null;
};

const slugify = (value) =>
  value
    ?.toString()
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || '';

const getCountryName = (countryCode, fallbackName) => {
  if (fallbackName) return fallbackName;
  return countryDisplayNames.of(countryCode) || countryCode;
};

const normalizeMapping = (mapping) => {
  const code = normalizeCountryCode(mapping.code);

  if (!code) {
    throw new Error(`COUNTRY_PORTAL_MAPPINGS tiene un código de país inválido: ${mapping.code}`);
  }

  const name = mapping.name || getCountryName(code);
  const aliases = new Set([
    code.toLowerCase(),
    slugify(code),
    slugify(name),
    ...(mapping.aliases || []).map(slugify),
  ]);

  return {
    code,
    name,
    region: mapping.region || null,
    aliases: Array.from(aliases).filter(Boolean),
  };
};

const parseCountryPortalMappings = (rawMappings) => {
  if (!rawMappings) return DEFAULT_COUNTRY_PORTAL_MAPPINGS.map(normalizeMapping);

  try {
    const parsedMappings = JSON.parse(rawMappings);

    if (!Array.isArray(parsedMappings)) {
      throw new Error('Debe ser un arreglo JSON');
    }

    return parsedMappings.map(normalizeMapping);
  } catch (error) {
    throw new Error(`COUNTRY_PORTAL_MAPPINGS inválido: ${error.message}`);
  }
};

const getPortalCandidatesFromUrl = (urlValue) => {
  if (!urlValue) return [];

  try {
    const parsedUrl = new URL(urlValue);
    const hostnameParts = parsedUrl.hostname.split('.').map(slugify);
    const pathParts = parsedUrl.pathname.split('/').map(slugify);
    const queryValues = Array.from(parsedUrl.searchParams.values()).map(slugify);

    return [...hostnameParts, ...pathParts, ...queryValues].filter(Boolean);
  } catch (_error) {
    return [slugify(urlValue)].filter(Boolean);
  }
};

const getRequestEntryUrls = (req) => {
  const directEntryUrl = req.query.entryUrl || req.query.entry_url || req.query.portalUrl;
  const currentUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;

  return [directEntryUrl, req.get('referer'), req.get('origin'), currentUrl].filter(Boolean);
};

const findCountryByCandidates = (candidates, mappings) => {
  const normalizedCandidates = candidates.map(slugify).filter(Boolean);

  return mappings.find((mapping) =>
    mapping.aliases.some((alias) =>
      normalizedCandidates.some(
        (candidate) => candidate === alias || candidate.startsWith(`${alias}-`) || candidate.endsWith(`-${alias}`)
      )
    )
  );
};

const getCountryInputCandidates = (input = {}) => [
  input.country,
  input.countryCode,
  input.country_code,
  input.portalCountry,
  input.portal_country,
  input.code,
  input.name,
  ...getPortalCandidatesFromUrl(input.entryUrl || input.entry_url || input.portalUrl || input.portal_url),
];

const buildDetectedCountry = (detectedCountry, candidates, source) => {
  if (!detectedCountry) return null;

  return {
    ...detectedCountry,
    source,
    matchedCandidates: candidates.filter(Boolean),
  };
};

const detectCountryFromInput = (input, mappings, source = 'site_entry_api') => {
  const candidates = getCountryInputCandidates(input).filter(Boolean);
  const detectedCountry = findCountryByCandidates(candidates, mappings);

  return buildDetectedCountry(detectedCountry, candidates, source);
};

const detectCountryFromRequest = (req, mappings) => {
  const headerCountry = req.get('x-country-code') || req.get('x-portal-country');
  const headerEntryUrl = req.get('x-entry-url') || req.get('x-portal-url');
  const requestInput = {
    ...req.body,
    ...req.query,
    country: req.body?.country || req.query.country || headerCountry,
    countryCode: req.body?.countryCode || req.query.countryCode || req.body?.country_code || req.query.country_code,
    portalCountry: req.body?.portalCountry || req.query.portalCountry || req.body?.portal_country || req.query.portal_country,
    entryUrl: req.body?.entryUrl || req.query.entryUrl || req.body?.entry_url || req.query.entry_url || req.body?.portalUrl || req.query.portalUrl || headerEntryUrl,
  };
  const explicitCountry = detectCountryFromInput(requestInput, mappings, 'site_entry_api');

  if (explicitCountry) return explicitCountry;

  const urlCandidates = getRequestEntryUrls(req).flatMap(getPortalCandidatesFromUrl).filter(Boolean);
  const detectedCountry = findCountryByCandidates(urlCandidates, mappings);

  return buildDetectedCountry(detectedCountry, urlCandidates, 'entry_portal');
};

const requireCountryFromRequest = (req, mappings) => {
  const detectedCountry = detectCountryFromRequest(req, mappings);

  if (detectedCountry) return detectedCountry;

  throw new PortalCountryDetectionError(
    'No se pudo asignar país porque la URL de entrada no coincide con ningún portal configurado',
    {
      checkedInputs: getRequestEntryUrls(req),
      supportedCountries: mappings.map(({ code, name, aliases }) => ({ code, name, aliases })),
      examples: [
        '/api/auth/google?country=SV',
        '/api/auth/google?entryUrl=https://el-salvador.example.com/registro',
        '/api/auth/google?entryUrl=https://example.com/nicaragua/registro',
      ],
    }
  );
};

module.exports = {
  DEFAULT_COUNTRY_PORTAL_MAPPINGS,
  PortalCountryDetectionError,
  detectCountryFromInput,
  detectCountryFromRequest,
  parseCountryPortalMappings,
  requireCountryFromRequest,
};
