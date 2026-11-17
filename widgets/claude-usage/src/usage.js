'use strict';

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const DAY_MS = 24 * 60 * 60 * 1000;

function resolveProjectDirs() {
  const candidates = [];
  if (process.env.CLAUDE_CONFIG_DIR) {
    for (const dir of process.env.CLAUDE_CONFIG_DIR.split(',')) {
      if (dir.trim()) candidates.push(path.join(dir.trim(), 'projects'));
    }
  }
  candidates.push(path.join(os.homedir(), '.claude', 'projects'));
  candidates.push(path.join(os.homedir(), '.config', 'claude', 'projects'));
  return [...new Set(candidates)].filter((dir) => fs.existsSync(dir));
}

function localDayKey(timestampMs) {
  const d = new Date(timestampMs);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

function startOfLocalDay(timestampMs) {
  const d = new Date(timestampMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function createEmptyDay() {
  return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, messages: 0, sessions: new Set(), models: {} };
}

function totalOf(day) {
  return day.input + day.output + day.cacheWrite + day.cacheRead;
}

async function collectJsonlFiles(dir, modifiedSince, found = []) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectJsonlFiles(fullPath, modifiedSince, found);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      try {
        const stat = await fsp.stat(fullPath);
        if (stat.mtimeMs >= modifiedSince) found.push({ path: fullPath, size: stat.size });
      } catch {
        /* ficheiro removido entretanto */
      }
    }
  }
  return found;
}

/**
 * Lê os transcripts JSONL do Claude Code de forma incremental:
 * cada ficheiro é lido apenas a partir do último offset processado.
 */
class UsageTracker {
  constructor({ historyDays = 7 } = {}) {
    this.historyDays = historyDays;
    this.fileCursors = new Map(); // path -> { offset, leftover: Buffer }
    this.seenMessages = new Map(); // dedupeKey -> dayKey
    this.days = new Map(); // dayKey -> stats
    this.lastActivityMs = 0;
    this.projectDirs = resolveProjectDirs();
  }

  windowStartMs(now = Date.now()) {
    return startOfLocalDay(now) - (this.historyDays - 1) * DAY_MS;
  }

  async refresh() {
    const windowStart = this.windowStartMs();
    this.pruneOutsideWindow(windowStart);
    if (this.projectDirs.length === 0) this.projectDirs = resolveProjectDirs();

    for (const dir of this.projectDirs) {
      const files = await collectJsonlFiles(dir, windowStart);
      for (const file of files) await this.readNewBytes(file, windowStart);
    }
    return this.snapshot();
  }

  async readNewBytes({ path: filePath, size }, windowStart) {
    let cursor = this.fileCursors.get(filePath);
    if (!cursor || size < cursor.offset) {
      cursor = { offset: 0, leftover: Buffer.alloc(0) };
      this.fileCursors.set(filePath, cursor);
    }
    if (size === cursor.offset) return;

    const handle = await fsp.open(filePath, 'r');
    try {
      const length = size - cursor.offset;
      const chunk = Buffer.alloc(length);
      await handle.read(chunk, 0, length, cursor.offset);
      cursor.offset = size;

      const data = Buffer.concat([cursor.leftover, chunk]);
      const lastNewline = data.lastIndexOf(0x0a);
      if (lastNewline === -1) {
        cursor.leftover = data;
        return;
      }
      cursor.leftover = data.subarray(lastNewline + 1);
      const lines = data.subarray(0, lastNewline).toString('utf8').split('\n');
      for (const line of lines) this.ingestLine(line, windowStart);
    } finally {
      await handle.close();
    }
  }

  ingestLine(line, windowStart) {
    if (!line.includes('"usage"')) return;

    let record;
    try {
      record = JSON.parse(line);
    } catch {
      return;
    }

    const message = record.message;
    const usage = message && message.usage;
    if (record.type !== 'assistant' || !usage || !record.timestamp) return;
    if (message.model === '<synthetic>') return;

    const timestampMs = Date.parse(record.timestamp);
    if (Number.isNaN(timestampMs) || timestampMs < windowStart) return;

    // O mesmo pedido pode aparecer em várias linhas (streaming / resumes).
    if (message.id && record.requestId) {
      const dedupeKey = `${message.id}:${record.requestId}`;
      if (this.seenMessages.has(dedupeKey)) return;
      this.seenMessages.set(dedupeKey, localDayKey(timestampMs));
    }

    const dayKey = localDayKey(timestampMs);
    if (!this.days.has(dayKey)) this.days.set(dayKey, createEmptyDay());
    const day = this.days.get(dayKey);

    const input = usage.input_tokens || 0;
    const output = usage.output_tokens || 0;
    const cacheWrite = usage.cache_creation_input_tokens || 0;
    const cacheRead = usage.cache_read_input_tokens || 0;

    day.input += input;
    day.output += output;
    day.cacheWrite += cacheWrite;
    day.cacheRead += cacheRead;
    day.messages += 1;
    if (record.sessionId) day.sessions.add(record.sessionId);

    const model = message.model || 'desconhecido';
    day.models[model] = (day.models[model] || 0) + input + output + cacheWrite + cacheRead;

    if (timestampMs > this.lastActivityMs) this.lastActivityMs = timestampMs;
  }

  pruneOutsideWindow(windowStart) {
    const oldestKeptDay = localDayKey(windowStart);
    for (const key of this.days.keys()) {
      if (key < oldestKeptDay) this.days.delete(key);
    }
    for (const [dedupeKey, dayKey] of this.seenMessages) {
      if (dayKey < oldestKeptDay) this.seenMessages.delete(dedupeKey);
    }
  }

  snapshot(now = Date.now()) {
    const todayKey = localDayKey(now);
    const today = this.days.get(todayKey) || createEmptyDay();

    const history = [];
    for (let i = this.historyDays - 1; i >= 0; i -= 1) {
      const ts = startOfLocalDay(now) - i * DAY_MS;
      const key = localDayKey(ts);
      const day = this.days.get(key);
      history.push({ day: key, weekday: new Date(ts).getDay(), total: day ? totalOf(day) : 0 });
    }

    const topModel = Object.entries(today.models).sort((a, b) => b[1] - a[1])[0];

    return {
      today: {
        total: totalOf(today),
        input: today.input,
        output: today.output,
        cacheWrite: today.cacheWrite,
        cacheRead: today.cacheRead,
        messages: today.messages,
        sessions: today.sessions.size,
        topModel: topModel ? topModel[0] : null,
      },
      history,
      lastActivityMs: this.lastActivityMs,
      sourceFound: this.projectDirs.length > 0,
      generatedAt: now,
    };
  }
}

module.exports = { UsageTracker };
