# glasswing-api-deploy

API en Express.js con autenticación SSO de Google y CRUD para las tablas del esquema MySQL.
API base en Express.js con autenticación SSO de Google (sin persistencia en base de datos por ahora).

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
2. Completa:

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
- `GET /auth/google`
- `GET /auth/google/callback`
- `GET /auth/me`
- `GET /auth/logout`
- `GET /auth/failure`

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
## Endpoints

- `GET /health` -> estado del servicio
- `GET /auth/google` -> inicia OAuth con Google
- `GET /auth/google/callback` -> callback OAuth
- `GET /auth/me` -> obtiene usuario autenticado en sesión
- `GET /auth/logout` -> cierra sesión

## Nota sobre MySQL

No se guarda información todavía. El flujo actual deja listo el login y la sesión en memoria para después conectar MySQL y persistir usuarios/roles cuando se requiera.
