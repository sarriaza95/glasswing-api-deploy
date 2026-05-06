const express = require('express');
const session = require('express-session');
const env = require('./config/env');
const passport = require('./config/passport');
const authRouter = require('./routes/auth');
const crudRouter = require('./routes/crud');

const app = express();
const port = env.port;

app.use(express.json());

app.use(
  session({
    secret: env.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      maxAge: 60 * 60 * 1000,
    },
  })
);

app.use(passport.initialize());
app.use(passport.session());

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    message: 'API running',
  });
});

app.use('/api/auth', authRouter);
app.use('/auth', authRouter);

app.use('/api', crudRouter);

app.use((err, _req, res, _next) => {
  // eslint-disable-next-line no-console
  console.error(err);

  if (err && err.code) {
    return res.status(400).json({
      message: 'Error de base de datos',
      code: err.code,
      detail: err.sqlMessage || err.message,
    });
  }

  return res.status(500).json({ message: 'Error interno del servidor' });
});

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Server listening on http://localhost:${port}`);
  console.log(`Google OAuth callback URL: ${env.googleCallbackUrl}`);
});
