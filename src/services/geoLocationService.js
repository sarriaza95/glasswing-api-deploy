const geoip = require('geoip-lite');
const env = require('../config/env');

/**
 * Extract client IP from request, handling proxies
 */
const getClientIp = (req) => {
  return (
    req.headers['x-forwarded-for']?.split(',')[0].trim() ||
    req.headers['x-real-ip'] ||
    req.connection.remoteAddress ||
    req.socket.remoteAddress ||
    req.ip
  );
};

/**
 * Get location data from IP address
 */
const getLocationFromIp = (ip) => {
  const geo = geoip.lookup(ip);
  
  if (!geo || !geo.country) {
    return null;
  }

  return {
    countryCode: geo.country,
    timezone: geo.timezone,
    city: geo.city || null,
    latitude: geo.ll?.[0] || null,
    longitude: geo.ll?.[1] || null,
    source: 'ip_geolocation',
  };
};

/**
 * Detect country from request IP
 * Returns country code or null if not found
 */
const detectCountryFromRequestIp = (req) => {
  try {
    const clientIp = getClientIp(req);
    
    if (!clientIp || clientIp === '::1' || clientIp === '127.0.0.1') {
      // Local development - use default country from env if available
      if (env.defaultCountryForLocalDev) {
        console.log('Local IP detected, using default country from env:', env.defaultCountryForLocalDev);
        
        // Find country details from mappings
        const countryMapping = env.countryPortalMappings?.find(
          (c) => c.code === env.defaultCountryForLocalDev
        );
        
        return {
          code: env.defaultCountryForLocalDev,
          name: countryMapping?.name || env.defaultCountryForLocalDev,
          region: countryMapping?.region || null,
          source: 'local_dev_default',
        };
      }
      return null;
    }

    const locationData = getLocationFromIp(clientIp);
    
    if (!locationData) {
      console.warn('Could not determine location from IP:', clientIp);
      return null;
    }

    // Map country code to portal country mapping if available
    const portalCountry = env.countryPortalMappings?.find(
      (c) => c.code === locationData.countryCode
    );

    return {
      code: locationData.countryCode,
      name: portalCountry?.name || locationData.countryCode,
      region: portalCountry?.region || null,
      source: 'ip_geolocation',
      geoData: locationData,
    };
  } catch (error) {
    console.error('Error detecting country from IP:', error.message);
    return null;
  }
};

/**
 * Verify if country exists in database
 */
const verifyCountryExists = async (connection, countryCode) => {
  try {
    const [countries] = await connection.execute(
      'SELECT id, code, name, status FROM countries WHERE code = ? LIMIT 1',
      [countryCode]
    );

    if (countries.length > 0) {
      return countries[0];
    }

    return null;
  } catch (error) {
    console.error('Error verifying country in database:', error.message);
    return null;
  }
};

module.exports = {
  getClientIp,
  getLocationFromIp,
  detectCountryFromRequestIp,
  verifyCountryExists,
};
