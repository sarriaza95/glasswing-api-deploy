const express = require('express');
const pool = require('../config/db');
const tables = require('../config/tables');

const router = express.Router();

const getTableConfig = (table) => tables[table] || null;

const buildSetClause = (payload) => Object.keys(payload).map((key) => `\`${key}\` = ?`).join(', ');

router.get('/meta/tables', (_req, res) => {
  res.json({ tables: Object.keys(tables) });
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

  const payload = req.body;
  const fields = Object.keys(payload);
  if (!fields.length) return res.status(400).json({ message: 'Payload vacío' });

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

  const payload = req.body;
  const fields = Object.keys(payload);
  if (!fields.length) return res.status(400).json({ message: 'Payload vacío' });

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
