const express = require('express');
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const env = require('./config/env');
const passport = require('./config/passport');
const authRouter = require('./routes/auth');
const crudRouter = require('./routes/crud');
const onboardingRouter = require('./routes/volunteerOnboarding');
const pool = require('./config/db');
const { apiRoleGate, requireCoachProgramBodyAccess, requireCoachSessionAccess } = require('./middleware/rbac');

const app = express();
const port = env.port;
const uploadRoot = path.join(__dirname, '..', 'uploads');
const volunteerDocumentsDir = path.join(uploadRoot, 'volunteer-documents');

const normalizeText = (value) =>
  String(value)
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/_/g, '-');

const normalizeTrainingEnum = (field, value) => {
  if (value === null || value === undefined || value === '') return value;

  const normalized = normalizeText(value);
  const mappings = {
    delivery_mode: {
      virtual: 'virtual',
      presencial: 'in-person',
      'in-person': 'in-person',
      hibrido: 'hybrid',
      hibrida: 'hybrid',
      hybrid: 'hybrid',
    },
    status: {
      activo: 'scheduled',
      active: 'scheduled',
      pendiente: 'scheduled',
      programado: 'scheduled',
      scheduled: 'scheduled',
      'en-progreso': 'in-progress',
      'in-progress': 'in-progress',
      completado: 'completed',
      completed: 'completed',
      inactivo: 'cancelled',
      inactive: 'cancelled',
      cancelado: 'cancelled',
      cancelled: 'cancelled',
    },
  };

  return mappings[field]?.[normalized] || value;
};

const normalizeDateValue = (value) => {
  if (value === null || value === undefined || value === '') return value;
  const rawValue = String(value).trim();
  const dateMatch = rawValue.match(/^\d{4}-\d{2}-\d{2}/);
  return dateMatch ? dateMatch[0] : value;
};

const normalizeTimeValue = (value) => {
  if (value === null || value === undefined || value === '') return value;
  const rawValue = String(value).trim();
  const timeMatch = rawValue.match(/^\d{2}:\d{2}(:\d{2})?/);
  return timeMatch ? timeMatch[0] : value;
};

const parseJsonField = (value) => {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const normalizeTrainingPayload = (body, user) => {
  const aliases = {
    programId: 'program_id',
    coordinatorId: 'coordinator_id',
    coachId: 'coach_id',
    deliveryMode: 'delivery_mode',
    scheduledDate: 'scheduled_date',
    startTime: 'start_time',
    endTime: 'end_time',
    virtualLink: 'virtual_link',
    maxCapacity: 'max_capacity',
    currentAttendance: 'current_attendance',
    registrationLink: 'registration_link',
    qrCode: 'qr_code',
    materialsUrl: 'materials_url',
    recordingUrl: 'recording_url',
  };
  const allowedFields = [
    'program_id',
    'coordinator_id',
    'coach_id',
    'title',
    'description',
    'delivery_mode',
    'scheduled_date',
    'start_time',
    'end_time',
    'location',
    'virtual_link',
    'max_capacity',
    'current_attendance',
    'registration_link',
    'qr_code',
    'status',
    'materials_url',
    'recording_url',
  ];
  const enumValues = {
    delivery_mode: ['virtual', 'in-person', 'hybrid'],
    status: ['scheduled', 'in-progress', 'completed', 'cancelled'],
  };
  const payload = {};
  const invalidFields = [];

  Object.entries(body || {}).forEach(([rawField, rawValue]) => {
    if (rawField === 'stage' || rawField === 'session_type') return;

    const field = aliases[rawField] || rawField;
    if (!allowedFields.includes(field)) {
      invalidFields.push(rawField);
      return;
    }

    if (enumValues[field]) {
      payload[field] = normalizeTrainingEnum(field, rawValue);
    } else if (field === 'scheduled_date') {
      payload[field] = normalizeDateValue(rawValue);
    } else if (field === 'start_time' || field === 'end_time') {
      payload[field] = normalizeTimeValue(rawValue);
    } else {
      payload[field] = rawValue;
    }
  });

  if (!payload.coordinator_id && user?.id) {
    payload.coordinator_id = user.id;
  }

  const invalidEnums = Object.entries(enumValues)
    .filter(([field, values]) => payload[field] !== undefined && payload[field] !== null && !values.includes(payload[field]))
    .map(([field, allowed]) => ({ field, allowed }));

  return { payload, invalidFields, invalidEnums };
};

const ensureAuthenticated = (req, res, next) => {
  if (!req.isAuthenticated?.() || !req.user?.id) {
    return res.status(401).json({ message: 'No autenticado' });
  }

  return next();
};

const getUserRoleName = async (userId) => {
  const [rows] = await pool.query(
    `SELECT r.name AS role_name
     FROM users u
     LEFT JOIN roles r ON r.id = u.role_id
     WHERE u.id = ?
     LIMIT 1`,
    [userId]
  );
  return normalizeText(rows[0]?.role_name || '');
};

const ensureStaffCanManageVolunteers = async (req, res, next) => {
  try {
    if (!req.isAuthenticated?.() || !req.user?.id) {
      return res.status(401).json({ message: 'No autenticado' });
    }
    const roleName = await getUserRoleName(req.user.id);
    if (!['admin', 'administrator', 'administrador', 'coach', 'entrenador'].includes(roleName)) {
      return res.status(403).json({ message: 'Solo administradores y coaches pueden gestionar como voluntario' });
    }
    return next();
  } catch (error) {
    return next(error);
  }
};

const getVolunteerForRequest = async (req, createIfMissing = false) => {
  const managedVolunteerId = req.session?.managedVolunteerId;
  if (managedVolunteerId) {
    const roleName = await getUserRoleName(req.user.id);
    if (['admin', 'administrator', 'administrador', 'coach', 'entrenador'].includes(roleName)) {
      const [rows] = await pool.query('SELECT * FROM volunteers WHERE id = ? LIMIT 1', [managedVolunteerId]);
      if (rows.length) return rows[0];
    }
  }
  return getVolunteerForUser(req.user.id, createIfMissing);
};

const normalizeAttendanceStatus = (value) => {
  const normalized = normalizeText(value || 'present');
  const statusMap = {
    presente: 'present',
    present: 'present',
    ausente: 'absent',
    absent: 'absent',
    excusado: 'excused',
    excused: 'excused',
  };

  return statusMap[normalized] || null;
};

const getVolunteerForUser = async (userId, createIfMissing = false) => {
  const [existing] = await pool.query('SELECT * FROM volunteers WHERE user_id = ? LIMIT 1', [userId]);
  if (existing.length) return existing[0];
  if (!createIfMissing) return null;

  await pool.query('INSERT IGNORE INTO volunteers (user_id, status) VALUES (?, ?)', [userId, 'active']);
  const [created] = await pool.query('SELECT * FROM volunteers WHERE user_id = ? LIMIT 1', [userId]);
  return created[0] || null;
};

const getVolunteerFormProfile = async (volunteerId) => {
  const [rows] = await pool.query(
    `SELECT
       v.id AS volunteer_id,
       v.specialization,
       v.education_level,
       v.availability,
       v.emergency_contact_name,
       v.emergency_contact_phone,
       v.preferences,
       u.first_name,
       u.last_name,
       u.email,
       u.phone,
       u.country_id,
       c.name AS country_name,
       gc.code_country AS geo_country_code,
       gc.name AS geo_country_name
     FROM volunteers v
     INNER JOIN users u ON u.id = v.user_id
     LEFT JOIN countries c ON c.id = u.country_id
     LEFT JOIN geo_countries gc ON LOWER(gc.name) = LOWER(c.name)
     WHERE v.id = ?
     LIMIT 1`,
    [volunteerId]
  );

  const profile = rows[0] || null;
  if (!profile) return null;

  return {
    ...profile,
    preferences: parseJsonField(profile.preferences) || null,
  };
};

const refreshSessionAttendanceCount = async (sessionId) => {
  await pool.query(
    `UPDATE sessions
     SET current_attendance = (
       SELECT COUNT(*)
       FROM session_attendance
       WHERE session_id = ? AND status = 'present'
     )
     WHERE id = ?`,
    [sessionId, sessionId]
  );
};

const ensureVolunteerProgramEnrollment = async (volunteerId, programId) => {
  if (!volunteerId || !programId) return;

  await pool.query(
    `INSERT INTO volunteer_programs
     (volunteer_id, program_id, start_date, status, progress_percentage)
     VALUES (?, ?, CURDATE(), 'active', 0)
     ON DUPLICATE KEY UPDATE
       status = IF(status = 'dropped', 'active', status),
       updated_at = CURRENT_TIMESTAMP`,
    [volunteerId, programId]
  );
};

const allowedDocumentMimeTypes = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

const documentMimeTypesByExtension = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

const documentExtensionsByMimeType = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

const sanitizeFilePart = (value, fallback = 'documento') =>
  String(value || fallback)
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90) || fallback;

const normalizeDocumentStatus = (value) => {
  const normalized = normalizeText(value || '');
  const statusMap = {
    pending: 'pending',
    pendiente: 'pending',
    approved: 'approved',
    aprobado: 'approved',
    rejected: 'rejected',
    rechazado: 'rejected',
  };

  return statusMap[normalized] || null;
};

const normalizeReminderType = (value) => {
  const normalized = normalizeText(value || '');
  const typeMap = {
    future: 'future',
    futuro: 'future',
    proximo: 'future',
    absence: 'absence',
    ausencia: 'absence',
    inasistencia: 'absence',
  };

  return typeMap[normalized] || null;
};

const normalizeReminderStatus = (value) => {
  const normalized = normalizeText(value || '');
  const statusMap = {
    sent: 'sent',
    enviado: 'sent',
    failed: 'failed',
    fallido: 'failed',
    'dry-run': 'dry-run',
    prueba: 'dry-run',
  };

  return statusMap[normalized] || null;
};

const normalizeVolunteerActionType = (value) => {
  const normalized = normalizeText(value || 'onboarding');
  const actionMap = {
    onboarding: 'onboarding',
    alta: 'onboarding',
    inscripcion: 'onboarding',
    graduation: 'graduation',
    graduacion: 'graduation',
  };

  return actionMap[normalized] || null;
};

const normalizeVolunteerFormType = (value) => {
  const normalized = normalizeText(value || 'adult');
  const typeMap = {
    adult: 'adult',
    adulto: 'adult',
    mayor: 'adult',
    minor: 'minor',
    menor: 'minor',
  };

  return typeMap[normalized] || null;
};

const normalizeVolunteerFormStatus = (value) => {
  const normalized = normalizeText(value || '');
  const statusMap = {
    requested: 'requested',
    solicitado: 'requested',
    'in-progress': 'in_progress',
    in_progress: 'in_progress',
    progreso: 'in_progress',
    submitted: 'submitted',
    enviado: 'submitted',
    approved: 'approved',
    aprobado: 'approved',
    rejected: 'rejected',
    rechazado: 'rejected',
    expired: 'expired',
    vencido: 'expired',
  };

  return statusMap[normalized] || null;
};

const computeVolunteerLifecycleEligibility = async (volunteerId, programId = null) => {
  const programParams = [volunteerId];
  const programWhere = ['vp.volunteer_id = ?', "vp.status IN ('enrolled', 'active')"];
  if (programId) {
    programWhere.push('vp.program_id = ?');
    programParams.push(programId);
  }

  const [programRows] = await pool.query(
    `SELECT vp.program_id, p.name AS program_name
     FROM volunteer_programs vp
     LEFT JOIN programs p ON p.id = vp.program_id
     WHERE ${programWhere.join(' AND ')}`,
    programParams
  );
  const programIds = programRows.map((row) => row.program_id).filter(Boolean);

  const accessConditions = [
    `EXISTS (
      SELECT 1
      FROM session_attendance sa_registered
      WHERE sa_registered.session_id = s.id AND sa_registered.volunteer_id = ?
    )`,
  ];
  const accessParams = [volunteerId];

  if (programIds.length) {
    accessConditions.push(`s.program_id IN (${programIds.map(() => '?').join(', ')})`);
    accessParams.push(...programIds);
  }

  const [sessionRows] = await pool.query(
    `SELECT
      s.id,
      s.title,
      s.program_id,
      s.session_type,
      CASE WHEN s.session_type = 'specialized' THEN 'grupo' ELSE 'introduccion' END AS stage,
      s.scheduled_date,
      s.start_time,
      sa.id AS attendance_id,
      sa.status AS attendance_status
     FROM sessions s
     LEFT JOIN session_attendance sa
       ON sa.session_id = s.id AND sa.volunteer_id = ?
     WHERE s.status <> 'cancelled'
       AND (s.status = 'completed' OR TIMESTAMP(s.scheduled_date, COALESCE(s.end_time, s.start_time, '23:59:59')) <= NOW())
       AND (${accessConditions.join(' OR ')})
     ORDER BY s.scheduled_date DESC, s.start_time DESC`,
    [volunteerId, ...accessParams]
  );

  const missingAttendance = sessionRows.filter((row) => row.attendance_status !== 'present');

  return {
    volunteer_id: volunteerId,
    program_id: programId,
    enrolled_programs: programRows,
    expected_sessions: sessionRows.length,
    present_sessions: sessionRows.length - missingAttendance.length,
    missing_sessions: missingAttendance,
    attendance_complete: missingAttendance.length === 0,
  };
};

const getVolunteerDocumentRows = async (whereClause = '', params = []) => {
  const [rows] = await pool.query(
    `SELECT
      vd.*,
      v.user_id,
      u.first_name,
      u.last_name,
      u.email,
      u.profile_image_url,
      reviewer.first_name AS reviewer_first_name,
      reviewer.last_name AS reviewer_last_name,
      reviewer.email AS reviewer_email
     FROM volunteer_documents vd
     INNER JOIN volunteers v ON v.id = vd.volunteer_id
     INNER JOIN users u ON u.id = v.user_id
     LEFT JOIN users reviewer ON reviewer.id = vd.reviewed_by
     ${whereClause}
     ORDER BY vd.updated_at DESC, vd.uploaded_at DESC`,
    params
  );

  return rows;
};

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

app.use(express.json({ limit: '12mb' }));
app.use('/uploads', express.static(uploadRoot));

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

app.get('/api/geography/countries', ensureAuthenticated, async (_req, res, next) => {
  try {
    const [countries] = await pool.query(
      `SELECT id, code_country, name, glasswing_office
       FROM geo_countries
       ORDER BY glasswing_office DESC, name ASC`
    );
    return res.json(countries);
  } catch (error) {
    return next(error);
  }
});

app.get('/api/geography/states', ensureAuthenticated, async (req, res, next) => {
  try {
    const countryCode = String(req.query.country_code || '').trim();
    const countryName = String(req.query.country_name || '').trim();

    if (!countryCode && !countryName) {
      return res.status(400).json({ message: 'country_code o country_name es requerido' });
    }

    const params = [];
    const conditions = [];
    if (countryCode) {
      conditions.push('gs.fk_code_country = ?');
      params.push(countryCode);
    }
    if (countryName) {
      conditions.push('LOWER(gc.name) = LOWER(?)');
      params.push(countryName);
    }

    const [states] = await pool.query(
      `SELECT gs.id, gs.code_state, gs.name, gs.fk_code_country AS code_country
       FROM geo_states gs
       INNER JOIN geo_countries gc ON gc.code_country = gs.fk_code_country
       WHERE ${conditions.join(' OR ')}
       ORDER BY gs.name ASC`,
      params
    );
    return res.json(states);
  } catch (error) {
    return next(error);
  }
});

app.get('/api/geography/municipalities', ensureAuthenticated, async (req, res, next) => {
  try {
    const stateCode = String(req.query.state_code || '').trim();
    if (!stateCode) return res.status(400).json({ message: 'state_code es requerido' });

    const [municipalities] = await pool.query(
      `SELECT id, code_municipality, name, fk_code_state AS code_state
       FROM geo_municipalities
       WHERE fk_code_state = ?
       ORDER BY name ASC`,
      [stateCode]
    );
    return res.json(municipalities);
  } catch (error) {
    return next(error);
  }
});

app.get('/api/faqs/search', async (req, res, next) => {
  try {
    const query = String(req.query.q || '').trim();
    const category = String(req.query.category || '').trim();
    const countryId = req.query.country_id ? Number(req.query.country_id) : null;
    const limit = Math.min(Math.max(Number(req.query.limit || 5), 1), 10);
    const where = ['is_active = TRUE', 'deleted_at IS NULL'];
    const params = [];

    if (category) {
      where.push('category = ?');
      params.push(category);
    }

    if (countryId) {
      where.push('(country_id IS NULL OR country_id = ?)');
      params.push(countryId);
    }

    if (query) {
      const likeQuery = `%${query}%`;
      where.push('(question LIKE ? OR answer LIKE ?)');
      params.push(likeQuery, likeQuery);
    }

    const [faqs] = await pool.query(
      `SELECT id, question, answer, category, country_id, sort_order, is_featured
       FROM faqs
       WHERE ${where.join(' AND ')}
       ORDER BY
         CASE WHEN country_id IS NULL THEN 1 ELSE 0 END,
         is_featured DESC,
         sort_order ASC,
         id ASC
       LIMIT ?`,
      [...params, limit]
    );

    if (query && faqs.length < limit) {
      const [fallbackFaqs] = await pool.query(
        `SELECT id, question, answer, category, country_id, sort_order, is_featured
         FROM faqs
         WHERE is_active = TRUE
           AND deleted_at IS NULL
           ${countryId ? 'AND (country_id IS NULL OR country_id = ?)' : ''}
         ORDER BY is_featured DESC, sort_order ASC, id ASC
         LIMIT ?`,
        countryId ? [countryId, limit - faqs.length] : [limit - faqs.length]
      );
      const existingIds = new Set(faqs.map((faq) => Number(faq.id)));
      fallbackFaqs.forEach((faq) => {
        if (!existingIds.has(Number(faq.id))) faqs.push(faq);
      });
    }

    return res.json({ query, faqs });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/volunteer-impersonation/:volunteerId/start', ensureStaffCanManageVolunteers, async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT v.id, u.first_name, u.last_name, u.email
       FROM volunteers v
       LEFT JOIN users u ON u.id = v.user_id
       WHERE v.id = ?
       LIMIT 1`,
      [req.params.volunteerId]
    );
    if (!rows.length) return res.status(404).json({ message: 'Voluntario no encontrado' });
    req.session.managedVolunteerId = rows[0].id;
    return req.session.save((sessionError) => {
      if (sessionError) return next(sessionError);
      return res.json({ volunteer: rows[0], managed: true });
    });
  } catch (error) {
    return next(error);
  }
});

app.delete('/api/volunteer-impersonation/stop', ensureAuthenticated, (req, res, next) => {
  delete req.session.managedVolunteerId;
  return req.session.save((sessionError) => {
    if (sessionError) return next(sessionError);
    return res.json({ managed: false });
  });
});
app.use('/api', apiRoleGate);

app.get('/api/trainings', async (_req, res, next) => {
  try {
    const [rows] = await pool.query("SELECT *, 'grupo' AS stage FROM sessions WHERE session_type = 'specialized' ORDER BY scheduled_date DESC LIMIT 500");
    return res.json(rows);
  } catch (error) {
    return next(error);
  }
});

app.get('/api/trainings/:id', async (req, res, next) => {
  try {
    const [rows] = await pool.query("SELECT *, 'grupo' AS stage FROM sessions WHERE id = ? AND session_type = 'specialized' LIMIT 1", [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: 'Registro no encontrado' });
    return res.json(rows[0]);
  } catch (error) {
    return next(error);
  }
});

app.post('/api/trainings', ...requireCoachProgramBodyAccess, async (req, res, next) => {
  try {
    const { payload, invalidFields, invalidEnums } = normalizeTrainingPayload(req.body, req.user);
    if (invalidFields.length) {
      return res.status(400).json({ message: 'Campos no soportados para trainings', fields: invalidFields });
    }
    if (invalidEnums.length) {
      return res.status(400).json({ message: 'Valores invalidos para campos enum', fields: invalidEnums });
    }
    if (!payload.coordinator_id) {
      return res.status(400).json({ message: 'coordinator_id es requerido para crear una capacitacion' });
    }

    const fields = Object.keys(payload);
    if (!fields.length) return res.status(400).json({ message: 'Payload vacio' });

    const columns = ['session_type', ...fields].map((field) => `\`${field}\``).join(', ');
    const placeholders = ['?', ...fields.map(() => '?')].join(', ');
    const values = ['specialized', ...fields.map((field) => payload[field])];

    const [result] = await pool.query(`INSERT INTO sessions (${columns}) VALUES (${placeholders})`, values);
    const [rows] = await pool.query("SELECT *, 'grupo' AS stage FROM sessions WHERE id = ? LIMIT 1", [result.insertId]);
    return res.status(201).json(rows[0]);
  } catch (error) {
    return next(error);
  }
});

app.put('/api/trainings/:id', ...requireCoachSessionAccess, async (req, res, next) => {
  try {
    const { payload, invalidFields, invalidEnums } = normalizeTrainingPayload(req.body, req.user);
    if (invalidFields.length) {
      return res.status(400).json({ message: 'Campos no soportados para trainings', fields: invalidFields });
    }
    if (invalidEnums.length) {
      return res.status(400).json({ message: 'Valores invalidos para campos enum', fields: invalidEnums });
    }

    const fields = Object.keys(payload);
    if (!fields.length) return res.status(400).json({ message: 'Payload vacio' });

    const setClause = ['`session_type` = ?'].concat(fields.map((field) => `\`${field}\` = ?`)).join(', ');
    const values = ['specialized', ...fields.map((field) => payload[field]), req.params.id];

    const [result] = await pool.query(`UPDATE sessions SET ${setClause} WHERE id = ? AND session_type = 'specialized'`, values);
    if (result.affectedRows === 0) return res.status(404).json({ message: 'Registro no encontrado' });

    const [rows] = await pool.query("SELECT *, 'grupo' AS stage FROM sessions WHERE id = ? LIMIT 1", [req.params.id]);
    return res.json(rows[0]);
  } catch (error) {
    return next(error);
  }
});

app.delete('/api/trainings/:id', ...requireCoachSessionAccess, async (req, res, next) => {
  try {
    const [result] = await pool.query("DELETE FROM sessions WHERE id = ? AND session_type = 'specialized'", [req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ message: 'Registro no encontrado' });
    return res.status(204).send();
  } catch (error) {
    return next(error);
  }
});

app.get('/api/sessions', async (req, res, next) => {
  try {
    const stage = req.query.stage ? normalizeText(req.query.stage) : null;
    const where = [];

    if (stage === 'introduccion') {
      where.push("session_type IN ('general', 'follow-up')");
    } else if (stage === 'grupo') {
      where.push("session_type = 'specialized'");
    }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows] = await pool.query(
      `SELECT *, CASE WHEN session_type = 'specialized' THEN 'grupo' ELSE 'introduccion' END AS stage FROM sessions ${whereClause} ORDER BY scheduled_date DESC LIMIT 500`
    );
    return res.json(rows);
  } catch (error) {
    return next(error);
  }
});

app.get('/api/volunteer-attendance/me', ensureAuthenticated, async (req, res, next) => {
  try {
    const volunteer = await getVolunteerForRequest(req, true);
    if (!volunteer) return res.status(404).json({ message: 'Perfil de voluntario no encontrado' });

    const [rows] = await pool.query(
      `SELECT
        s.*,
        CASE WHEN s.session_type = 'specialized' THEN 'grupo' ELSE 'introduccion' END AS stage,
        sa.id AS attendance_id,
        sa.status AS attendance_status,
        sa.attendance_method,
        sa.registered_at,
        sa.attended_at,
        sa.check_in_time,
        sa.check_out_time,
        sa.notes
       FROM sessions s
       LEFT JOIN session_attendance sa
         ON sa.session_id = s.id AND sa.volunteer_id = ?
       WHERE s.status <> 'cancelled'
       ORDER BY s.scheduled_date DESC, s.start_time DESC
       LIMIT 500`,
      [volunteer.id]
    );

    const attendanceRecords = rows.filter((row) => row.attendance_id);
    const presentCount = attendanceRecords.filter((row) => row.attendance_status === 'present').length;
    const absentCount = attendanceRecords.filter((row) => row.attendance_status === 'absent').length;
    const excusedCount = attendanceRecords.filter((row) => row.attendance_status === 'excused').length;

    return res.json({
      volunteer,
      summary: {
        total_sessions: rows.length,
        registered: attendanceRecords.length,
        present: presentCount,
        absent: absentCount,
        excused: excusedCount,
        attendance_rate: attendanceRecords.length
          ? Math.round((presentCount / attendanceRecords.length) * 100)
          : 0,
      },
      sessions: rows,
    });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/volunteer-attendance/register', ensureAuthenticated, async (req, res, next) => {
  try {
    const sessionId = req.body?.session_id;
    const attendanceMethod = req.body?.attendance_method || 'link';

    if (!sessionId) return res.status(400).json({ message: 'session_id es requerido' });
    if (!['link', 'qr', 'manual'].includes(attendanceMethod)) {
      return res.status(400).json({ message: 'attendance_method invalido' });
    }

    const volunteer = await getVolunteerForRequest(req, true);
    if (!volunteer) return res.status(404).json({ message: 'Perfil de voluntario no encontrado' });

    const [sessions] = await pool.query("SELECT id FROM sessions WHERE id = ? AND status <> 'cancelled' LIMIT 1", [
      sessionId,
    ]);
    if (!sessions.length) return res.status(404).json({ message: 'Sesion no encontrada o cancelada' });

    await pool.query(
      `INSERT INTO session_attendance
       (session_id, volunteer_id, attendance_method, status, registered_at, attended_at, check_in_time)
       VALUES (?, ?, ?, 'present', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURTIME())
       ON DUPLICATE KEY UPDATE
         attendance_method = VALUES(attendance_method),
         status = 'present',
         attended_at = CURRENT_TIMESTAMP,
         check_in_time = CURTIME(),
         updated_at = CURRENT_TIMESTAMP`,
      [sessionId, volunteer.id, attendanceMethod]
    );

    await refreshSessionAttendanceCount(sessionId);

    const [rows] = await pool.query(
      `SELECT sa.*, s.title, s.session_type,
        CASE WHEN s.session_type = 'specialized' THEN 'grupo' ELSE 'introduccion' END AS stage
       FROM session_attendance sa
       INNER JOIN sessions s ON s.id = sa.session_id
       WHERE sa.session_id = ? AND sa.volunteer_id = ?
       LIMIT 1`,
      [sessionId, volunteer.id]
    );

    return res.status(201).json(rows[0]);
  } catch (error) {
    return next(error);
  }
});

app.get('/api/attendance-summary', async (_req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT
        s.id,
        s.title,
        s.session_type,
        CASE WHEN s.session_type = 'specialized' THEN 'grupo' ELSE 'introduccion' END AS stage,
        s.delivery_mode,
        s.scheduled_date,
        s.start_time,
        s.end_time,
        s.status,
        COUNT(sa.id) AS total_registered,
        COALESCE(SUM(CASE WHEN sa.status = 'present' THEN 1 ELSE 0 END), 0) AS present_count,
        COALESCE(SUM(CASE WHEN sa.status = 'absent' THEN 1 ELSE 0 END), 0) AS absent_count,
        COALESCE(SUM(CASE WHEN sa.status = 'excused' THEN 1 ELSE 0 END), 0) AS excused_count,
        ROUND(
          COALESCE(SUM(CASE WHEN sa.status = 'present' THEN 1 ELSE 0 END), 0) / NULLIF(COUNT(sa.id), 0) * 100,
          2
        ) AS attendance_percentage
       FROM sessions s
       LEFT JOIN session_attendance sa ON sa.session_id = s.id
       GROUP BY
        s.id,
        s.title,
        s.session_type,
        s.delivery_mode,
        s.scheduled_date,
        s.start_time,
        s.end_time,
        s.status
       ORDER BY s.scheduled_date DESC, s.start_time DESC
       LIMIT 500`
    );

    return res.json(rows);
  } catch (error) {
    return next(error);
  }
});

app.get('/api/attendance-summary/:sessionId', ...requireCoachSessionAccess, async (req, res, next) => {
  try {
    const [sessionRows] = await pool.query(
      `SELECT *, CASE WHEN session_type = 'specialized' THEN 'grupo' ELSE 'introduccion' END AS stage
       FROM sessions
       WHERE id = ?
       LIMIT 1`,
      [req.params.sessionId]
    );
    if (!sessionRows.length) return res.status(404).json({ message: 'Sesion no encontrada' });

    const [attendees] = await pool.query(
      `SELECT
        sa.*,
        v.user_id,
        u.first_name,
        u.last_name,
        u.email,
        u.profile_image_url
       FROM session_attendance sa
       INNER JOIN volunteers v ON v.id = sa.volunteer_id
       INNER JOIN users u ON u.id = v.user_id
       WHERE sa.session_id = ?
       ORDER BY u.first_name, u.last_name`,
      [req.params.sessionId]
    );

    return res.json({ session: sessionRows[0], attendees });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/attendance/mark', ...requireCoachSessionAccess, async (req, res, next) => {
  try {
    const { session_id: sessionId, volunteer_id: volunteerId } = req.body || {};
    const status = normalizeAttendanceStatus(req.body?.status);
    const attendanceMethod = req.body?.attendance_method || 'manual';

    if (!sessionId || !volunteerId) {
      return res.status(400).json({ message: 'session_id y volunteer_id son requeridos' });
    }
    if (!status) return res.status(400).json({ message: 'status invalido' });
    if (!['link', 'qr', 'manual'].includes(attendanceMethod)) {
      return res.status(400).json({ message: 'attendance_method invalido' });
    }

    await pool.query(
      `INSERT INTO session_attendance
       (session_id, volunteer_id, attendance_method, status, registered_at, attended_at, check_in_time)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, IF(? = 'present', CURRENT_TIMESTAMP, NULL), IF(? = 'present', CURTIME(), NULL))
       ON DUPLICATE KEY UPDATE
         attendance_method = VALUES(attendance_method),
         status = VALUES(status),
         attended_at = IF(VALUES(status) = 'present', CURRENT_TIMESTAMP, attended_at),
         check_in_time = IF(VALUES(status) = 'present', CURTIME(), check_in_time),
         updated_at = CURRENT_TIMESTAMP`,
      [sessionId, volunteerId, attendanceMethod, status, status, status]
    );

    await refreshSessionAttendanceCount(sessionId);

    const [rows] = await pool.query('SELECT * FROM session_attendance WHERE session_id = ? AND volunteer_id = ? LIMIT 1', [
      sessionId,
      volunteerId,
    ]);
    return res.json(rows[0]);
  } catch (error) {
    return next(error);
  }
});

app.post('/api/volunteer_group_members', async (req, res, next) => {
  try {
    const { group_id: groupId, volunteer_id: volunteerId } = req.body || {};
    const roleInGroup = req.body?.role_in_group || 'member';
    const status = req.body?.status || 'active';
    const notes = req.body?.notes || null;

    if (!groupId || !volunteerId) {
      return res.status(400).json({ message: 'group_id y volunteer_id son requeridos' });
    }
    if (!['member', 'lead'].includes(roleInGroup)) {
      return res.status(400).json({ message: 'role_in_group invalido' });
    }
    if (!['active', 'inactive', 'completed', 'dropped'].includes(status)) {
      return res.status(400).json({ message: 'status invalido' });
    }

    const [groups] = await pool.query('SELECT * FROM program_groups WHERE id = ? LIMIT 1', [groupId]);
    if (!groups.length) return res.status(404).json({ message: 'Grupo no encontrado' });

    const [volunteers] = await pool.query('SELECT id FROM volunteers WHERE id = ? LIMIT 1', [volunteerId]);
    if (!volunteers.length) return res.status(404).json({ message: 'Voluntario no encontrado' });

    await ensureVolunteerProgramEnrollment(volunteerId, groups[0].program_id);

    await pool.query(
      `INSERT INTO volunteer_group_members
       (group_id, volunteer_id, role_in_group, status, joined_at, notes)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
       ON DUPLICATE KEY UPDATE
         role_in_group = VALUES(role_in_group),
         status = VALUES(status),
         left_at = IF(VALUES(status) IN ('inactive', 'completed', 'dropped'), CURRENT_TIMESTAMP, NULL),
         notes = VALUES(notes),
         updated_at = CURRENT_TIMESTAMP`,
      [groupId, volunteerId, roleInGroup, status, notes]
    );

    const [rows] = await pool.query(
      'SELECT * FROM volunteer_group_members WHERE group_id = ? AND volunteer_id = ? LIMIT 1',
      [groupId, volunteerId]
    );
    return res.status(201).json(rows[0]);
  } catch (error) {
    return next(error);
  }
});

app.put('/api/volunteer_group_members/:id', async (req, res, next) => {
  try {
    const [existingRows] = await pool.query('SELECT * FROM volunteer_group_members WHERE id = ? LIMIT 1', [
      req.params.id,
    ]);
    if (!existingRows.length) return res.status(404).json({ message: 'Registro no encontrado' });

    const current = existingRows[0];
    const groupId = req.body?.group_id || current.group_id;
    const volunteerId = req.body?.volunteer_id || current.volunteer_id;
    const roleInGroup = req.body?.role_in_group || current.role_in_group || 'member';
    const status = req.body?.status || current.status || 'active';
    const notes = req.body?.notes !== undefined ? req.body.notes : current.notes;

    if (!['member', 'lead'].includes(roleInGroup)) {
      return res.status(400).json({ message: 'role_in_group invalido' });
    }
    if (!['active', 'inactive', 'completed', 'dropped'].includes(status)) {
      return res.status(400).json({ message: 'status invalido' });
    }

    const [groups] = await pool.query('SELECT * FROM program_groups WHERE id = ? LIMIT 1', [groupId]);
    if (!groups.length) return res.status(404).json({ message: 'Grupo no encontrado' });

    const [volunteers] = await pool.query('SELECT id FROM volunteers WHERE id = ? LIMIT 1', [volunteerId]);
    if (!volunteers.length) return res.status(404).json({ message: 'Voluntario no encontrado' });

    await ensureVolunteerProgramEnrollment(volunteerId, groups[0].program_id);

    await pool.query(
      `UPDATE volunteer_group_members
       SET group_id = ?,
           volunteer_id = ?,
           role_in_group = ?,
           status = ?,
           left_at = IF(? IN ('inactive', 'completed', 'dropped'), COALESCE(left_at, CURRENT_TIMESTAMP), NULL),
           notes = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [groupId, volunteerId, roleInGroup, status, status, notes, req.params.id]
    );

    const [rows] = await pool.query('SELECT * FROM volunteer_group_members WHERE id = ? LIMIT 1', [req.params.id]);
    return res.json(rows[0]);
  } catch (error) {
    return next(error);
  }
});

app.get('/api/volunteer-documents/me', ensureAuthenticated, async (req, res, next) => {
  try {
    const volunteer = await getVolunteerForRequest(req, true);
    if (!volunteer) return res.status(404).json({ message: 'Perfil de voluntario no encontrado' });

    const documents = await getVolunteerDocumentRows('WHERE vd.volunteer_id = ?', [volunteer.id]);
    return res.json({ volunteer, documents });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/volunteer-documents/upload', ensureAuthenticated, async (req, res, next) => {
  try {
    const volunteer = await getVolunteerForRequest(req, true);
    if (!volunteer) return res.status(404).json({ message: 'Perfil de voluntario no encontrado' });

    const documentType = sanitizeFilePart(req.body?.document_type || 'general');
    const originalFileName = String(req.body?.file_name || '').trim();
    const originalExtension = path.extname(originalFileName).toLowerCase();
    const mimeType = String(req.body?.mime_type || documentMimeTypesByExtension[originalExtension] || '').trim();
    const rawFileData = String(req.body?.file_data || '');

    if (!originalFileName) return res.status(400).json({ message: 'file_name es requerido' });
    if (!rawFileData) return res.status(400).json({ message: 'file_data es requerido' });
    if (!allowedDocumentMimeTypes.has(mimeType)) {
      return res.status(400).json({ message: 'Tipo de archivo no permitido. Usa PDF, JPG, PNG o WEBP.' });
    }

    const base64 = rawFileData.includes(',') ? rawFileData.split(',').pop() : rawFileData;
    const fileBuffer = Buffer.from(base64, 'base64');
    if (!fileBuffer.length) return res.status(400).json({ message: 'Archivo invalido' });
    if (fileBuffer.length > 8 * 1024 * 1024) {
      return res.status(400).json({ message: 'El archivo no puede superar 8MB' });
    }

    await fs.promises.mkdir(volunteerDocumentsDir, { recursive: true });

    const extension = documentExtensionsByMimeType[mimeType] || '.bin';
    const storedFileName = `${volunteer.id}-${documentType}-${Date.now()}${extension}`;
    const filePath = path.join(volunteerDocumentsDir, storedFileName);
    const fileUrl = `/uploads/volunteer-documents/${storedFileName}`;

    await fs.promises.writeFile(filePath, fileBuffer);

    await pool.query(
      `INSERT INTO volunteer_documents
       (volunteer_id, document_type, original_file_name, stored_file_name, file_path, file_url, mime_type, file_size, status, rejection_note, reviewed_by, reviewed_at, uploaded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, CURRENT_TIMESTAMP)
       ON DUPLICATE KEY UPDATE
         original_file_name = VALUES(original_file_name),
         stored_file_name = VALUES(stored_file_name),
         file_path = VALUES(file_path),
         file_url = VALUES(file_url),
         mime_type = VALUES(mime_type),
         file_size = VALUES(file_size),
         status = 'pending',
         rejection_note = NULL,
         reviewed_by = NULL,
         reviewed_at = NULL,
         uploaded_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP`,
      [
        volunteer.id,
        documentType,
        originalFileName,
        storedFileName,
        filePath,
        fileUrl,
        mimeType,
        fileBuffer.length,
      ]
    );

    const documents = await getVolunteerDocumentRows('WHERE vd.volunteer_id = ? AND vd.document_type = ?', [
      volunteer.id,
      documentType,
    ]);
    return res.status(201).json(documents[0]);
  } catch (error) {
    return next(error);
  }
});

app.get('/api/volunteer-documents/review', async (_req, res, next) => {
  try {
    const documents = await getVolunteerDocumentRows();
    return res.json(documents);
  } catch (error) {
    return next(error);
  }
});

app.get('/api/volunteer-documents/review/:volunteerId', async (req, res, next) => {
  try {
    const documents = await getVolunteerDocumentRows('WHERE vd.volunteer_id = ?', [req.params.volunteerId]);
    return res.json(documents);
  } catch (error) {
    return next(error);
  }
});

app.put('/api/volunteer-documents/:id/review', async (req, res, next) => {
  try {
    const status = normalizeDocumentStatus(req.body?.status);
    const rejectionNote = String(req.body?.rejection_note || req.body?.notes || '').trim();

    if (!status || !['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ message: 'status debe ser approved o rejected' });
    }
    if (status === 'rejected' && !rejectionNote) {
      return res.status(400).json({ message: 'La nota de rechazo es requerida' });
    }

    const reviewerId = req.user?.id || null;
    const [result] = await pool.query(
      `UPDATE volunteer_documents
       SET status = ?,
           rejection_note = ?,
           reviewed_by = ?,
           reviewed_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [status, status === 'rejected' ? rejectionNote : null, reviewerId, req.params.id]
    );

    if (result.affectedRows === 0) return res.status(404).json({ message: 'Documento no encontrado' });

    const documents = await getVolunteerDocumentRows('WHERE vd.id = ?', [req.params.id]);
    return res.json(documents[0]);
  } catch (error) {
    return next(error);
  }
});

app.get('/api/volunteer-form-requests/me', ensureAuthenticated, async (req, res, next) => {
  try {
    const volunteer = await getVolunteerForRequest(req, true);
    if (!volunteer) return res.status(404).json({ message: 'Perfil de voluntario no encontrado' });

    await pool.query(
      `UPDATE volunteer_form_requests
       SET status = 'expired'
       WHERE volunteer_id = ?
         AND status IN ('requested', 'in_progress', 'rejected')
         AND due_date < CURDATE()`,
      [volunteer.id]
    );

    const [requests] = await pool.query(
      `SELECT vfr.*, p.name AS program_name
       FROM volunteer_form_requests vfr
       LEFT JOIN programs p ON p.id = vfr.program_id
       WHERE vfr.volunteer_id = ?
       ORDER BY FIELD(vfr.status, 'requested', 'in_progress', 'rejected', 'submitted', 'approved', 'expired'), vfr.due_date ASC, vfr.created_at DESC`,
      [volunteer.id]
    );
    const eligibility = await computeVolunteerLifecycleEligibility(volunteer.id);
    const volunteerProfile = await getVolunteerFormProfile(volunteer.id);

    return res.json({ volunteer, volunteer_profile: volunteerProfile, requests, eligibility });
  } catch (error) {
    return next(error);
  }
});

app.get('/api/volunteer-form-requests/review', async (_req, res, next) => {
  try {
    await pool.query(
      `UPDATE volunteer_form_requests
       SET status = 'expired'
       WHERE status IN ('requested', 'in_progress', 'rejected')
         AND due_date < CURDATE()`
    );

    const [volunteers] = await pool.query(
      `SELECT
        v.id AS volunteer_id,
        v.status AS volunteer_status,
        v.user_id,
        u.first_name,
        u.last_name,
        u.email,
        u.phone,
        c.name AS country_name,
        latest.id AS request_id,
        latest.program_id,
        latest.action_type,
        latest.form_type,
        latest.status AS request_status,
        latest.due_date,
        latest.submitted_at,
        latest.reviewed_at,
        latest.review_notes,
        latest.form_data,
        p.name AS program_name
       FROM volunteers v
       INNER JOIN users u ON u.id = v.user_id
       LEFT JOIN countries c ON c.id = u.country_id
       LEFT JOIN (
         SELECT vfr.*
         FROM volunteer_form_requests vfr
         INNER JOIN (
           SELECT volunteer_id, MAX(id) AS id
           FROM volunteer_form_requests
           GROUP BY volunteer_id
         ) latest_request ON latest_request.id = vfr.id
       ) latest ON latest.volunteer_id = v.id
       LEFT JOIN programs p ON p.id = latest.program_id
       ORDER BY latest.created_at DESC, u.first_name, u.last_name
       LIMIT 500`
    );

    const rows = await Promise.all(
      volunteers.map(async (row) => {
        const volunteerProfile = await getVolunteerFormProfile(row.volunteer_id);
        return {
          ...row,
          volunteer_profile: volunteerProfile,
          eligibility: await computeVolunteerLifecycleEligibility(row.volunteer_id, row.program_id || null),
        };
      })
    );

    return res.json(rows);
  } catch (error) {
    return next(error);
  }
});

app.post('/api/volunteer-form-requests', async (req, res, next) => {
  try {
    const volunteerId = req.body?.volunteer_id;
    const programId = req.body?.program_id || null;
    const actionType = normalizeVolunteerActionType(req.body?.action_type);
    const formType = normalizeVolunteerFormType(req.body?.form_type);
    const dueDate = normalizeDateValue(req.body?.due_date);

    if (!volunteerId) return res.status(400).json({ message: 'volunteer_id es requerido' });
    if (!actionType) return res.status(400).json({ message: 'action_type invalido' });
    if (!formType) return res.status(400).json({ message: 'form_type invalido' });
    if (!dueDate) return res.status(400).json({ message: 'due_date es requerido' });

    const [volunteers] = await pool.query('SELECT id FROM volunteers WHERE id = ? LIMIT 1', [volunteerId]);
    if (!volunteers.length) return res.status(404).json({ message: 'Voluntario no encontrado' });

    if (programId) {
      const [programs] = await pool.query('SELECT id FROM programs WHERE id = ? LIMIT 1', [programId]);
      if (!programs.length) return res.status(404).json({ message: 'Programa no encontrado' });
    }

    const [result] = await pool.query(
      `INSERT INTO volunteer_form_requests
       (volunteer_id, program_id, requested_by, action_type, form_type, status, due_date)
       VALUES (?, ?, ?, ?, ?, 'requested', ?)`,
      [volunteerId, programId, req.user?.id || null, actionType, formType, dueDate]
    );

    const [rows] = await pool.query('SELECT * FROM volunteer_form_requests WHERE id = ? LIMIT 1', [result.insertId]);
    return res.status(201).json(rows[0]);
  } catch (error) {
    return next(error);
  }
});
app.put('/api/volunteer-form-requests/:id/resend', async (req, res, next) => {
  try {
    const dueDate = normalizeDateValue(req.body?.due_date);
    if (!dueDate) return res.status(400).json({ message: 'due_date es requerido' });

    const [requests] = await pool.query('SELECT * FROM volunteer_form_requests WHERE id = ? LIMIT 1', [req.params.id]);
    if (!requests.length) return res.status(404).json({ message: 'Solicitud no encontrada' });

    const request = requests[0];
    if (request.status !== 'expired') {
      return res.status(400).json({ message: 'Solo se pueden reenviar solicitudes vencidas' });
    }

    await pool.query(
      `UPDATE volunteer_form_requests
       SET status = 'requested',
           due_date = ?,
           requested_by = ?,
           submitted_at = NULL,
           reviewed_by = NULL,
           reviewed_at = NULL,
           review_notes = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [dueDate, req.user?.id || null, req.params.id]
    );

    const [rows] = await pool.query('SELECT * FROM volunteer_form_requests WHERE id = ? LIMIT 1', [req.params.id]);
    return res.json(rows[0]);
  } catch (error) {
    return next(error);
  }
});

app.put('/api/volunteer-form-requests/:id/submit', ensureAuthenticated, async (req, res, next) => {
  try {
    const volunteer = await getVolunteerForRequest(req, true);
    if (!volunteer) return res.status(404).json({ message: 'Perfil de voluntario no encontrado' });

    const formData = req.body?.form_data;
    if (!formData || typeof formData !== 'object' || Array.isArray(formData)) {
      return res.status(400).json({ message: 'form_data es requerido' });
    }

    const [requests] = await pool.query(
      `SELECT *
       FROM volunteer_form_requests
       WHERE id = ? AND volunteer_id = ?
       LIMIT 1`,
      [req.params.id, volunteer.id]
    );
    if (!requests.length) return res.status(404).json({ message: 'Solicitud no encontrada' });

    const current = requests[0];
    if (current.status === 'approved') {
      return res.status(400).json({ message: 'Este formulario ya fue aprobado' });
    }
    if (current.due_date && String(current.due_date).slice(0, 10) < new Date().toISOString().slice(0, 10)) {
      await pool.query("UPDATE volunteer_form_requests SET status = 'expired' WHERE id = ?", [req.params.id]);
      return res.status(400).json({ message: 'La fecha limite para completar el formulario ya vencio' });
    }

    await pool.query(
      `UPDATE volunteer_form_requests
       SET form_data = ?,
           status = 'submitted',
           submitted_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [JSON.stringify(formData), req.params.id]
    );

    const [rows] = await pool.query('SELECT * FROM volunteer_form_requests WHERE id = ? LIMIT 1', [req.params.id]);
    return res.json(rows[0]);
  } catch (error) {
    return next(error);
  }
});

app.put('/api/volunteer-form-requests/:id/review', async (req, res, next) => {
  try {
    const status = normalizeVolunteerFormStatus(req.body?.status);
    const notes = String(req.body?.review_notes || req.body?.notes || '').trim();

    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ message: 'status debe ser approved o rejected' });
    }
    if (status === 'rejected' && !notes) {
      return res.status(400).json({ message: 'La nota es requerida para rechazar el formulario' });
    }

    const [requests] = await pool.query('SELECT * FROM volunteer_form_requests WHERE id = ? LIMIT 1', [req.params.id]);
    if (!requests.length) return res.status(404).json({ message: 'Solicitud no encontrada' });

    const request = requests[0];
    if (status === 'approved') {
      if (!request.form_data) {
        return res.status(400).json({ message: 'El voluntario debe completar el formulario antes de aprobar' });
      }

      const eligibility = await computeVolunteerLifecycleEligibility(request.volunteer_id, request.program_id || null);
      if (!eligibility.attendance_complete) {
        return res.status(400).json({
          message: 'No se puede aprobar porque el voluntario tiene asistencias pendientes',
          eligibility,
        });
      }
    }

    await pool.query(
      `UPDATE volunteer_form_requests
       SET status = ?,
           reviewed_by = ?,
           reviewed_at = CURRENT_TIMESTAMP,
           review_notes = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [status, req.user?.id || null, status === 'rejected' ? notes : notes || null, req.params.id]
    );

    if (status === 'approved') {
      if (request.action_type === 'graduation') {
        const params = [request.volunteer_id];
        let where = 'volunteer_id = ?';
        if (request.program_id) {
          where += ' AND program_id = ?';
          params.push(request.program_id);
        }
        await pool.query(
          `UPDATE volunteer_programs
           SET status = 'completed',
               end_date = COALESCE(end_date, CURDATE()),
               certification_date = COALESCE(certification_date, CURDATE()),
               progress_percentage = 100,
               updated_at = CURRENT_TIMESTAMP
           WHERE ${where}`,
          params
        );
      } else {
        await pool.query(
          "UPDATE volunteers SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
          [request.volunteer_id]
        );
      }
    }

    const [rows] = await pool.query('SELECT * FROM volunteer_form_requests WHERE id = ? LIMIT 1', [req.params.id]);
    return res.json(rows[0]);
  } catch (error) {
    return next(error);
  }
});

app.get('/api/whatsapp-reminders/state', async (req, res, next) => {
  try {
    const reminderType = normalizeReminderType(req.query.reminder_type || req.query.type);
    const volunteerId = req.query.volunteer_id;
    const sessionId = req.query.session_id;

    if (!reminderType) return res.status(400).json({ message: 'reminder_type invalido' });
    if (!volunteerId || !sessionId) {
      return res.status(400).json({ message: 'volunteer_id y session_id son requeridos' });
    }

    const [rows] = await pool.query(
      `SELECT
        COUNT(*) AS attempts,
        MAX(sent_at) AS last_sent_at
       FROM whatsapp_reminders
       WHERE reminder_type = ?
         AND volunteer_id = ?
         AND session_id = ?
         AND status IN ('sent', 'dry-run')`,
      [reminderType, volunteerId, sessionId]
    );

    return res.json({
      reminder_type: reminderType,
      volunteer_id: volunteerId,
      session_id: sessionId,
      attempts: Number(rows[0]?.attempts || 0),
      last_sent_at: rows[0]?.last_sent_at || null,
    });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/whatsapp-reminders', async (req, res, next) => {
  try {
    const reminderType = normalizeReminderType(req.body?.reminder_type);
    const status = normalizeReminderStatus(req.body?.status);
    const volunteerId = req.body?.volunteer_id;
    const sessionId = req.body?.session_id;
    const phone = String(req.body?.phone || '').trim();
    const message = String(req.body?.message || '').trim();
    const twilioMessageSid = req.body?.twilio_message_sid || null;
    const errorMessage = req.body?.error_message || null;

    if (!reminderType) return res.status(400).json({ message: 'reminder_type invalido' });
    if (!status) return res.status(400).json({ message: 'status invalido' });
    if (!volunteerId || !sessionId) {
      return res.status(400).json({ message: 'volunteer_id y session_id son requeridos' });
    }
    if (!phone) return res.status(400).json({ message: 'phone es requerido' });
    if (!message) return res.status(400).json({ message: 'message es requerido' });

    const [result] = await pool.query(
      `INSERT INTO whatsapp_reminders
       (reminder_type, volunteer_id, session_id, phone, message, status, twilio_message_sid, error_message, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [reminderType, volunteerId, sessionId, phone, message, status, twilioMessageSid, errorMessage]
    );

    const [rows] = await pool.query('SELECT * FROM whatsapp_reminders WHERE id = ? LIMIT 1', [result.insertId]);
    return res.status(201).json(rows[0] || { id: result.insertId });
  } catch (error) {
    return next(error);
  }
});

app.get('/api/reports/attendance-progress', async (req, res, next) => {
  try {
    const countryId = req.query.country_id || null;
    const programId = req.query.program_id || null;
    const sessionId = req.query.session_id || null;
    const enrollmentStatus = req.query.status || null;

    const completedSessionCondition =
      "(s.status = 'completed' OR TIMESTAMP(s.scheduled_date, COALESCE(s.end_time, s.start_time, '23:59:59')) <= NOW())";

    const volunteerWhere = [];
    const volunteerParams = [];

    if (countryId) {
      volunteerWhere.push('u.country_id = ?');
      volunteerParams.push(countryId);
    }
    if (programId) {
      volunteerWhere.push('vp.program_id = ?');
      volunteerParams.push(programId);
    }
    if (enrollmentStatus) {
      volunteerWhere.push('(vp.status = ? OR v.status = ? OR u.status = ?)');
      volunteerParams.push(enrollmentStatus, enrollmentStatus, enrollmentStatus);
    }

    const sessionJoin = sessionId
      ? `LEFT JOIN sessions s
           ON s.id = ?
          AND s.status <> 'cancelled'
          AND (s.program_id = vp.program_id OR s.program_id IS NULL)`
      : `LEFT JOIN sessions s
           ON s.program_id = vp.program_id
          AND s.status <> 'cancelled'
          AND ${completedSessionCondition}`;

    const volunteerQueryParams = sessionId ? [sessionId, ...volunteerParams] : volunteerParams;
    const volunteerWhereClause = volunteerWhere.length ? `WHERE ${volunteerWhere.join(' AND ')}` : '';

    const [volunteers] = await pool.query(
      `SELECT
        v.id AS volunteer_id,
        v.user_id,
        TRIM(CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, ''))) AS volunteer_name,
        u.email,
        u.phone,
        u.country_id,
        c.name AS country_name,
        vp.program_id,
        p.name AS program_name,
        vp.status AS enrollment_status,
        v.status AS volunteer_status,
        CASE
          WHEN vp.status = 'completed' THEN 'Completado'
          WHEN active_group.group_name IS NOT NULL THEN CONCAT('Grupo - ', active_group.group_name)
          ELSE 'Introduccion'
        END AS current_phase,
        COUNT(DISTINCT s.id) AS total_sessions,
        COUNT(DISTINCT CASE WHEN ${completedSessionCondition} THEN s.id END) AS sessions_completed,
        COUNT(DISTINCT sa.id) AS attendance_records,
        COUNT(DISTINCT CASE WHEN sa.status = 'present' THEN sa.id END) AS present_count,
        COUNT(DISTINCT CASE WHEN sa.status = 'absent' THEN sa.id END) AS absent_count,
        COUNT(DISTINCT CASE WHEN sa.status = 'excused' THEN sa.id END) AS excused_count,
        CASE
          WHEN COUNT(DISTINCT s.id) = 0 THEN 0
          ELSE ROUND(COUNT(DISTINCT CASE WHEN sa.status = 'present' THEN s.id END) / COUNT(DISTINCT s.id) * 100, 2)
        END AS attendance_percentage
       FROM volunteer_programs vp
       INNER JOIN volunteers v ON v.id = vp.volunteer_id
       INNER JOIN users u ON u.id = v.user_id
       LEFT JOIN countries c ON c.id = u.country_id
       INNER JOIN programs p ON p.id = vp.program_id
       LEFT JOIN (
         SELECT
          vgm.volunteer_id,
          pg.program_id,
          MAX(pg.name) AS group_name
         FROM volunteer_group_members vgm
         INNER JOIN program_groups pg ON pg.id = vgm.group_id
         WHERE vgm.status = 'active'
         GROUP BY vgm.volunteer_id, pg.program_id
       ) active_group
         ON active_group.volunteer_id = v.id AND active_group.program_id = vp.program_id
       ${sessionJoin}
       LEFT JOIN session_attendance sa
         ON sa.session_id = s.id AND sa.volunteer_id = v.id
       ${volunteerWhereClause}
       GROUP BY
        v.id,
        v.user_id,
        u.first_name,
        u.last_name,
        u.email,
        u.phone,
        u.country_id,
        c.name,
        vp.program_id,
        p.name,
        vp.status,
        v.status,
        active_group.group_name
       ORDER BY p.name, volunteer_name`,
      volunteerQueryParams
    );

    const sessionWhere = ["s.status <> 'cancelled'"];
    const sessionParams = [];

    if (sessionId) {
      sessionWhere.push('s.id = ?');
      sessionParams.push(sessionId);
    } else {
      sessionWhere.push(completedSessionCondition);
    }
    if (programId) {
      sessionWhere.push('s.program_id = ?');
      sessionParams.push(programId);
    }
    if (countryId) {
      sessionWhere.push('u.country_id = ?');
      sessionParams.push(countryId);
    }
    if (enrollmentStatus) {
      sessionWhere.push('(vp.status = ? OR v.status = ? OR u.status = ?)');
      sessionParams.push(enrollmentStatus, enrollmentStatus, enrollmentStatus);
    }

    const [sessions] = await pool.query(
      `SELECT
        s.id AS session_id,
        s.title,
        s.program_id,
        p.name AS program_name,
        s.session_type,
        CASE WHEN s.session_type = 'specialized' THEN 'grupo' ELSE 'introduccion' END AS stage,
        s.delivery_mode,
        s.scheduled_date,
        s.start_time,
        s.end_time,
        s.status,
        COUNT(DISTINCT vp.volunteer_id) AS expected_volunteers,
        COUNT(DISTINCT sa.id) AS attendance_records,
        COUNT(DISTINCT CASE WHEN sa.status = 'present' THEN sa.id END) AS present_count,
        COUNT(DISTINCT CASE WHEN sa.status = 'absent' THEN sa.id END) AS absent_count,
        COUNT(DISTINCT CASE WHEN sa.status = 'excused' THEN sa.id END) AS excused_count,
        CASE
          WHEN COUNT(DISTINCT vp.volunteer_id) = 0 THEN 0
          ELSE ROUND(COUNT(DISTINCT CASE WHEN sa.status = 'present' THEN vp.volunteer_id END) / COUNT(DISTINCT vp.volunteer_id) * 100, 2)
        END AS attendance_percentage
       FROM sessions s
       LEFT JOIN programs p ON p.id = s.program_id
       LEFT JOIN volunteer_programs vp ON vp.program_id = s.program_id
       LEFT JOIN volunteers v ON v.id = vp.volunteer_id
       LEFT JOIN users u ON u.id = v.user_id
       LEFT JOIN session_attendance sa
         ON sa.session_id = s.id AND sa.volunteer_id = vp.volunteer_id
       WHERE ${sessionWhere.join(' AND ')}
       GROUP BY
        s.id,
        s.title,
        s.program_id,
        p.name,
        s.session_type,
        s.delivery_mode,
        s.scheduled_date,
        s.start_time,
        s.end_time,
        s.status
       ORDER BY s.scheduled_date DESC, s.start_time DESC
       LIMIT 500`,
      sessionParams
    );

    const [countries] = await pool.query('SELECT id, name FROM countries ORDER BY name');
    const [programs] = await pool.query('SELECT id, name FROM programs ORDER BY name');
    const [availableSessions] = await pool.query(
      `SELECT id, title, program_id, scheduled_date, start_time,
        CASE WHEN session_type = 'specialized' THEN 'grupo' ELSE 'introduccion' END AS stage
       FROM sessions
       WHERE status <> 'cancelled'
       ORDER BY scheduled_date DESC, start_time DESC
       LIMIT 500`
    );
    const [statuses] = await pool.query(
      `SELECT DISTINCT status
       FROM volunteer_programs
       WHERE status IS NOT NULL AND status <> ''
       ORDER BY status`
    );

    const totalVolunteers = volunteers.length;
    const totalSessions = sessions.length;
    const averageAttendance = totalVolunteers
      ? volunteers.reduce((sum, row) => sum + Number(row.attendance_percentage || 0), 0) / totalVolunteers
      : 0;

    return res.json({
      summary: {
        total_volunteers: totalVolunteers,
        total_sessions: totalSessions,
        attendance_records: volunteers.reduce((sum, row) => sum + Number(row.attendance_records || 0), 0),
        average_attendance: Math.round(averageAttendance * 100) / 100,
      },
      volunteers,
      sessions,
      filters: {
        countries,
        programs,
        sessions: availableSessions,
        statuses: statuses.map((row) => row.status),
      },
    });
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
