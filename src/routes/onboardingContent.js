const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const pool = require('../config/db');
const { normalizeRole } = require('../middleware/rbac');
const { ensureOnboardingContentTables, parseJson } = require('../services/onboardingContentService');

const router = express.Router();
const uploadDirectory = path.join(__dirname, '..', '..', 'uploads', 'onboarding-videos');
const allowedVideoMimeTypes = new Set(['video/mp4', 'video/webm', 'video/ogg']);

fs.mkdirSync(uploadDirectory, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => callback(null, uploadDirectory),
  filename: (_req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase() || '.mp4';
    callback(null, `${crypto.randomUUID()}${extension}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    if (!allowedVideoMimeTypes.has(file.mimetype)) {
      return callback(new Error('Formato no permitido. Usa MP4, WEBM u OGG.'));
    }
    return callback(null, true);
  },
});

const requireContentManager = async (req, res, next) => {
  try {
    if (!req.isAuthenticated?.() || !req.user?.id) {
      return res.status(401).json({ message: 'No autenticado' });
    }
    const [rows] = await pool.query(
      `SELECT r.name AS role_name
       FROM users u
       LEFT JOIN roles r ON r.id = u.role_id
       WHERE u.id = ? AND u.status = 'active'
       LIMIT 1`,
      [req.user.id]
    );
    if (!['admin', 'coordinator'].includes(normalizeRole(rows[0]?.role_name))) {
      return res.status(403).json({ message: 'No tienes permisos para administrar el contenido inicial' });
    }
    return next();
  } catch (error) {
    return next(error);
  }
};

router.use(requireContentManager);

router.get('/videos', async (_req, res, next) => {
  try {
    await ensureOnboardingContentTables();
    const [videos] = await pool.query(
      `SELECT ov.*,
         (SELECT COUNT(*) FROM onboarding_video_questions ovq WHERE ovq.video_id = ov.id) AS question_count
       FROM onboarding_videos ov
       ORDER BY ov.sort_order, ov.id`
    );
    const [questions] = await pool.query(
      `SELECT * FROM onboarding_video_questions
       ORDER BY video_id, sort_order, id`
    );
    const questionsByVideo = new Map();
    questions.forEach((question) => {
      const list = questionsByVideo.get(Number(question.video_id)) || [];
      list.push({ ...question, options: parseJson(question.options_json, []) });
      questionsByVideo.set(Number(question.video_id), list);
    });
    return res.json(videos.map((video) => ({
      ...video,
      question_count: Number(video.question_count || 0),
      questions: questionsByVideo.get(Number(video.id)) || [],
    })));
  } catch (error) {
    return next(error);
  }
});

router.post('/videos', upload.single('video'), async (req, res, next) => {
  try {
    await ensureOnboardingContentTables();
    const title = String(req.body?.title || '').trim();
    const description = String(req.body?.description || '').trim() || null;
    const sortOrder = Number(req.body?.sort_order || 0);
    if (!title || !req.file) {
      if (req.file?.path) await fs.promises.unlink(req.file.path).catch(() => undefined);
      return res.status(400).json({ message: 'El título y el archivo de video son requeridos' });
    }

    const externalKey = crypto.randomUUID();
    const fileUrl = `/uploads/onboarding-videos/${req.file.filename}`;
    const [result] = await pool.query(
      `INSERT INTO onboarding_videos
       (external_key, title, description, original_file_name, stored_file_name, file_url,
        mime_type, file_size, sort_order, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      [
        externalKey,
        title,
        description,
        req.file.originalname,
        req.file.filename,
        fileUrl,
        req.file.mimetype,
        req.file.size,
        Number.isFinite(sortOrder) ? sortOrder : 0,
        req.user.id,
      ]
    );
    const [rows] = await pool.query('SELECT * FROM onboarding_videos WHERE id = ? LIMIT 1', [result.insertId]);
    return res.status(201).json(rows[0]);
  } catch (error) {
    if (req.file?.path) await fs.promises.unlink(req.file.path).catch(() => undefined);
    return next(error);
  }
});

router.put('/videos/:id', async (req, res, next) => {
  try {
    await ensureOnboardingContentTables();
    const title = String(req.body?.title || '').trim();
    const description = String(req.body?.description || '').trim() || null;
    const status = String(req.body?.status || 'active');
    const sortOrder = Number(req.body?.sort_order || 0);
    if (!title || !['active', 'inactive'].includes(status)) {
      return res.status(400).json({ message: 'Título o estado inválido' });
    }
    const [result] = await pool.query(
      `UPDATE onboarding_videos
       SET title = ?, description = ?, status = ?, sort_order = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [title, description, status, Number.isFinite(sortOrder) ? sortOrder : 0, req.params.id]
    );
    if (!result.affectedRows) return res.status(404).json({ message: 'Video no encontrado' });
    const [rows] = await pool.query('SELECT * FROM onboarding_videos WHERE id = ? LIMIT 1', [req.params.id]);
    return res.json(rows[0]);
  } catch (error) {
    return next(error);
  }
});

router.delete('/videos/:id', async (req, res, next) => {
  try {
    await ensureOnboardingContentTables();
    const [rows] = await pool.query('SELECT stored_file_name FROM onboarding_videos WHERE id = ? LIMIT 1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: 'Video no encontrado' });
    await pool.query('DELETE FROM onboarding_videos WHERE id = ?', [req.params.id]);
    if (rows[0].stored_file_name) {
      await fs.promises.unlink(path.join(uploadDirectory, rows[0].stored_file_name)).catch(() => undefined);
    }
    return res.status(204).send();
  } catch (error) {
    return next(error);
  }
});

router.post('/videos/:videoId/questions', async (req, res, next) => {
  try {
    await ensureOnboardingContentTables();
    const questionText = String(req.body?.question_text || '').trim();
    const answerType = String(req.body?.answer_type || 'text');
    const options = Array.isArray(req.body?.options)
      ? req.body.options.map((option) => String(option).trim()).filter(Boolean)
      : [];
    const sortOrder = Number(req.body?.sort_order || 0);
    if (!questionText || !['text', 'multiple_choice'].includes(answerType)) {
      return res.status(400).json({ message: 'Pregunta o tipo de respuesta inválido' });
    }
    if (answerType === 'multiple_choice' && options.length < 2) {
      return res.status(400).json({ message: 'La selección múltiple requiere al menos dos opciones' });
    }
    const [videos] = await pool.query('SELECT id FROM onboarding_videos WHERE id = ? LIMIT 1', [req.params.videoId]);
    if (!videos.length) return res.status(404).json({ message: 'Video no encontrado' });
    const [result] = await pool.query(
      `INSERT INTO onboarding_video_questions
       (video_id, question_text, answer_type, options_json, is_required, sort_order)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        req.params.videoId,
        questionText,
        answerType,
        answerType === 'multiple_choice' ? JSON.stringify(options) : null,
        req.body?.is_required === false ? 0 : 1,
        Number.isFinite(sortOrder) ? sortOrder : 0,
      ]
    );
    const [rows] = await pool.query('SELECT * FROM onboarding_video_questions WHERE id = ? LIMIT 1', [result.insertId]);
    return res.status(201).json({ ...rows[0], options: parseJson(rows[0].options_json, []) });
  } catch (error) {
    return next(error);
  }
});

router.delete('/questions/:id', async (req, res, next) => {
  try {
    await ensureOnboardingContentTables();
    const [result] = await pool.query('DELETE FROM onboarding_video_questions WHERE id = ?', [req.params.id]);
    if (!result.affectedRows) return res.status(404).json({ message: 'Pregunta no encontrada' });
    return res.status(204).send();
  } catch (error) {
    return next(error);
  }
});

router.get('/videos/:videoId/responses', async (req, res, next) => {
  try {
    await ensureOnboardingContentTables();
    const [rows] = await pool.query(
      `SELECT
         ova.id,
         ova.user_id,
         u.first_name,
         u.last_name,
         u.email,
         ovq.id AS question_id,
         ovq.question_text,
         ovq.answer_type,
         ova.answer_text,
         ova.answered_at,
         ova.updated_at
       FROM onboarding_video_answers ova
       INNER JOIN users u ON u.id = ova.user_id
       INNER JOIN onboarding_video_questions ovq ON ovq.id = ova.question_id
       WHERE ova.video_id = ?
       ORDER BY u.first_name, u.last_name, ovq.sort_order, ovq.id`,
      [req.params.videoId]
    );
    return res.json(rows);
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
