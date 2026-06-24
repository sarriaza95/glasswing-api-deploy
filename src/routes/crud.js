const express = require('express');
const pool = require('../config/db');
const tables = require('../config/tables');

const router = express.Router();

const getTableConfig = (table) => tables[table] || null;

const buildSetClause = (payload) => Object.keys(payload).map((key) => `\`${key}\` = ?`).join(', ');

const normalizeText = (value) =>
  String(value)
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/_/g, '-');

const normalizeBoolean = (value) => {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return value ? 1 : 0;

  const normalized = normalizeText(value);
  if (['true', '1', 'si', 'yes', 'activo', 'active'].includes(normalized)) return 1;
  if (['false', '0', 'no', 'inactivo', 'inactive'].includes(normalized)) return 0;

  return value;
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

const normalizeEnum = (table, field, value) => {
  if (value === null || value === undefined || value === '') return value;

  const normalized = normalizeText(value);
  if (table === 'sessions' && field === 'status') {
    const sessionStatus = {
      activo: 'scheduled',
      active: 'scheduled',
      inactivo: 'cancelled',
      inactive: 'cancelled',
      pendiente: 'scheduled',
      programado: 'scheduled',
      scheduled: 'scheduled',
      'en-progreso': 'in-progress',
      'in-progress': 'in-progress',
      completado: 'completed',
      completed: 'completed',
      cancelado: 'cancelled',
      cancelled: 'cancelled',
    };
    return sessionStatus[normalized] || value;
  }

  const mappings = {
    status: {
      activo: 'active',
      active: 'active',
      inactivo: 'inactive',
      inactive: 'inactive',
      suspendido: 'suspended',
      suspended: 'suspended',
      pendiente: 'pending',
      pending: 'pending',
      archivado: 'archived',
      archived: 'archived',
      inscrito: 'enrolled',
      enrolled: 'enrolled',
      completado: 'completed',
      completed: 'completed',
      abandonado: 'dropped',
      dropped: 'dropped',
      programado: 'scheduled',
      scheduled: 'scheduled',
      'en-progreso': 'in-progress',
      'in-progress': 'in-progress',
      cancelado: 'cancelled',
      cancelled: 'cancelled',
      presente: 'present',
      present: 'present',
      ausente: 'absent',
      absent: 'absent',
      excusado: 'excused',
      excused: 'excused',
      aprobado: 'approved',
      approved: 'approved',
      rechazado: 'rejected',
      rejected: 'rejected',
      sent: 'sent',
      enviado: 'sent',
      failed: 'failed',
      fallido: 'failed',
      'dry-run': 'dry-run',
      prueba: 'dry-run',
    },
    reminder_type: {
      future: 'future',
      futuro: 'future',
      proximo: 'future',
      absence: 'absence',
      ausencia: 'absence',
      inasistencia: 'absence',
    },
    session_type: {
      general: 'general',
      introduccion: 'general',
      intro: 'general',
      grupo: 'specialized',
      specialized: 'specialized',
      capacitacion: 'specialized',
      training: 'specialized',
      seguimiento: 'follow-up',
      'follow-up': 'follow-up',
    },
    delivery_mode: {
      virtual: 'virtual',
      presencial: 'in-person',
      'in-person': 'in-person',
      hibrido: 'hybrid',
      hibrida: 'hybrid',
      hybrid: 'hybrid',
    },
    attendance_method: {
      link: 'link',
      enlace: 'link',
      qr: 'qr',
      manual: 'manual',
    },
    follow_up_type: {
      'check-in': 'check-in',
      chequeo: 'check-in',
      motivacion: 'motivation',
      motivation: 'motivation',
      're-engagement': 're-engagement',
      reenganche: 're-engagement',
      soporte: 'support',
      support: 'support',
    },
    contact_method: {
      email: 'email',
      correo: 'email',
      whatsapp: 'whatsapp',
      call: 'call',
      llamada: 'call',
      presencial: 'in-person',
      'in-person': 'in-person',
    },
    template_type: {
      bienvenida: 'welcome',
      welcome: 'welcome',
      reminder: 'reminder',
      recordatorio: 'reminder',
      seguimiento: 'follow-up',
      'follow-up': 'follow-up',
      reporte: 'report',
      report: 'report',
      custom: 'custom',
      personalizado: 'custom',
    },
    setting_type: {
      string: 'string',
      texto: 'string',
      number: 'number',
      numero: 'number',
      boolean: 'boolean',
      booleano: 'boolean',
      json: 'json',
    },
  };

  const mapped = mappings[field]?.[normalized] || normalized;
  const allowedValues = tables[table]?.enums?.[field] || [];
  return allowedValues.includes(mapped) ? mapped : value;
};

const normalizePayload = (table, config, rawPayload) => {
  const payload = {};
  const aliases = config.aliases || {};
  const allowedFields = new Set(config.fields || []);
  const invalidFields = [];

  Object.entries(rawPayload || {}).forEach(([rawField, rawValue]) => {
    if (rawField === config.pk) return;

    const field = aliases[rawField] || rawField;
    if (!allowedFields.has(field)) {
      invalidFields.push(rawField);
      return;
    }

    let value = rawValue;
    if (config.jsonFields?.includes(field) && value !== null && typeof value !== 'string') {
      value = JSON.stringify(value);
    }
    if (config.booleanFields?.includes(field)) {
      value = normalizeBoolean(value);
    }
    if (field.endsWith('_date') || field === 'scheduled_date' || field === 'certification_date') {
      value = normalizeDateValue(value);
    }
    if (field.endsWith('_time') || field === 'start_time' || field === 'end_time') {
      value = normalizeTimeValue(value);
    }
    if (config.enums?.[field]) {
      value = normalizeEnum(table, field, value);
    }

    payload[field] = value;
  });

  const invalidEnums = Object.entries(config.enums || {})
    .filter(([field, values]) => payload[field] !== undefined && payload[field] !== null && !values.includes(payload[field]))
    .map(([field, values]) => ({ field, allowed: values }));

  return { payload, invalidFields, invalidEnums };
};

router.get('/meta/tables', (_req, res) => {
  res.json({
    tables: Object.keys(tables),
    metadata: Object.entries(tables).map(([name, config]) => ({
      name,
      pk: config.pk,
      fields: config.fields || [],
      enums: config.enums || {},
      aliases: config.aliases || {},
    })),
  });
});

router.get('/:table', async (req, res) => {
  const config = getTableConfig(req.params.table);
  if (!config) return res.status(404).json({ message: 'Tabla no soportada' });

  const [rows] = await pool.query(`SELECT * FROM \`${req.params.table}\` LIMIT 500`);
  return res.json(rows);
});

router.get('/:table/:id', async (req, res) => {
  const config = getTableConfig(req.params.table);
  if (!config) return res.status(404).json({ message: 'Tabla no soportada' });

  const [rows] = await pool.query(
    `SELECT * FROM \`${req.params.table}\` WHERE \`${config.pk}\` = ? LIMIT 1`,
    [req.params.id]
  );

  if (!rows.length) return res.status(404).json({ message: 'Registro no encontrado' });
  return res.json(rows[0]);
});

router.post('/:table', async (req, res) => {
  const config = getTableConfig(req.params.table);
  if (!config) return res.status(404).json({ message: 'Tabla no soportada' });

  const { payload, invalidFields, invalidEnums } = normalizePayload(req.params.table, config, req.body);
  if (invalidFields.length) {
    return res.status(400).json({ message: 'Campos no soportados para esta tabla', fields: invalidFields });
  }
  if (invalidEnums.length) {
    return res.status(400).json({ message: 'Valores invalidos para campos enum', fields: invalidEnums });
  }

  const fields = Object.keys(payload);
  if (!fields.length) return res.status(400).json({ message: 'Payload vacio' });

  const columns = fields.map((f) => `\`${f}\``).join(', ');
  const placeholders = fields.map(() => '?').join(', ');
  const values = fields.map((f) => payload[f]);

  const [result] = await pool.query(
    `INSERT INTO \`${req.params.table}\` (${columns}) VALUES (${placeholders})`,
    values
  );

  const [rows] = await pool.query(
    `SELECT * FROM \`${req.params.table}\` WHERE \`${config.pk}\` = ? LIMIT 1`,
    [result.insertId]
  );

  return res.status(201).json(rows[0] || { id: result.insertId });
});

router.put('/:table/:id', async (req, res) => {
  const config = getTableConfig(req.params.table);
  if (!config) return res.status(404).json({ message: 'Tabla no soportada' });

  const { payload, invalidFields, invalidEnums } = normalizePayload(req.params.table, config, req.body);
  if (invalidFields.length) {
    return res.status(400).json({ message: 'Campos no soportados para esta tabla', fields: invalidFields });
  }
  if (invalidEnums.length) {
    return res.status(400).json({ message: 'Valores invalidos para campos enum', fields: invalidEnums });
  }

  const fields = Object.keys(payload);
  if (!fields.length) return res.status(400).json({ message: 'Payload vacio' });

  const setClause = buildSetClause(payload);
  const values = [...fields.map((f) => payload[f]), req.params.id];

  const [result] = await pool.query(
    `UPDATE \`${req.params.table}\` SET ${setClause} WHERE \`${config.pk}\` = ?`,
    values
  );

  if (result.affectedRows === 0) return res.status(404).json({ message: 'Registro no encontrado' });

  const [rows] = await pool.query(
    `SELECT * FROM \`${req.params.table}\` WHERE \`${config.pk}\` = ? LIMIT 1`,
    [req.params.id]
  );

  return res.json(rows[0]);
});

router.delete('/:table/:id', async (req, res) => {
  const config = getTableConfig(req.params.table);
  if (!config) return res.status(404).json({ message: 'Tabla no soportada' });

  const [result] = await pool.query(
    `DELETE FROM \`${req.params.table}\` WHERE \`${config.pk}\` = ?`,
    [req.params.id]
  );

  if (result.affectedRows === 0) return res.status(404).json({ message: 'Registro no encontrado' });
  return res.status(204).send();
});

module.exports = router;
