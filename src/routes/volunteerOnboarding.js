const express = require('express');
const pool = require('../config/db');

const router = express.Router();

const STEP_ORDER = ['personal-info', 'intro-video', 'charlas', 'project-selection', 'trainings'];

const ONBOARDING_COLUMNS = {
  date_of_birth: 'DATE NULL',
  sex: 'VARCHAR(30) NULL',
  first_time_volunteer: 'BOOLEAN NULL',
  is_studying: 'BOOLEAN NULL',
  study_center: 'VARCHAR(255) NULL',
  needs_service_hours: 'BOOLEAN NULL',
  availability: 'VARCHAR(50) NULL',
  interest_area: 'VARCHAR(100) NULL',
  previous_experience: 'VARCHAR(300) NULL',
  referral_source: 'VARCHAR(150) NULL',
  referral_source_other: 'VARCHAR(255) NULL',
  completed_at: 'TIMESTAMP NULL',
};

const ensureAuthenticated = (req, res, next) => {
  if (!req.isAuthenticated?.() || !req.user?.id) {
    return res.status(401).json({ message: 'No autenticado' });
  }

  return next();
};

const ensureProgressTable = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS volunteer_onboarding_progress (
      id INT PRIMARY KEY AUTO_INCREMENT,
      user_id INT NOT NULL,
      current_step VARCHAR(50) NOT NULL DEFAULT 'personal-info',
      full_name VARCHAR(255) NULL,
      email VARCHAR(255) NULL,
      phone VARCHAR(50) NULL,
      country_id INT NULL,
      date_of_birth DATE NULL,
      sex VARCHAR(30) NULL,
      first_time_volunteer BOOLEAN NULL,
      is_studying BOOLEAN NULL,
      study_center VARCHAR(255) NULL,
      needs_service_hours BOOLEAN NULL,
      availability VARCHAR(50) NULL,
      interest_area VARCHAR(100) NULL,
      previous_experience VARCHAR(300) NULL,
      referral_source VARCHAR(150) NULL,
      referral_source_other VARCHAR(255) NULL,
      completed_at TIMESTAMP NULL,
      video_watched BOOLEAN NOT NULL DEFAULT false,
      selected_charlas JSON NULL,
      selected_project INT NULL,
      charlas_completed BOOLEAN NOT NULL DEFAULT false,
      trainings_completed BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY unique_user_progress (user_id),
      CONSTRAINT fk_onboarding_progress_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      CONSTRAINT fk_onboarding_progress_country FOREIGN KEY (country_id) REFERENCES countries(id) ON DELETE SET NULL,
      CONSTRAINT fk_onboarding_progress_project FOREIGN KEY (selected_project) REFERENCES programs(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  const [columns] = await pool.query('SHOW COLUMNS FROM volunteer_onboarding_progress');
  const existingColumns = new Set(columns.map((column) => column.Field));

  for (const [columnName, definition] of Object.entries(ONBOARDING_COLUMNS)) {
    if (!existingColumns.has(columnName)) {
      await pool.query(`ALTER TABLE volunteer_onboarding_progress ADD COLUMN ${columnName} ${definition}`);
    }
  }
};

const getCompletionFlags = async (userId) => {
  const [rows] = await pool.query(
    `SELECT
      COALESCE(SUM(CASE WHEN s.session_type IN ('general', 'follow-up') AND sa.status = 'present' THEN 1 ELSE 0 END), 0) AS intro_attended,
      COALESCE(SUM(CASE WHEN s.session_type = 'specialized' AND sa.status = 'present' THEN 1 ELSE 0 END), 0) AS training_attended
    FROM session_attendance sa
    INNER JOIN volunteers v ON v.id = sa.volunteer_id
    INNER JOIN sessions s ON s.id = sa.session_id
    WHERE v.user_id = ?`,
    [userId]
  );

  const introAttended = Number(rows[0]?.intro_attended || 0);
  const trainingAttended = Number(rows[0]?.training_attended || 0);

  return {
    charlasCompleted: introAttended > 0,
    trainingsCompleted: trainingAttended > 0,
  };
};

const hydrateResponse = async (userId, row) => {
  const completion = await getCompletionFlags(userId);

  return {
    current_step: row.current_step,
    full_name: row.full_name,
    email: row.email,
    phone: row.phone,
    country_id: row.country_id,
    date_of_birth: row.date_of_birth,
    sex: row.sex,
    first_time_volunteer: row.first_time_volunteer === null ? null : Boolean(row.first_time_volunteer),
    is_studying: row.is_studying === null ? null : Boolean(row.is_studying),
    study_center: row.study_center,
    needs_service_hours: row.needs_service_hours === null ? null : Boolean(row.needs_service_hours),
    availability: row.availability,
    interest_area: row.interest_area,
    previous_experience: row.previous_experience,
    referral_source: row.referral_source,
    referral_source_other: row.referral_source_other,
    completed: Boolean(row.completed_at),
    video_watched: Boolean(row.video_watched),
    selected_charlas: row.selected_charlas || [],
    selected_project: row.selected_project,
    charlas_completed: completion.charlasCompleted,
    trainings_completed: completion.trainingsCompleted,
  };
};

const validateStep = (step) => STEP_ORDER.includes(step);

const nullableBoolean = (value) => {
  if (value === null || value === undefined || value === '') return null;
  if ([true, 1, '1', 'true', 'yes'].includes(value)) return true;
  if ([false, 0, '0', 'false', 'no'].includes(value)) return false;
  return null;
};

const validateProfilePayload = (payload) => {
  const requiredTextFields = [
    'full_name',
    'email',
    'phone',
    'country_id',
    'date_of_birth',
    'sex',
    'availability',
    'interest_area',
    'previous_experience',
    'referral_source',
  ];
  const missingField = requiredTextFields.find((field) => !String(payload[field] ?? '').trim());
  if (missingField) return `${missingField} es requerido`;

  if (nullableBoolean(payload.first_time_volunteer) === null) {
    return 'first_time_volunteer es requerido';
  }
  if (nullableBoolean(payload.is_studying) === null) {
    return 'is_studying es requerido';
  }

  const allowedValues = {
    sex: ['female', 'male'],
    availability: ['morning', 'afternoon', 'saturday', 'any'],
    interest_area: ['community_schools', 'girls_club', 'youth'],
    referral_source: [
      'social_media',
      'former_volunteer',
      'university_fair',
      'former_participant',
      'employer',
      'school_coordination',
      'other',
    ],
  };

  for (const [field, values] of Object.entries(allowedValues)) {
    if (payload[field] && !values.includes(payload[field])) return `${field} contiene una opción inválida`;
  }

  if (payload.date_of_birth && !/^\d{4}-\d{2}-\d{2}$/.test(payload.date_of_birth)) {
    return 'date_of_birth debe usar el formato YYYY-MM-DD';
  }
  if (payload.previous_experience && String(payload.previous_experience).length > 300) {
    return 'previous_experience no puede superar 300 caracteres';
  }
  if (payload.referral_source === 'other' && !String(payload.referral_source_other || '').trim()) {
    return 'Debes especificar cómo te enteraste del voluntariado';
  }

  return null;
};

const validateStepTransition = (currentStep, nextStep, completion) => {
  const currentIndex = STEP_ORDER.indexOf(currentStep);
  const nextIndex = STEP_ORDER.indexOf(nextStep);

  if (nextIndex === -1) return 'current_step inválido';
  if (nextIndex <= currentIndex + 1) return null;

  if (['project-selection', 'trainings'].includes(nextStep) && !completion.charlasCompleted) {
    return 'No puedes avanzar a etapa 2 sin charlas de introduccion completadas';
  }

  return 'No puedes saltar pasos del onboarding';
};

router.get('/progress', ensureAuthenticated, async (req, res, next) => {
  try {
    await ensureProgressTable();

    const [rows] = await pool.query('SELECT * FROM volunteer_onboarding_progress WHERE user_id = ? LIMIT 1', [
      req.user.id,
    ]);

    if (!rows.length) {
      return res.json({
        current_step: 'personal-info',
        full_name: req.user.displayName || null,
        email: req.user.email || null,
        phone: null,
        country_id: req.user.country?.id || null,
        date_of_birth: null,
        sex: null,
        first_time_volunteer: null,
        is_studying: null,
        study_center: null,
        needs_service_hours: null,
        availability: null,
        interest_area: null,
        previous_experience: null,
        referral_source: null,
        referral_source_other: null,
        completed: false,
        video_watched: false,
        selected_charlas: [],
        selected_project: null,
        charlas_completed: false,
        trainings_completed: false,
      });
    }

    const row = rows[0];
    if (typeof row.selected_charlas === 'string') {
      row.selected_charlas = JSON.parse(row.selected_charlas || '[]');
    }

    return res.json(await hydrateResponse(req.user.id, row));
  } catch (error) {
    return next(error);
  }
});

router.put('/progress', ensureAuthenticated, async (req, res, next) => {
  try {
    await ensureProgressTable();

    const payload = req.body || {};

    if (payload.current_step && !validateStep(payload.current_step)) {
      return res.status(400).json({ message: 'current_step inválido' });
    }

    if (payload.selected_charlas && !Array.isArray(payload.selected_charlas)) {
      return res.status(400).json({ message: 'selected_charlas debe ser un arreglo' });
    }

    const profileValidationError = validateProfilePayload(payload);
    if (profileValidationError) {
      return res.status(400).json({ message: profileValidationError });
    }

    const [existingRows] = await pool.query('SELECT * FROM volunteer_onboarding_progress WHERE user_id = ? LIMIT 1', [
      req.user.id,
    ]);

    const completion = await getCompletionFlags(req.user.id);
    const currentStep = existingRows[0]?.current_step || 'personal-info';
    const nextStep = payload.current_step || currentStep;
    const transitionError = validateStepTransition(currentStep, nextStep, completion);

    if (transitionError) {
      return res.status(422).json({ message: transitionError, charlas_completed: completion.charlasCompleted, trainings_completed: completion.trainingsCompleted });
    }

    if (Array.isArray(payload.selected_charlas) && payload.selected_charlas.length) {
      const [validCharlas] = await pool.query(
        "SELECT id FROM sessions WHERE id IN (?) AND session_type IN ('general', 'follow-up')",
        [payload.selected_charlas]
      );

      if (validCharlas.length !== payload.selected_charlas.length) {
        return res.status(400).json({ message: 'selected_charlas contiene IDs inválidos' });
      }
    }

    if (payload.selected_project) {
      const [programs] = await pool.query(
        "SELECT id FROM programs WHERE id = ? AND status = 'active' LIMIT 1",
        [payload.selected_project]
      );

      if (!programs.length) {
        return res.status(400).json({ message: 'selected_project no existe o no está activo' });
      }
    }

    const isStudying = nullableBoolean(payload.is_studying);
    const upsertValues = [
      req.user.id,
      nextStep,
      payload.full_name || null,
      payload.email || null,
      payload.phone || null,
      payload.country_id || null,
      payload.date_of_birth || null,
      payload.sex || null,
      nullableBoolean(payload.first_time_volunteer),
      isStudying,
      isStudying ? payload.study_center || null : null,
      isStudying ? nullableBoolean(payload.needs_service_hours) : null,
      payload.availability || null,
      payload.interest_area || null,
      payload.previous_experience ? String(payload.previous_experience).trim() : null,
      payload.referral_source || null,
      payload.referral_source === 'other' ? String(payload.referral_source_other || '').trim() || null : null,
      Boolean(payload.video_watched),
      JSON.stringify(payload.selected_charlas || []),
      payload.selected_project || null,
    ];

    await pool.query(
      `INSERT INTO volunteer_onboarding_progress
       (user_id, current_step, full_name, email, phone, country_id, date_of_birth, sex,
        first_time_volunteer, is_studying, study_center, needs_service_hours, availability,
        interest_area, previous_experience, referral_source, referral_source_other,
        video_watched, selected_charlas, selected_project)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         current_step = VALUES(current_step),
         full_name = VALUES(full_name),
         email = VALUES(email),
         phone = VALUES(phone),
         country_id = VALUES(country_id),
         date_of_birth = VALUES(date_of_birth),
         sex = VALUES(sex),
         first_time_volunteer = VALUES(first_time_volunteer),
         is_studying = VALUES(is_studying),
         study_center = VALUES(study_center),
         needs_service_hours = VALUES(needs_service_hours),
         availability = VALUES(availability),
         interest_area = VALUES(interest_area),
         previous_experience = VALUES(previous_experience),
         referral_source = VALUES(referral_source),
         referral_source_other = VALUES(referral_source_other),
         video_watched = VALUES(video_watched),
         selected_charlas = VALUES(selected_charlas),
         selected_project = VALUES(selected_project)`,
      upsertValues
    );

    if (payload.completed === true && nextStep === 'trainings') {
      await pool.query(
        'UPDATE volunteer_onboarding_progress SET completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP) WHERE user_id = ?',
        [req.user.id]
      );
    }

    const [rows] = await pool.query('SELECT * FROM volunteer_onboarding_progress WHERE user_id = ? LIMIT 1', [
      req.user.id,
    ]);

    const row = rows[0];
    if (typeof row.selected_charlas === 'string') {
      row.selected_charlas = JSON.parse(row.selected_charlas || '[]');
    }

    return res.json(await hydrateResponse(req.user.id, row));
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
