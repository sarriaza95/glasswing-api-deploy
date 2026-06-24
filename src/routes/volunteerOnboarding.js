const express = require('express');
const pool = require('../config/db');

const router = express.Router();

const STEP_ORDER = ['personal-info', 'intro-video', 'charlas', 'project-selection', 'trainings'];

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
    video_watched: Boolean(row.video_watched),
    selected_charlas: row.selected_charlas || [],
    selected_project: row.selected_project,
    charlas_completed: completion.charlasCompleted,
    trainings_completed: completion.trainingsCompleted,
  };
};

const validateStep = (step) => STEP_ORDER.includes(step);

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

    const upsertValues = [
      req.user.id,
      nextStep,
      payload.full_name || null,
      payload.email || null,
      payload.phone || null,
      payload.country_id || null,
      Boolean(payload.video_watched),
      JSON.stringify(payload.selected_charlas || []),
      payload.selected_project || null,
    ];

    await pool.query(
      `INSERT INTO volunteer_onboarding_progress
       (user_id, current_step, full_name, email, phone, country_id, video_watched, selected_charlas, selected_project)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         current_step = VALUES(current_step),
         full_name = VALUES(full_name),
         email = VALUES(email),
         phone = VALUES(phone),
         country_id = VALUES(country_id),
         video_watched = VALUES(video_watched),
         selected_charlas = VALUES(selected_charlas),
         selected_project = VALUES(selected_project)`,
      upsertValues
    );

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
