const pool = require('../config/db');

const LEGACY_VIDEOS = [
  {
    externalKey: '1NqfjGr40HNU5GC9Ku9PotKaBXEURtVbJ',
    title: 'Código de conducta',
    fileUrl: '/media/onboarding/codigo-conducta.mp4',
    sortOrder: 1,
  },
  {
    externalKey: '1ALQReb1dU_UDG-KMvOe_1FPYopnh5vOv',
    title: 'Salvaguarda',
    fileUrl: '/media/onboarding/salvaguarda.mp4',
    sortOrder: 2,
  },
];

const parseJson = (value, fallback = []) => {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
};

const ensureOnboardingContentTables = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS onboarding_videos (
      id INT PRIMARY KEY AUTO_INCREMENT,
      external_key VARCHAR(100) NOT NULL UNIQUE,
      title VARCHAR(200) NOT NULL,
      description TEXT NULL,
      original_file_name VARCHAR(255) NULL,
      stored_file_name VARCHAR(255) NULL,
      file_url VARCHAR(500) NOT NULL,
      mime_type VARCHAR(100) NULL,
      file_size BIGINT NULL,
      sort_order INT NOT NULL DEFAULT 0,
      status ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
      created_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT fk_onboarding_video_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
      INDEX idx_onboarding_video_status_order (status, sort_order)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS onboarding_video_questions (
      id INT PRIMARY KEY AUTO_INCREMENT,
      video_id INT NOT NULL,
      question_text VARCHAR(500) NOT NULL,
      answer_type ENUM('text', 'multiple_choice') NOT NULL,
      options_json JSON NULL,
      is_required BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT fk_onboarding_question_video FOREIGN KEY (video_id) REFERENCES onboarding_videos(id) ON DELETE CASCADE,
      INDEX idx_onboarding_question_video_order (video_id, sort_order)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS onboarding_video_progress (
      id INT PRIMARY KEY AUTO_INCREMENT,
      user_id INT NOT NULL,
      video_id INT NOT NULL,
      watched_percentage DECIMAL(5,2) NOT NULL DEFAULT 0,
      completed_at TIMESTAMP NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_onboarding_video_progress (user_id, video_id),
      CONSTRAINT fk_onboarding_progress_user_content FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      CONSTRAINT fk_onboarding_progress_video FOREIGN KEY (video_id) REFERENCES onboarding_videos(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS onboarding_video_answers (
      id INT PRIMARY KEY AUTO_INCREMENT,
      user_id INT NOT NULL,
      video_id INT NOT NULL,
      question_id INT NOT NULL,
      answer_text TEXT NOT NULL,
      answered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_onboarding_video_answer (user_id, question_id),
      CONSTRAINT fk_onboarding_answer_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      CONSTRAINT fk_onboarding_answer_video FOREIGN KEY (video_id) REFERENCES onboarding_videos(id) ON DELETE CASCADE,
      CONSTRAINT fk_onboarding_answer_question FOREIGN KEY (question_id) REFERENCES onboarding_video_questions(id) ON DELETE CASCADE,
      INDEX idx_onboarding_answer_video_user (video_id, user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  for (const video of LEGACY_VIDEOS) {
    await pool.query(
      `INSERT INTO onboarding_videos (external_key, title, file_url, sort_order, status)
       VALUES (?, ?, ?, ?, 'active')
       ON DUPLICATE KEY UPDATE title = VALUES(title), file_url = VALUES(file_url)`,
      [video.externalKey, video.title, video.fileUrl, video.sortOrder]
    );
  }

  const [progressTables] = await pool.query("SHOW TABLES LIKE 'volunteer_onboarding_progress'");
  if (progressTables.length) {
    await pool.query(
      `INSERT INTO onboarding_video_progress (user_id, video_id, watched_percentage, completed_at)
       SELECT vop.user_id, ov.id, 100, COALESCE(vop.updated_at, CURRENT_TIMESTAMP)
       FROM volunteer_onboarding_progress vop
       INNER JOIN onboarding_videos ov
         ON JSON_CONTAINS(COALESCE(vop.intro_videos_watched, JSON_ARRAY()), JSON_QUOTE(ov.external_key))
       ON DUPLICATE KEY UPDATE watched_percentage = GREATEST(watched_percentage, VALUES(watched_percentage)),
         completed_at = COALESCE(completed_at, VALUES(completed_at))`
    );
  }
};

const getVideoCompletion = async (userId) => {
  await ensureOnboardingContentTables();
  const [rows] = await pool.query(
    `SELECT
       ov.id,
       ov.external_key,
       COALESCE(ovp.watched_percentage, 0) AS watched_percentage,
       COUNT(ovq.id) AS required_questions,
       COUNT(ova.id) AS answered_questions
     FROM onboarding_videos ov
     LEFT JOIN onboarding_video_progress ovp ON ovp.video_id = ov.id AND ovp.user_id = ?
     LEFT JOIN onboarding_video_questions ovq ON ovq.video_id = ov.id AND ovq.is_required = TRUE
     LEFT JOIN onboarding_video_answers ova ON ova.question_id = ovq.id AND ova.user_id = ?
     WHERE ov.status = 'active'
     GROUP BY ov.id, ov.external_key, ovp.watched_percentage
     ORDER BY ov.sort_order, ov.id`,
    [userId, userId]
  );

  const videos = rows.map((row) => ({
    id: Number(row.id),
    externalKey: row.external_key,
    watchedPercentage: Number(row.watched_percentage || 0),
    requiredQuestions: Number(row.required_questions || 0),
    answeredQuestions: Number(row.answered_questions || 0),
    complete:
      Number(row.watched_percentage || 0) >= 100 &&
      Number(row.answered_questions || 0) >= Number(row.required_questions || 0),
  }));

  return {
    videos,
    complete: videos.length > 0 && videos.every((video) => video.complete),
    completedExternalKeys: videos.filter((video) => video.complete).map((video) => video.externalKey),
  };
};

const getVolunteerVideos = async (userId) => {
  await ensureOnboardingContentTables();
  const [videos] = await pool.query(
    `SELECT ov.*, COALESCE(ovp.watched_percentage, 0) AS watched_percentage, ovp.completed_at
     FROM onboarding_videos ov
     LEFT JOIN onboarding_video_progress ovp ON ovp.video_id = ov.id AND ovp.user_id = ?
     WHERE ov.status = 'active'
     ORDER BY ov.sort_order, ov.id`,
    [userId]
  );
  const [questions] = await pool.query(
    `SELECT ovq.*, ova.answer_text
     FROM onboarding_video_questions ovq
     INNER JOIN onboarding_videos ov ON ov.id = ovq.video_id AND ov.status = 'active'
     LEFT JOIN onboarding_video_answers ova ON ova.question_id = ovq.id AND ova.user_id = ?
     ORDER BY ovq.video_id, ovq.sort_order, ovq.id`,
    [userId]
  );

  const questionsByVideo = new Map();
  questions.forEach((question) => {
    const list = questionsByVideo.get(Number(question.video_id)) || [];
    list.push({
      id: Number(question.id),
      question_text: question.question_text,
      answer_type: question.answer_type,
      options: parseJson(question.options_json, []),
      is_required: Boolean(question.is_required),
      sort_order: Number(question.sort_order || 0),
      answer: question.answer_text || '',
    });
    questionsByVideo.set(Number(question.video_id), list);
  });

  const completion = await getVideoCompletion(userId);
  const completionByVideo = new Map(completion.videos.map((video) => [video.id, video]));
  return videos.map((video) => ({
    id: Number(video.id),
    external_key: video.external_key,
    title: video.title,
    description: video.description,
    file_url: video.file_url,
    mime_type: video.mime_type,
    sort_order: Number(video.sort_order || 0),
    watched_percentage: Number(video.watched_percentage || 0),
    completed_at: video.completed_at,
    complete: Boolean(completionByVideo.get(Number(video.id))?.complete),
    questions: questionsByVideo.get(Number(video.id)) || [],
  }));
};

module.exports = {
  ensureOnboardingContentTables,
  getVideoCompletion,
  getVolunteerVideos,
  parseJson,
};
