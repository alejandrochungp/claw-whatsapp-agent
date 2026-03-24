/**
 * core/logger.js — Logger simple con timestamp
 */

const fs   = require('fs');
const path = require('path');

const LOG_FILE = process.env.LOG_FILE ? path.resolve(process.env.LOG_FILE) : null;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  if (LOG_FILE) {
    try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) {}
  }
}

module.exports = { log };
