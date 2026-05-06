# glasswing-api-deploy

API en Express.js con autenticación SSO de Google y CRUD para las tablas del esquema MySQL.

## Requisitos

- Node.js 18+
- MySQL 8+
- Proyecto OAuth de Google con credenciales web

## Configuración

1. Copia variables de entorno:

```bash
cp .env.example .env
```

2. Configura OAuth de Google:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_CALLBACK_URL` (debe coincidir con el redirect URI configurado en Google)
- `SESSION_SECRET`

3. Configura conexión MySQL:

- `DB_HOST`
- `DB_PORT`
- `DB_USER`
- `DB_PASSWORD`
- `DB_NAME`

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

Y usa estas variables:

```env
PORT=3000
CLIENT_URL=http://localhost:5173
API_BASE_URL=http://localhost:3000
GOOGLE_CALLBACK_URL=http://localhost:3000/api/auth/google/callback
FRONTEND_SUCCESS_URL=http://localhost:5173/auth/success
```

Para iniciar el login, abre:

```text
http://localhost:3000/api/auth/google
```

Para diagnosticar qué callback está enviando la API a Google, abre:

```text
http://localhost:3000/api/auth/google/config
```

Si Google muestra `Error 400: redirect_uri_mismatch`, revisa que el valor `callbackUrl` de ese endpoint sea idéntico al URI registrado en Google Cloud. Debe coincidir en protocolo (`http`/`https`), host, puerto, ruta y slash final.

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
