require('dotenv').config();

const express = require('express');
const session = require('express-session');
const passport = require('./config/passport');
const crudRouter = require('./routes/crud');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-secret',
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

app.get(
  '/auth/google',
  passport.authenticate('google', {
    scope: ['profile', 'email'],
    session: true,
  })
);

app.get(
  '/auth/google/callback',
  passport.authenticate('google', {
    failureRedirect: '/auth/failure',
    session: true,
  }),
  (req, res) => {
    if (process.env.FRONTEND_SUCCESS_URL) {
      return res.redirect(process.env.FRONTEND_SUCCESS_URL);
    }

    return res.json({
      message: 'Login con Google completado',
      user: req.user,
    });
  }
);

app.get('/auth/me', (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ message: 'No autenticado' });
  }

  return res.json({ user: req.user });
});

app.get('/auth/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) {
      return next(err);
    }

    req.session.destroy(() => {
      res.json({ message: 'Sesión cerrada' });
    });
  });
});

app.get('/auth/failure', (_req, res) => {
  res.status(401).json({ message: 'Error autenticando con Google' });
});

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
});
