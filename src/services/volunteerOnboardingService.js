const pool = require('../config/db');

const REQUIRED_INTRO_VIDEO_IDS = [
  '1NqfjGr40HNU5GC9Ku9PotKaBXEURtVbJ',
  '1ALQReb1dU_UDG-KMvOe_1FPYopnh5vOv',
];

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
  intro_videos_watched: 'JSON NULL',
  completed_at: 'TIMESTAMP NULL',
};

const nullableBoolean = (value) => {
  if (value === null || value === undefined || value === '') return null;
  if ([true, 1, '1', 'true', 'yes'].includes(value)) return true;
  if ([false, 0, '0', 'false', 'no'].includes(value)) return false;
  return null;
};

const normalizeWatchedVideoIds = (value) => {
  let videoIds = value;
  if (typeof videoIds === 'string') {
    try {
      videoIds = JSON.parse(videoIds);
    } catch (_error) {
      videoIds = [];
    }
  }
  if (!Array.isArray(videoIds)) return [];
  return [...new Set(videoIds.map(String).filter((id) => REQUIRED_INTRO_VIDEO_IDS.includes(id)))];
};

const allIntroVideosWatched = (value) => {
  const watched = new Set(normalizeWatchedVideoIds(value));
  return REQUIRED_INTRO_VIDEO_IDS.every((id) => watched.has(id));
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
      intro_videos_watched JSON NULL,
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
  if (nullableBoolean(payload.first_time_volunteer) === null) return 'first_time_volunteer es requerido';
  if (nullableBoolean(payload.is_studying) === null) return 'is_studying es requerido';

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

const saveInitialProfile = async (userId, payload) => {
  await ensureProgressTable();
  const isStudying = nullableBoolean(payload.is_studying);
  await pool.query(
    `INSERT INTO volunteer_onboarding_progress
     (user_id, current_step, full_name, email, phone, country_id, date_of_birth, sex,
      first_time_volunteer, is_studying, study_center, needs_service_hours, availability,
      interest_area, previous_experience, referral_source, referral_source_other,
      intro_videos_watched, video_watched, selected_charlas)
     VALUES (?, 'intro-video', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, JSON_ARRAY(), false, JSON_ARRAY())
     ON DUPLICATE KEY UPDATE
       current_step = 'intro-video', full_name = VALUES(full_name), email = VALUES(email),
       phone = VALUES(phone), country_id = VALUES(country_id), date_of_birth = VALUES(date_of_birth),
       sex = VALUES(sex), first_time_volunteer = VALUES(first_time_volunteer),
       is_studying = VALUES(is_studying), study_center = VALUES(study_center),
       needs_service_hours = VALUES(needs_service_hours), availability = VALUES(availability),
       interest_area = VALUES(interest_area), previous_experience = VALUES(previous_experience),
       referral_source = VALUES(referral_source), referral_source_other = VALUES(referral_source_other)`,
    [
      userId,
      payload.full_name,
      payload.email,
      payload.phone,
      payload.country_id,
      payload.date_of_birth,
      payload.sex,
      nullableBoolean(payload.first_time_volunteer),
      isStudying,
      isStudying ? payload.study_center || null : null,
      isStudying ? nullableBoolean(payload.needs_service_hours) : null,
      payload.availability,
      payload.interest_area,
      String(payload.previous_experience).trim(),
      payload.referral_source,
      payload.referral_source === 'other' ? String(payload.referral_source_other || '').trim() : null,
    ]
  );
};

module.exports = {
  REQUIRED_INTRO_VIDEO_IDS,
  allIntroVideosWatched,
  ensureProgressTable,
  normalizeWatchedVideoIds,
  nullableBoolean,
  saveInitialProfile,
  validateProfilePayload,
};
