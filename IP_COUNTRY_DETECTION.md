# Detección de País por IP para Autenticación de Voluntarios

## Overview

El sistema ahora detecta automáticamente el país desde donde el usuario está iniciando sesión, lo que permite asignar el país y el rol de voluntario de forma automática durante el registro.

## Flujo de Autenticación

1. **Prioridad de Detección de País:**
   - **Primera prioridad**: País guardado en la sesión desde el portal (POST `/api/auth/registration-country`)
   - **Segunda prioridad**: País detectado desde la IP del usuario
   - **Fallback para desarrollo**: `DEFAULT_COUNTRY_FOR_LOCAL_DEV` si está en localhost

2. **Proceso de Creación de Usuario:**
   - El usuario se autentica con Google
   - Se detecta el país (usando la prioridad anterior)
   - Se verifica que el país existe en la tabla `countries`
   - Si no existe, se crea automáticamente
   - Se asigna el rol de voluntario (por defecto: "Volunteer")
   - Se guarda el país y el rol al usuario

## Endpoints Disponibles

### 1. GET `/api/auth/ip-country` - Detectar país desde IP
Devuelve el país detectado desde la IP del usuario actual.

```bash
curl http://localhost:3000/api/auth/ip-country
```

**Respuesta:**
```json
{
  "clientIp": "203.0.113.45",
  "detectedCountry": {
    "code": "SV",
    "name": "El Salvador",
    "region": "Central America",
    "source": "ip_geolocation",
    "geoData": {
      "countryCode": "SV",
      "timezone": "America/El_Salvador",
      "city": "San Salvador",
      "latitude": 13.6929,
      "longitude": -89.2182
    }
  },
  "message": "País detectado desde la IP del usuario"
}
```

### 2. POST `/api/auth/registration-country` - Guardar país en sesión (Prioridad 1)
Permite establecer el país explícitamente desde el frontend.

```bash
curl -X POST http://localhost:3000/api/auth/registration-country \
  -H "Content-Type: application/json" \
  -d { "country": "SV" }
```

### 3. GET `/api/auth/google` - Iniciar autenticación
Inicia el flujo de OAuth con Google. Detecta país desde IP como fallback.

### 4. GET `/api/auth/google/callback` - Callback de Google
- Procesa la respuesta de Google
- Detecta país (portal > IP > default)
- Crea usuario si es nuevo
- Asigna país y rol de voluntario

## Configuración

### Variables de Entorno

Añade a tu `.env`:

```env
# País por defecto en desarrollo local (cuando se accede desde localhost)
# Si no está configurado, se requerirá detección por portal o IP
DEFAULT_COUNTRY_FOR_LOCAL_DEV=SV
```

## Servicios Creados/Modificados

### 1. `src/services/geoLocationService.js` (NUEVO)
Servicio de geolocalización por IP.

**Funciones principales:**
- `getClientIp(req)` - Extrae IP del cliente (soporta proxies)
- `getLocationFromIp(ip)` - Obtiene ubicación desde IP
- `detectCountryFromRequestIp(req)` - Detecta país desde IP
- `verifyCountryExists(connection, countryCode)` - Verifica país en BD

### 2. `src/services/authUserService.js` (MODIFICADO)
Servicios de autenticación con Google.

**Cambios:**
- Función `persistGoogleUser()` ahora acepta `ipDetectedCountry` como tercer parámetro
- Nueva función `resolveCountryForNewUser()` determina cuál país usar
- Mejor manejo de errores cuando no se detecta país

### 3. `src/config/passport.js` (MODIFICADO)
Estrategia de autenticación Google.

**Cambios:**
- Importa `geoLocationService`
- Detecta país desde IP antes de persistir usuario
- Pasa país detectado a `persistGoogleUser()`
- Registra logs de país detectado

### 4. `src/routes/auth.js` (MODIFICADO)
Rutas de autenticación.

**Cambios:**
- Importa `geoLocationService`
- Nuevo endpoint GET `/api/auth/ip-country` para debugging
- Permite verificar qué país se detecta desde la IP actual

### 5. `src/config/env.js` (MODIFICADO)
Configuración de variables de entorno.

**Cambios:**
- Nueva variable: `defaultCountryForLocalDev`

## Casos de Uso

### Caso 1: Usuario en producción (IP real)
1. Usuario accede desde El Salvador
2. Sistema detecta país "SV" desde IP
3. Usuario se autentica con Google
4. Se crea usuario con país "SV" y rol "Volunteer"

### Caso 2: Usuario desde portal configurado
1. Usuario accede desde `el-salvador.example.com`
2. Frontend llama POST `/api/auth/registration-country` con país "SV"
3. Sistema guarda en sesión
4. Usuario se autentica con Google
5. Se crea usuario con país "SV" (del portal, no de IP)

### Caso 3: Desarrollo local
1. Usuario accede desde `localhost:3001`
2. IP es `127.0.0.1` (no geolocalizable)
3. Sistema usa `DEFAULT_COUNTRY_FOR_LOCAL_DEV` (ej: "SV")
4. Usuario se autentica con Google
5. Se crea usuario con país "SV" y rol "Volunteer"

## Dependencias

- `geoip-lite` - Librería de geolocalización por IP (sin API key requerida)

## Logs Importantes

El sistema registra:

```javascript
// Cuando se detecta país desde IP
console.log('Country detected from user IP', {
  code: 'SV',
  source: 'ip_geolocation'
});

// Cuando se resuelve país para nuevo usuario
console.log('Country resolved for new user', {
  priority: 'portal', // o 'ip_geolocation'
  source: 'site_entry_api', // o 'ip_geolocation'
  country: { id: 1, code: 'SV' }
});

// Cuando se asigna usuario con país y rol
console.log('Google SSO user assigned with role and country', {
  user: { id: 1, email: 'user@example.com' },
  role: { id: 1, name: 'Volunteer' },
  country: { id: 1, code: 'SV', name: 'El Salvador' }
});
```

## Testing

### 1. Verificar detección desde IP
```bash
curl http://localhost:3000/api/auth/ip-country
```

### 2. Verificar país en sesión
```bash
curl http://localhost:3000/api/auth/registration-country
```

### 3. Completar flujo de autenticación
1. Accede a http://localhost:3001
2. Inicia sesión con Google
3. Verifica que se crea usuario con país y rol correcto en la BD

## Errores y Soluciones

### Error: "Country not detected"
**Solución:**
- Si es desarrollo: configura `DEFAULT_COUNTRY_FOR_LOCAL_DEV` en `.env`
- En producción: asegúrate que la IP es real (no localhost)

### Error: "Country not found in database"
**Solución:**
- El sistema intenta crear el país automáticamente
- Si falla, verifica permisos de BD en tabla `countries`

### Usuario sin país ni rol
**Causa:** Usuario existente creado antes de esta actualización
**Solución:** Actualiza manualmente en BD o crea nuevo usuario

## Notas de Seguridad

- `geoip-lite` usa una base de datos offline (no hace llamadas externas)
- No hay costo de API ni límites de rate limiting
- La IP se extrae de forma segura (soporta proxies X-Forwarded-For)
