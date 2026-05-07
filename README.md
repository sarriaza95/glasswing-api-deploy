# glasswing-api-deploy

API en Express.js con autenticación SSO de Google, persistencia en MySQL y endpoints CRUD genéricos para las tablas de la plataforma de voluntariado.

## Variables de entorno

Copia `.env.example` a `.env` y completa tus credenciales:

```env
PORT=3000
CLIENT_URL=http://localhost:5173
API_BASE_URL=http://localhost:3000
SESSION_SECRET=replace-with-a-long-random-secret
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
GOOGLE_CALLBACK_URL=http://localhost:3000/api/auth/google/callback
FRONTEND_SUCCESS_URL=http://localhost:5173/auth/success
FRONTEND_AUTH_ERROR_URL=http://localhost:5173/auth/error
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=
DB_NAME=volunteer_platform
DB_POOL_SIZE=10
DEFAULT_VOLUNTEER_ROLE_NAME=Volunteer
```

### Configuración opcional de países por portal

El país **no se toma de Google** y **no se asigna por defecto**. Se detecta antes de iniciar Google OAuth usando el portal de entrada: query params, URL de entrada, `Referer`, `Origin`, host/subdominio o path.

Por defecto se incluyen países de Centroamérica:

- `SV` / El Salvador
- `NI` / Nicaragua
- `GT` / Guatemala
- `HN` / Honduras
- `CR` / Costa Rica
- `PA` / Panamá
- `BZ` / Belize

Puedes reemplazar o ampliar esos mapeos con `COUNTRY_PORTAL_MAPPINGS` como JSON:

```env
COUNTRY_PORTAL_MAPPINGS=[{"code":"SV","name":"El Salvador","region":"Central America","aliases":["sv","el-salvador","elsalvador","salvador"]},{"code":"NI","name":"Nicaragua","region":"Central America","aliases":["ni","nicaragua"]}]
```

Cada `alias` se compara contra partes del host, subdominio, path y query string. Por ejemplo, todas estas entradas pueden asignar El Salvador sin pedir dato manual al usuario:

```text
http://localhost:3000/api/auth/google?country=SV
http://localhost:3000/api/auth/google?entryUrl=https://el-salvador.example.com/registro
http://localhost:3000/api/auth/google?entryUrl=https://example.com/el-salvador/registro
```

Para Nicaragua:

```text
http://localhost:3000/api/auth/google?country=NI
http://localhost:3000/api/auth/google?entryUrl=https://nicaragua.example.com/registro
http://localhost:3000/api/auth/google?entryUrl=https://example.com/nicaragua/registro
```

## Instalación y ejecución

```bash
npm install
npm run dev
```

Servidor por defecto en `http://localhost:3000`.

## Endpoints Auth

- `GET /health`
- `GET /api/auth/google`
- `GET /api/auth/google/config`
- `GET /api/auth/google/callback`
- `GET /api/auth/me`
- `GET /api/auth/logout`
- `GET /api/auth/failure`

### Configuración correcta para Google OAuth local

El `GOOGLE_CALLBACK_URL` debe coincidir exactamente con uno de los **URIs de redireccionamiento autorizados** configurados en Google Cloud. Si el backend se mantiene en el puerto `3000`, no uses el callback con puerto `4000`; registra este URI en Google Cloud:

```text
http://localhost:3000/api/auth/google/callback
```

Para diagnosticar qué callback, scopes y mapeos de país usa la API, abre:

```text
http://localhost:3000/api/auth/google/config
```

Si Google muestra `Error 400: redirect_uri_mismatch`, revisa que el valor `callbackUrl` de ese endpoint sea idéntico al URI registrado en Google Cloud. Debe coincidir en protocolo (`http`/`https`), host, puerto, ruta y slash final.

### Persistencia automática de usuarios Google

Después de un login exitoso con Google, la API guarda o actualiza al usuario en la tabla `users`. Durante ese proceso:

- Detecta el país desde el portal de entrada **antes** de redirigir a Google.
- Guarda el país detectado en sesión para usarlo al crear la cuenta durante el callback OAuth.
- Busca o crea el rol configurado en `DEFAULT_VOLUNTEER_ROLE_NAME`.
- Busca o crea el país detectado desde el portal.
- Crea usuarios nuevos con rol voluntario y país detectado.
- Para usuarios existentes, actualiza datos de Google y `last_login_at`, pero **no sobrescribe `country_id` ni `role_id`**, para permitir overrides desde el panel admin.
- Escribe en consola `Google SSO user assigned` con el usuario, rol y país finalmente asignados.

Si no se detecta país desde el portal de entrada, el login falla con `PORTAL_COUNTRY_NOT_FOUND` porque `users.country_id` es obligatorio y no se asigna ningún país por defecto.

## Endpoints CRUD (todas las tablas)

Base path: `/api`

- `GET /api/meta/tables` lista tablas habilitadas.
- `GET /api/:table` lista registros (máximo 500).
- `GET /api/:table/:id` obtiene registro por id.
- `POST /api/:table` crea registro.
- `PUT /api/:table/:id` actualiza registro.
- `DELETE /api/:table/:id` elimina registro.

### Tablas soportadas

- `roles`
- `countries`
- `users`
- `programs`
- `volunteers`
- `volunteer_programs`
- `sessions`
- `session_attendance`
- `follow_ups`
- `email_templates`
- `settings`
- `audit_log`

## Ejemplos

```bash
# Listar roles
curl http://localhost:3000/api/roles

# Crear role
curl -X POST http://localhost:3000/api/roles \
  -H "Content-Type: application/json" \
  -d '{"name":"Volunteer","description":"Rol base"}'
```

## Nota

El CRUD es genérico por tabla y usa el campo `id` como primary key para rutas `/:id`, alineado con tu script SQL.
