const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { once } = require('node:events');
const { captureOutput } = require('./logger');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

test('HTTP requests are recorded by Winston', { timeout: 15000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'topaz-log-test-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: { ...process.env, PORT: '0', DB_PATH: path.join(dir, 'jobs.db'), LOG_DIR: dir, OUTPUT_DIR: path.join(dir, 'output') },
  });
  const exited = once(child, 'exit');
  try {
    const port = await new Promise((resolve, reject) => {
      let buffer = '';
      child.on('error', reject);
      child.on('exit', code => reject(new Error(`Server exited: ${code}`)));
      child.stdout.on('data', data => {
        buffer += data;
        for (const line of buffer.split('\n')) {
          if (line.includes('service.started')) resolve(JSON.parse(line).port);
        }
      });
    });
    const response = await fetch(`http://127.0.0.1:${port}/jobs/missing`);
    assert.equal(response.status, 404);
    assert.ok(response.headers.get('x-request-id'));
    await new Promise(resolve => setTimeout(resolve, 300));
    const records = fs.readFileSync(path.join(dir, 'service.log'), 'utf8');
    assert.match(records, /http.response/);
  } finally {
    child.kill();
    await exited;
  }
});

test('filters split QSV diagnostics while preserving progress, other errors and final lines', async () => {
  const stream = new PassThrough();
  const records = [];
  const lines = captureOutput(stream, { info: (event, data) => records.push(data) }, { jobId: 'test' });
  const closed = once(lines, 'close');
  stream.write('[h264_q');
  stream.write('sv @ 123] Error creating a MFX session: -9\r\n');
  stream.write('The current mfx implementation is not supported\n');
  stream.write('frame=24\r[h264_nvenc] encoder failed\n');
  stream.write('[TopazAuthManager] private payload\n');
  stream.end('Conversion failed!');
  await closed;
  assert.deepEqual(records.map(r => r.text), ['frame=24', '[h264_nvenc] encoder failed', 'Conversion failed!']);
  assert.ok(records.every(r => r.jobId === 'test'));
});
