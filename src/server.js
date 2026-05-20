const express = require('express');
const session = require('express-session');
const env = require('./config/env');
const passport = require('./config/passport');
const authRouter = require('./routes/auth');
const crudRouter = require('./routes/crud');
const onboardingRouter = require('./routes/volunteerOnboarding');
const pool = require('./config/db');

const app = express();
const port = env.port;

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', env.clientUrl);
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Country-Code, X-Portal-Country, X-Entry-Url, X-Portal-Url');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  return next();
});

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

app.use('/api/volunteer-onboarding', onboardingRouter);

app.get('/api/trainings', async (_req, res, next) => {
  try {
    const [rows] = await pool.query("SELECT *, 'introduccion' AS stage FROM sessions WHERE session_type = 'specialized' ORDER BY scheduled_date DESC LIMIT 500");
    return res.json(rows);
  } catch (error) {
    return next(error);
  }
});

app.get('/api/trainings/:id', async (req, res, next) => {
  try {
    const [rows] = await pool.query("SELECT *, 'introduccion' AS stage FROM sessions WHERE id = ? AND session_type = 'specialized' LIMIT 1", [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: 'Registro no encontrado' });
    return res.json(rows[0]);
  } catch (error) {
    return next(error);
  }
});

app.post('/api/trainings', async (req, res, next) => {
  try {
    const payload = { ...req.body };
    const allowedFields = [
      'program_id', 'coordinator_id', 'coach_id', 'title', 'description', 'delivery_mode', 'scheduled_date',
      'start_time', 'end_time', 'location', 'virtual_link', 'max_capacity', 'registration_link', 'status',
      'materials_url', 'recording_url'
    ];
    const fields = allowedFields.filter((field) => payload[field] !== undefined);
    if (!fields.length) return res.status(400).json({ message: 'Payload vacío' });

    const columns = ['session_type', ...fields].map((field) => `\`${field}\``).join(', ');
    const placeholders = ['?', ...fields.map(() => '?')].join(', ');
    const values = ['specialized', ...fields.map((field) => payload[field])];

    const [result] = await pool.query(`INSERT INTO sessions (${columns}) VALUES (${placeholders})`, values);
    const [rows] = await pool.query("SELECT *, 'introduccion' AS stage FROM sessions WHERE id = ? LIMIT 1", [result.insertId]);
    return res.status(201).json(rows[0]);
  } catch (error) {
    return next(error);
  }
});

app.put('/api/trainings/:id', async (req, res, next) => {
  try {
    const payload = { ...req.body };
    const allowedFields = [
      'program_id', 'coordinator_id', 'coach_id', 'title', 'description', 'delivery_mode', 'scheduled_date',
      'start_time', 'end_time', 'location', 'virtual_link', 'max_capacity', 'registration_link', 'status',
      'materials_url', 'recording_url'
    ];
    const fields = allowedFields.filter((field) => payload[field] !== undefined);
    if (!fields.length) return res.status(400).json({ message: 'Payload vacío' });

    const setClause = ['`session_type` = ?'].concat(fields.map((field) => `\`${field}\` = ?`)).join(', ');
    const values = ['specialized', ...fields.map((field) => payload[field]), req.params.id];

    const [result] = await pool.query(`UPDATE sessions SET ${setClause} WHERE id = ? AND session_type = 'specialized'`, values);
    if (result.affectedRows === 0) return res.status(404).json({ message: 'Registro no encontrado' });

    const [rows] = await pool.query("SELECT *, 'introduccion' AS stage FROM sessions WHERE id = ? LIMIT 1", [req.params.id]);
    return res.json(rows[0]);
  } catch (error) {
    return next(error);
  }
});

app.delete('/api/trainings/:id', async (req, res, next) => {
  try {
    const [result] = await pool.query("DELETE FROM sessions WHERE id = ? AND session_type = 'specialized'", [req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ message: 'Registro no encontrado' });
    return res.status(204).send();
  } catch (error) {
    return next(error);
  }
});

app.get('/api/sessions', async (_req, res, next) => {
  try {
    const [rows] = await pool.query("SELECT *, CASE WHEN session_type IN ('general', 'follow-up') THEN 'introduccion' ELSE 'trainings' END AS stage FROM sessions ORDER BY scheduled_date DESC LIMIT 500");
    return res.json(rows);
  } catch (error) {
    return next(error);
  }
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
  console.log(`Google OAuth callback URL: ${env.googleCallbackUrl}`);
});
