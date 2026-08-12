const pool = require('../config/db');

const normalizeRoleName = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/_/g, '-');

const roleAliases = {
  administrator: 'admin',
  administrador: 'admin',
  coordinador: 'coordinator',
  coordinate: 'coordinator',
  coordinator: 'coordinator',
  coach: 'coach',
  entrenador: 'coach',
  voluntario: 'volunteer',
  volunteer: 'volunteer',
};

const normalizeRole = (value) => roleAliases[normalizeRoleName(value)] || normalizeRoleName(value);

const ensureAuthenticated = (req, res, next) => {
  if (!req.isAuthenticated?.() || !req.user?.id) {
    return res.status(401).json({ message: 'No autenticado' });
  }

  return next();
};

const getUserAccess = async (userId) => {
  const [users] = await pool.query(
    `SELECT u.id, u.country_id, u.status, r.name AS role_name
     FROM users u
     LEFT JOIN roles r ON r.id = u.role_id
     WHERE u.id = ?
     LIMIT 1`,
    [userId]
  );

  const user = users[0] || null;
  const role = normalizeRole(user?.role_name);

  let scopedProgramIds = [];
  if (role === 'coach') {
    const [programRows] = await pool.query(
      `SELECT DISTINCT program_id
       FROM (
        SELECT program_id FROM sessions WHERE coach_id = ?
        UNION
        SELECT program_id FROM program_groups WHERE coach_id = ?
       ) scoped
       WHERE program_id IS NOT NULL`,
      [userId, userId]
    );
    scopedProgramIds = programRows.map((row) => Number(row.program_id)).filter(Boolean);
  }

  return {
    user,
    role,
    scopedProgramIds,
    isAdmin: role === 'admin',
    isCoordinator: role === 'coordinator',
    isCoach: role === 'coach',
    isVolunteer: role === 'volunteer',
  };
};

const attachUserAccess = async (req, res, next) => {
  try {
    if (!req.userAccess) req.userAccess = await getUserAccess(req.user.id);
    return next();
  } catch (error) {
    return next(error);
  }
};

const forbidden = (res) => res.status(403).json({ message: 'No tienes permisos para realizar esta accion' });

const roleAllowed = (role, roles) => roles.map(normalizeRole).includes(role);

const canUseVolunteerPortal = (req) =>
  roleAllowed(req.userAccess?.role, ['volunteer']) ||
  (Boolean(req.session?.managedVolunteerId) && roleAllowed(req.userAccess?.role, ['admin', 'coach']));

const requireRoles = (...roles) => [
  ensureAuthenticated,
  attachUserAccess,
  (req, res, next) => {
    if (!roleAllowed(req.userAccess.role, roles)) return forbidden(res);
    return next();
  },
];

const ensureCoachCanAccessProgram = (req, res, next, programId) => {
  if (!req.userAccess?.isCoach) return next();
  if (!programId) return forbidden(res);
  if (!req.userAccess.scopedProgramIds.includes(Number(programId))) return forbidden(res);
  return next();
};

const requireCoachProgramBodyAccess = [
  ensureAuthenticated,
  attachUserAccess,
  (req, res, next) => ensureCoachCanAccessProgram(req, res, next, req.body?.program_id || req.body?.programId),
];

const requireCoachSessionAccess = [
  ensureAuthenticated,
  attachUserAccess,
  async (req, res, next) => {
    try {
      if (!req.userAccess?.isCoach) return next();
      const sessionId = req.params.id || req.params.sessionId || req.body?.session_id || req.body?.sessionId;
      if (!sessionId) return forbidden(res);

      const [sessions] = await pool.query(
        `SELECT id, program_id
         FROM sessions
         WHERE id = ?
           AND (coach_id = ? OR program_id IN (?))
         LIMIT 1`,
        [sessionId, req.user.id, req.userAccess.scopedProgramIds.length ? req.userAccess.scopedProgramIds : [0]]
      );

      if (!sessions.length) return forbidden(res);
      return next();
    } catch (error) {
      return next(error);
    }
  },
];

const tablePolicies = {
  roles: { read: ['admin'], write: ['admin'] },
  users: { read: ['admin'], write: ['admin'] },
  countries: { read: ['admin', 'coordinator', 'coach', 'volunteer'], write: ['admin'] },
  programs: { read: ['admin', 'coordinator', 'coach', 'volunteer'], write: ['admin', 'coordinator'] },
  volunteers: { read: ['admin', 'coordinator'], write: ['admin', 'coordinator'] },
  volunteer_programs: { read: ['admin', 'coordinator'], write: ['admin', 'coordinator'] },
  program_groups: { read: ['admin', 'coordinator', 'coach'], write: ['admin', 'coordinator'] },
  volunteer_group_members: { read: ['admin', 'coordinator'], write: ['admin', 'coordinator'] },
  volunteer_documents: { read: ['admin', 'coordinator'], write: ['admin', 'coordinator'] },
  volunteer_form_requests: { read: ['admin', 'coordinator'], write: ['admin', 'coordinator'] },
  sessions: { read: ['admin', 'coordinator', 'coach', 'volunteer'], write: ['admin', 'coordinator', 'coach'] },
  session_attendance: { read: ['admin', 'coordinator', 'coach'], write: ['admin', 'coordinator', 'coach'] },
  follow_ups: { read: ['admin', 'coordinator'], write: ['admin', 'coordinator'] },
  email_templates: { read: ['admin', 'coordinator'], write: ['admin'] },
  settings: { read: ['admin'], write: ['admin'] },
  audit_log: { read: ['admin'], write: ['admin'] },
  whatsapp_reminders: { read: ['admin'], write: ['admin'] },
};

const methodAction = (method) => (method === 'GET' ? 'read' : 'write');

const apiRoleGate = [
  ensureAuthenticated,
  attachUserAccess,
  async (req, res, next) => {
    try {
      const path = req.path;
      const method = req.method.toUpperCase();
      const role = req.userAccess.role;

      if (path.startsWith('/auth')) return next();

      if (path.startsWith('/volunteer-attendance/me')) {
        return canUseVolunteerPortal(req) ? next() : forbidden(res);
      }
      if (path.startsWith('/volunteer-attendance/register')) {
        return canUseVolunteerPortal(req) ? next() : forbidden(res);
      }
      if (path.startsWith('/volunteer-documents/me') || path.startsWith('/volunteer-documents/upload')) {
        return canUseVolunteerPortal(req) ? next() : forbidden(res);
      }
      if (path.startsWith('/volunteer-form-requests/me') || path.includes('/volunteer-form-requests/') && path.endsWith('/submit')) {
        return canUseVolunteerPortal(req) ? next() : forbidden(res);
      }

      if (path.startsWith('/volunteer-documents/review') || path.startsWith('/volunteer-form-requests/review')) {
        return roleAllowed(role, ['admin', 'coordinator']) ? next() : forbidden(res);
      }
      if (path === '/volunteer-form-requests' || /^\/volunteer-form-requests\/[^/]+\/review$/.test(path)) {
        return roleAllowed(role, ['admin', 'coordinator']) ? next() : forbidden(res);
      }
      if (path.startsWith('/reports/')) {
        return roleAllowed(role, ['admin', 'coordinator']) ? next() : forbidden(res);
      }

      if (path.startsWith('/attendance-summary') || path.startsWith('/attendance/mark')) {
        if (!roleAllowed(role, ['admin', 'coordinator', 'coach'])) return forbidden(res);
        if (role === 'coach' && (path.startsWith('/attendance-summary/') || path.startsWith('/attendance/mark'))) {
          return requireCoachSessionAccess[2](req, res, next);
        }
        return next();
      }

      if (path.startsWith('/trainings')) {
        if (method === 'GET' && roleAllowed(role, ['admin', 'coordinator', 'coach', 'volunteer'])) return next();
        if (!roleAllowed(role, ['admin', 'coordinator', 'coach'])) return forbidden(res);
        if (role === 'coach' && method !== 'GET') {
          if (method === 'POST') return requireCoachProgramBodyAccess[2](req, res, next);
          return requireCoachSessionAccess[2](req, res, next);
        }
        return next();
      }

      if (path.startsWith('/whatsapp-reminders')) {
        return roleAllowed(role, ['admin']) ? next() : forbidden(res);
      }

      const table = path.split('/').filter(Boolean)[0];
      if (tablePolicies[table]) {
        const action = methodAction(method);
        const allowed = tablePolicies[table][action] || [];
        if (!roleAllowed(role, allowed)) return forbidden(res);
        if (role === 'coach' && action === 'write' && !['sessions', 'session_attendance'].includes(table)) {
          return forbidden(res);
        }
        if (role === 'coach' && table === 'sessions' && method === 'POST') {
          return requireCoachProgramBodyAccess[2](req, res, next);
        }
        if (role === 'coach' && table === 'sessions' && ['PUT', 'DELETE'].includes(method)) {
          return requireCoachSessionAccess[2](req, res, next);
        }
        if (role === 'coach' && table === 'session_attendance' && method !== 'GET') {
          return requireCoachSessionAccess[2](req, res, next);
        }
        return next();
      }

      return roleAllowed(role, ['admin', 'coordinator']) ? next() : forbidden(res);
    } catch (error) {
      return next(error);
    }
  },
];

module.exports = {
  normalizeRole,
  ensureAuthenticated,
  attachUserAccess,
  requireRoles,
  requireCoachProgramBodyAccess,
  requireCoachSessionAccess,
  apiRoleGate,
};
