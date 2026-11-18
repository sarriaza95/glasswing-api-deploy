const express = require('express');
const pool = require('../config/db');
const {
  ensureProgressTable,
  nullableBoolean,
  validateProfilePayload,
} = require('../services/volunteerOnboardingService');
const {
  ensureOnboardingContentTables,
  getVideoCompletion,
  getVolunteerVideos,
  parseJson,
} = require('../services/onboardingContentService');
const { normalizeRole } = require('../middleware/rbac');

const router = express.Router();

const STEP_ORDER = ['personal-info', 'intro-video', 'charlas', 'project-selection', 'trainings'];

const ensureAuthenticated = (req, res, next) => {
  if (!req.isAuthenticated?.() || !req.user?.id) {
    return res.status(401).json({ message: 'No autenticado' });
  }

  return next();
};

const resolveOnboardingUser = async (req, res, next) => {
  try {
    const managedVolunteerId = req.session?.managedVolunteerId;
    if (!managedVolunteerId) {
      req.onboardingUser = {
        id: req.user.id,
        displayName: req.user.displayName || null,
        email: req.user.email || null,
      };
      return next();
    }

    const [staffRows] = await pool.query(
      `SELECT r.name AS role_name
       FROM users u
       LEFT JOIN roles r ON r.id = u.role_id
       WHERE u.id = ? AND u.status = 'active'
       LIMIT 1`,
      [req.user.id]
    );
    if (!['admin', 'coach'].includes(normalizeRole(staffRows[0]?.role_name))) {
      return res.status(403).json({ message: 'No tienes permisos para gestionar como voluntario' });
    }

    const [volunteerRows] = await pool.query(
      `SELECT u.id, u.email, CONCAT_WS(' ', u.first_name, u.last_name) AS display_name
       FROM volunteers v
       INNER JOIN users u ON u.id = v.user_id
       WHERE v.id = ?
       LIMIT 1`,
      [managedVolunteerId]
    );
    if (!volunteerRows.length) {
      return res.status(409).json({ message: 'El voluntario gestionado no tiene un usuario asociado' });
    }

    req.onboardingUser = {
      id: volunteerRows[0].id,
      displayName: volunteerRows[0].display_name || null,
      email: volunteerRows[0].email || null,
    };
    return next();
  } catch (error) {
    return next(error);
  }
};

router.use(ensureAuthenticated, resolveOnboardingUser);

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
  const videoCompletion = await getVideoCompletion(userId);

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
    video_watched: videoCompletion.complete,
    intro_videos_watched: videoCompletion.completedExternalKeys,
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

router.get('/videos', ensureAuthenticated, async (req, res, next) => {
  try {
    return res.json(await getVolunteerVideos(req.onboardingUser.id));
  } catch (error) {
    return next(error);
  }
});

router.put('/videos/:videoId/progress', ensureAuthenticated, async (req, res, next) => {
  try {
    await ensureOnboardingContentTables();
    const watchedPercentage = Math.min(100, Math.max(0, Number(req.body?.watched_percentage || 0)));
    if (!Number.isFinite(watchedPercentage)) {
      return res.status(400).json({ message: 'El porcentaje visto es inválido' });
    }
    const [videos] = await pool.query(
      "SELECT id FROM onboarding_videos WHERE id = ? AND status = 'active' LIMIT 1",
      [req.params.videoId]
    );
    if (!videos.length) return res.status(404).json({ message: 'Video no encontrado' });

    await pool.query(
      `INSERT INTO onboarding_video_progress (user_id, video_id, watched_percentage, completed_at)
       VALUES (?, ?, ?, IF(? >= 100, CURRENT_TIMESTAMP, NULL))
       ON DUPLICATE KEY UPDATE
         watched_percentage = GREATEST(watched_percentage, VALUES(watched_percentage)),
         completed_at = IF(GREATEST(watched_percentage, VALUES(watched_percentage)) >= 100,
           COALESCE(completed_at, CURRENT_TIMESTAMP), completed_at)`,
      [req.onboardingUser.id, req.params.videoId, watchedPercentage, watchedPercentage]
    );
    const videosPayload = await getVolunteerVideos(req.onboardingUser.id);
    return res.json(videosPayload.find((video) => Number(video.id) === Number(req.params.videoId)) || null);
  } catch (error) {
    return next(error);
  }
});

router.put('/videos/:videoId/answers', ensureAuthenticated, async (req, res, next) => {
  try {
    await ensureOnboardingContentTables();
    const answers = Array.isArray(req.body?.answers) ? req.body.answers : [];
    const [progressRows] = await pool.query(
      `SELECT watched_percentage
       FROM onboarding_video_progress
       WHERE user_id = ? AND video_id = ?
       LIMIT 1`,
      [req.onboardingUser.id, req.params.videoId]
    );
    if (Number(progressRows[0]?.watched_percentage || 0) < 100) {
      return res.status(422).json({ message: 'Debes ver el video al 100% antes de responder las preguntas' });
    }
    const [questions] = await pool.query(
      `SELECT id, answer_type, options_json, is_required
       FROM onboarding_video_questions
       WHERE video_id = ?
       ORDER BY sort_order, id`,
      [req.params.videoId]
    );
    if (!questions.length) {
      const videosPayload = await getVolunteerVideos(req.onboardingUser.id);
      return res.json(videosPayload.find((video) => Number(video.id) === Number(req.params.videoId)) || null);
    }

    const answersByQuestion = new Map(answers.map((answer) => [Number(answer.question_id), String(answer.answer || '').trim()]));
    for (const question of questions) {
      const answer = answersByQuestion.get(Number(question.id)) || '';
      if (question.is_required && !answer) {
        return res.status(400).json({ message: 'Debes responder todas las preguntas obligatorias' });
      }
      if (!answer) continue;
      if (question.answer_type === 'multiple_choice') {
        const options = parseJson(question.options_json, []);
        if (!options.includes(answer)) {
          return res.status(400).json({ message: 'Una de las respuestas seleccionadas no es válida' });
        }
      }
      await pool.query(
        `INSERT INTO onboarding_video_answers (user_id, video_id, question_id, answer_text)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE answer_text = VALUES(answer_text), answered_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP`,
        [req.onboardingUser.id, req.params.videoId, question.id, answer]
      );
    }

    const videosPayload = await getVolunteerVideos(req.onboardingUser.id);
    return res.json(videosPayload.find((video) => Number(video.id) === Number(req.params.videoId)) || null);
  } catch (error) {
    return next(error);
  }
});

router.get('/progress', ensureAuthenticated, async (req, res, next) => {
  try {
    await ensureProgressTable();

    const [rows] = await pool.query('SELECT * FROM volunteer_onboarding_progress WHERE user_id = ? LIMIT 1', [
      req.onboardingUser.id,
    ]);

    if (!rows.length) {
      return res.json({
        current_step: 'personal-info',
        full_name: req.onboardingUser.displayName || null,
        email: req.onboardingUser.email || null,
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
        intro_videos_watched: [],
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

    return res.json(await hydrateResponse(req.onboardingUser.id, row));
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
    if (payload.intro_videos_watched && !Array.isArray(payload.intro_videos_watched)) {
      return res.status(400).json({ message: 'intro_videos_watched debe ser un arreglo' });
    }

    const profileValidationError = validateProfilePayload(payload);
    if (profileValidationError) {
      return res.status(400).json({ message: profileValidationError });
    }

    const [existingRows] = await pool.query('SELECT * FROM volunteer_onboarding_progress WHERE user_id = ? LIMIT 1', [
      req.onboardingUser.id,
    ]);

    const completion = await getCompletionFlags(req.onboardingUser.id);
    const videoCompletion = await getVideoCompletion(req.onboardingUser.id);
    const currentStep = existingRows[0]?.current_step || 'personal-info';
    const nextStep = payload.current_step || currentStep;
    const transitionError = validateStepTransition(currentStep, nextStep, completion);

    if (transitionError) {
      return res.status(422).json({ message: transitionError, charlas_completed: completion.charlasCompleted, trainings_completed: completion.trainingsCompleted });
    }
    if (STEP_ORDER.indexOf(nextStep) > STEP_ORDER.indexOf('intro-video') && !videoCompletion.complete) {
      return res.status(422).json({
        message: 'Debes ver todos los videos al 100% y responder sus preguntas antes de continuar',
      });
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
    const introVideosWatched = videoCompletion.completedExternalKeys;
    const upsertValues = [
      req.onboardingUser.id,
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
      JSON.stringify(introVideosWatched),
      videoCompletion.complete,
      JSON.stringify(payload.selected_charlas || []),
      payload.selected_project || null,
    ];

    await pool.query(
      `INSERT INTO volunteer_onboarding_progress
       (user_id, current_step, full_name, email, phone, country_id, date_of_birth, sex,
        first_time_volunteer, is_studying, study_center, needs_service_hours, availability,
        interest_area, previous_experience, referral_source, referral_source_other,
        intro_videos_watched, video_watched, selected_charlas, selected_project)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
         intro_videos_watched = VALUES(intro_videos_watched),
         video_watched = VALUES(video_watched),
         selected_charlas = VALUES(selected_charlas),
         selected_project = VALUES(selected_project)`,
      upsertValues
    );

    if (payload.completed === true && nextStep === 'trainings') {
      await pool.query(
        'UPDATE volunteer_onboarding_progress SET completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP) WHERE user_id = ?',
        [req.onboardingUser.id]
      );
    }

    const [rows] = await pool.query('SELECT * FROM volunteer_onboarding_progress WHERE user_id = ? LIMIT 1', [
      req.onboardingUser.id,
    ]);

    const row = rows[0];
    if (typeof row.selected_charlas === 'string') {
      row.selected_charlas = JSON.parse(row.selected_charlas || '[]');
    }

    return res.json(await hydrateResponse(req.onboardingUser.id, row));
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
