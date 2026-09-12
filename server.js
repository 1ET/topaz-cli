require('dotenv').config();
const express = require('express'), { spawn } = require('node:child_process'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), Database = require('better-sqlite3');
const root = __dirname, inputRoot = path.resolve(process.env.INPUT_ROOT || root), out = path.resolve(process.env.OUTPUT_DIR || path.join(root, 'output')), logs = path.resolve(process.env.LOG_DIR || path.join(root, 'logs')), dbPath = path.resolve(process.env.DB_PATH || path.join(root, 'jobs.db')), script = path.resolve(process.env.UPSCALE_SCRIPT || path.join(root, 'upscale_iris_720p.ps1'));
fs.mkdirSync(out, { recursive: true }); fs.mkdirSync(logs, { recursive: true });
const db = new Database(dbPath); db.exec('CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,input TEXT,output TEXT,status TEXT,created_at TEXT,started_at TEXT,finished_at TEXT,duration_ms INTEGER,exit_code INTEGER,log_file TEXT)'); let busy = false;
const { createLogger, captureOutput } = require('./logger');
const logger = createLogger(logs, 'service.log', true);
function worker() {
  if (busy) return;
  const j = db.prepare("SELECT * FROM jobs WHERE status='queued' ORDER BY created_at, rowid LIMIT 1").get();
  if (!j) return;
  busy = true;
  const t = Date.now();
  db.prepare('UPDATE jobs SET status=?,started_at=? WHERE id=?').run('running', new Date().toISOString(), j.id);
  const log = createLogger(path.dirname(j.log_file), path.basename(j.log_file));
  log.on('error', error => logger.error('task.log_error', { jobId: j.id, error: error.message }));
  const record = (level, event, details = {}) => {
    const fields = { jobId: j.id, ...details };
    logger.log(level, event, fields);
    log.log(level, event, fields);
  };
  record('info', 'task.started', { input: j.input, output: j.output });
  const p = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-InputFile', j.input, '-OutputFile', j.output], { windowsHide: true });
  captureOutput(p.stdout, log, { jobId: j.id, stream: 'stdout' });
  captureOutput(p.stderr, log, { jobId: j.id, stream: 'stderr' });
  let spawnError;
  p.on('error', error => { spawnError = error; record('error', 'task.spawn_error', { error: error.message }); });
  p.on('close', (code, signal) => {
    const duration = Date.now() - t;
    const status = code === 0 && !spawnError ? 'completed' : 'failed';
    db.prepare('UPDATE jobs SET status=?,finished_at=?,duration_ms=?,exit_code=? WHERE id=?').run(status, new Date().toISOString(), duration, code, j.id);
    record(status === 'completed' ? 'info' : 'error', `task.${status}`, { exitCode: code, signal, durationMs: duration });
    log.end();
    busy = false;
    setImmediate(worker);
  });
}
const app = express();
app.use((q, r, next) => {
  q.requestId = crypto.randomUUID();
  r.setHeader('X-Request-ID', q.requestId);
  const started = Date.now();
  logger.info('http.request', { requestId: q.requestId, method: q.method, path: q.path });
  r.on('finish', () => logger.info('http.response', { requestId: q.requestId, jobId: r.locals.jobId, method: q.method, path: q.path, statusCode: r.statusCode, durationMs: Date.now() - started }));
  next();
});
app.use(express.json());
app.post('/jobs', (q, r) => {
  if (q.body?.input !== undefined && typeof q.body.input !== 'string') return r.status(400).json({ error: 'invalid input' });
  const input = path.resolve(q.body?.input || path.join(inputRoot, 'orginal.mp4'));
  if (!input.startsWith(inputRoot + path.sep) || !fs.existsSync(input)) return r.status(400).json({ error: 'invalid input' });
  const id = crypto.randomUUID(), output = path.join(out, `${path.basename(input, path.extname(input))}_${id}_720p_iris.mp4`), log = path.join(logs, id + '.log');
  db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,NULL,NULL,NULL,NULL,?)').run(id, input, output, 'queued', new Date().toISOString(), log);
  r.locals.jobId = id;
  logger.info('task.queued', { requestId: q.requestId, jobId: id, input, output });
  r.status(202).json({ id, status: 'queued' });
  setImmediate(worker);
});
app.get('/jobs/:id', (q, r) => { const j = db.prepare('SELECT id,input,output,status,created_at,started_at,finished_at,duration_ms,exit_code FROM jobs WHERE id=?').get(q.params.id); if (!j) return r.sendStatus(404); if (j.status === 'completed') j.download = `/jobs/${j.id}/download`; r.json(j); });
app.get('/jobs/:id/download', (q, r) => { const j = db.prepare("SELECT * FROM jobs WHERE id=? AND status='completed'").get(q.params.id); if (!j || !fs.existsSync(j.output)) return r.sendStatus(404); r.download(j.output); });
app.use((error, q, r, next) => {
  logger.error('http.error', { requestId: q.requestId, error: error.message });
  if (r.headersSent) return next(error);
  r.status(error.status || 500).json({ error: error.status === 400 ? 'invalid request' : 'internal server error', requestId: q.requestId });
});
const server = app.listen(process.env.PORT || 3000, () => { logger.info('service.started', { port: server.address().port }); worker(); });
server.on('error', error => { logger.error('service.error', { error: error.message }); process.exitCode = 1; logger.end(); });
