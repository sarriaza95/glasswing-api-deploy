# glasswing-api-deploy

API base en Express.js con autenticación SSO de Google (sin persistencia en base de datos por ahora).

## Requisitos

- Node.js 18+
- Proyecto OAuth de Google con credenciales web

## Configuración

1. Copia variables de entorno:

```bash
cp .env.example .env
```

2. Completa:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_CALLBACK_URL` (debe coincidir con el redirect URI configurado en Google)
- `SESSION_SECRET`

## Instalación y ejecución

```bash
npm install
npm run dev
```

Servidor por defecto en `http://localhost:3000`.

## Endpoints

- `GET /health` -> estado del servicio
- `GET /auth/google` -> inicia OAuth con Google
- `GET /auth/google/callback` -> callback OAuth
- `GET /auth/me` -> obtiene usuario autenticado en sesión
- `GET /auth/logout` -> cierra sesión

## Nota sobre MySQL

No se guarda información todavía. El flujo actual deja listo el login y la sesión en memoria para después conectar MySQL y persistir usuarios/roles cuando se requiera.
