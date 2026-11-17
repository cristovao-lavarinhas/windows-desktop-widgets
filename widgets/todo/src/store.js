'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Persistência das tarefas num JSON local, com validação de tudo o que vem do renderer
 * e escrita atómica (ficheiro temporário + rename) para não corromper dados num crash.
 */

const MAX_TASKS = 300;
const MAX_TEXT_LENGTH = 200;
const ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

function startOfToday(now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function sanitizeTask(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || !ID_PATTERN.test(raw.id)) return null;
  if (typeof raw.text !== 'string') return null;
  const text = raw.text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_TEXT_LENGTH);
  if (!text) return null;

  const createdAt = Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now();
  const done = raw.done === true;
  return {
    id: raw.id,
    text,
    done,
    important: raw.important === true,
    createdAt,
    doneAt: done && Number.isFinite(raw.doneAt) ? raw.doneAt : done ? Date.now() : null,
    order: Number.isFinite(raw.order) ? raw.order : 0,
  };
}

function sanitizeTasks(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const result = [];
  for (const item of list.slice(0, MAX_TASKS)) {
    const task = sanitizeTask(item);
    if (task && !seen.has(task.id)) {
      seen.add(task.id);
      result.push(task);
    }
  }
  return result;
}

class TaskStore {
  constructor(directory) {
    this.filePath = path.join(directory, 'todos.json');
    this.tasks = [];
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      this.tasks = sanitizeTasks(data.tasks);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        // Ficheiro corrompido: guarda uma cópia para recuperação manual em vez de o apagar.
        try { fs.copyFileSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`); } catch { /* ignora */ }
      }
      this.tasks = [];
    }
    this.rollover();
    return this.tasks;
  }

  save(list) {
    this.tasks = sanitizeTasks(list);
    const temporaryPath = `${this.filePath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify({ version: 1, tasks: this.tasks }, null, 2));
    fs.renameSync(temporaryPath, this.filePath);
    return this.tasks;
  }

  /** Novo dia: as tarefas concluídas em dias anteriores saem; as pendentes passam para hoje. */
  rollover(now = Date.now()) {
    const today = startOfToday(now);
    const kept = this.tasks.filter((task) => !(task.done && task.doneAt < today));
    if (kept.length !== this.tasks.length) {
      this.save(kept);
      return true;
    }
    return false;
  }
}

module.exports = { TaskStore };
