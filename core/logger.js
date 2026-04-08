/**
 * core/logger.js — Logger simple con timestamp
 */

const fs   = require('fs');
const path = require('path');

const LOG_FILE = process.env.LOG_FILE ? path.resolve(process.env.LOG_FILE) : null;
const recentLogs = [];
const MAX_LOGS = 200;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  process.stdout.write(Buffer.from(line + '\n', 'utf8'));
  recentLogs.push(line);
  if (recentLogs.length > MAX_LOGS) recentLogs.shift();
  if (LOG_FILE) {
    try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) {}
  }
}

function getRecentLogs(n = 50) {
  return recentLogs.slice(-n);
}

module.exports = { log, getRecentLogs };
