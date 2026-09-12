const winston = require('winston');
const path = require('node:path');
const readline = require('node:readline');

function createLogger(directory, filename, consoleOutput = false) {
  return winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
    transports: [
      new winston.transports.File({ filename: path.join(directory, filename), maxsize: 10 * 1024 * 1024, maxFiles: 5 }),
      ...(consoleOutput ? [new winston.transports.Console()] : []),
    ],
  });
}

function captureOutput(stream, logger, metadata) {
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  lines.on('line', line => {
    // Filter complete lines so split chunks cannot leak QSV diagnostics.
    if (!line.trim() || /\b\w*_qsv\b|\bQSV\b|\bMFX\b|mfx implementation/i.test(line)) return;
    // Topaz may print authentication payloads during model initialization.
    if (/TopazAuthManager|eyJ[A-Za-z0-9_-]+\.|access_token|refresh_token|refresh_studio|username_studio/i.test(line)) return;
    logger.info('task.output', { ...metadata, text: line });
  });
  return lines;
}

module.exports = { createLogger, captureOutput };
