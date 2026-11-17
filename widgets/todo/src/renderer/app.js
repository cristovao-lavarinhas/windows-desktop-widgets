'use strict';

const $ = (id) => document.getElementById(id);
const DAY_MS = 24 * 60 * 60 * 1000;
const RING_LENGTH = 2 * Math.PI * 18;
const SPARK_COLORS = ['#d97757', '#6fcf97', '#7ee0ff', '#f2b84b', '#e8a07f'];

let tasks = [];
let showDone = false;
let lastDeleted = null;
let toastTimer = null;
let saveTimer = null;
let bot = null;
let dragId = null;

/* ---------------- Utilitários ---------------- */

function newId() {
  return (crypto.randomUUID && crypto.randomUUID()) || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function carriedLabel(task) {
  const days = Math.round((startOfToday() - new Date(task.createdAt).setHours(0, 0, 0, 0)) / DAY_MS);
  if (task.done || days <= 0) return '';
  return days === 1 ? 'de ontem' : `há ${days} dias`;
}

function pendingTasks() {
  return tasks.filter((t) => !t.done).sort((a, b) => a.order - b.order);
}

function doneTasks() {
  return tasks.filter((t) => t.done).sort((a, b) => b.doneAt - a.doneAt);
}

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => window.todoApi.save(tasks), 250);
}

const ICONS = {
  check: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="8.5"/><path class="tick" d="M6.2 10.4l2.6 2.6 5-5.4"/></svg>',
  star: '<svg viewBox="0 0 20 20"><path d="M10 2.8l2.2 4.6 5 .6-3.7 3.4 1 5-4.5-2.5-4.5 2.5 1-5L2.8 8l5-.6z"/></svg>',
  trash: '<svg viewBox="0 0 20 20"><path d="M5 6h10M8 6V4.5h4V6M6.5 6l.7 9.5h5.6l.7-9.5"/></svg>',
};

/* ---------------- Render (reconciliação por id para não reiniciar animações) ---------------- */

function createTaskElement(task) {
  const li = document.createElement('li');
  li.className = 'task';
  li.dataset.id = task.id;

  const check = document.createElement('button');
  check.className = 'check';
  check.setAttribute('aria-label', 'Concluir tarefa');
  check.innerHTML = ICONS.check;
  check.addEventListener('click', (event) => toggleDone(task.id, event.currentTarget));

  const text = document.createElement('span');
  text.className = 'text';
  text.addEventListener('dblclick', () => startEditing(task.id, text));

  const tag = document.createElement('span');
  tag.className = 'tag';

  const star = document.createElement('button');
  star.className = 'icon-btn star';
  star.title = 'Importante';
  star.innerHTML = ICONS.star;
  star.addEventListener('click', () => toggleImportant(task.id));

  const del = document.createElement('button');
  del.className = 'icon-btn del';
  del.title = 'Apagar';
  del.innerHTML = ICONS.trash;
  del.addEventListener('click', () => deleteTask(task.id));

  li.append(check, text, tag, star, del);
  setupDrag(li);
  return li;
}

function updateTaskElement(li, task) {
  li.classList.toggle('done', task.done);
  li.classList.toggle('important', task.important);
  li.draggable = !task.done;
  const text = li.querySelector('.text');
  if (text.getAttribute('contenteditable') !== 'true') text.textContent = task.text;
  const label = carriedLabel(task);
  const tag = li.querySelector('.tag');
  tag.textContent = label;
  tag.hidden = !label;
  li.querySelector('.star').classList.toggle('on', task.important);
}

function reconcile(listElement, list) {
  const existing = new Map([...listElement.children].map((el) => [el.dataset.id, el]));
  list.forEach((task, index) => {
    let li = existing.get(task.id);
    if (li) existing.delete(task.id);
    else li = createTaskElement(task);
    updateTaskElement(li, task);
    if (listElement.children[index] !== li) listElement.insertBefore(li, listElement.children[index] || null);
  });
  for (const stale of existing.values()) stale.remove();
}

function render() {
  const pending = pendingTasks();
  const done = doneTasks();
  reconcile($('pending'), pending);
  reconcile($('done'), done);

  const total = pending.length + done.length;
  const empty = pending.length === 0;
  $('empty').hidden = !empty;
  if (empty) {
    $('empty-title').textContent = total ? 'Tudo feito! 🎉' : 'Dia livre';
    $('empty-sub').textContent = total ? 'Bom trabalho. Aproveita o resto do dia.' : 'Adiciona a primeira tarefa acima.';
  }

  $('done-toggle').hidden = done.length === 0;
  $('done-label').textContent = `Concluídas (${done.length})`;
  $('done-toggle').classList.toggle('open', showDone);
  $('done').hidden = !showDone || done.length === 0;

  const ratio = total ? done.length / total : 0;
  $('ring-fill').style.strokeDashoffset = String(RING_LENGTH * (1 - ratio));
  $('ring-text').textContent = `${done.length}/${total}`;
  $('ring').classList.toggle('complete', total > 0 && empty);

  if (bot) bot.setMood(total === 0 ? 'idle' : 'calm');
}

/* ---------------- Ações ---------------- */

function addTask(rawText) {
  let text = rawText.trim();
  if (!text) {
    $('add-form').classList.remove('shake');
    void $('add-form').offsetWidth;
    $('add-form').classList.add('shake');
    return;
  }
  const important = text.startsWith('!');
  if (important) text = text.replace(/^!+\s*/, '');
  if (!text) return;

  const minOrder = Math.min(0, ...pendingTasks().map((t) => t.order));
  tasks.push({ id: newId(), text, done: false, important, createdAt: Date.now(), doneAt: null, order: minOrder - 1 });
  render();
  persist();
}

function burst(origin) {
  const rect = origin.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  for (let i = 0; i < 14; i += 1) {
    const spark = document.createElement('span');
    spark.className = 'spark';
    const angle = (Math.PI * 2 * i) / 14 + Math.random() * 0.4;
    const distance = 22 + Math.random() * 26;
    spark.style.left = `${cx - 3}px`;
    spark.style.top = `${cy - 3}px`;
    spark.style.background = SPARK_COLORS[i % SPARK_COLORS.length];
    spark.style.setProperty('--dx', `${Math.cos(angle) * distance}px`);
    spark.style.setProperty('--dy', `${Math.sin(angle) * distance}px`);
    spark.style.setProperty('--rot', `${Math.random() * 360}deg`);
    document.body.appendChild(spark);
    spark.addEventListener('animationend', () => spark.remove());
  }
}

function toggleDone(id, button) {
  const task = tasks.find((t) => t.id === id);
  if (!task) return;
  const li = button.closest('.task');

  if (!task.done) {
    task.done = true;
    task.doneAt = Date.now();
    li.classList.add('done');
    burst(button);
    if (bot) bot.poke();
    // Deixa ver o visto e o risco antes de a tarefa sair da lista.
    setTimeout(() => li.classList.add('leaving'), 550);
    setTimeout(render, 1000);
  } else {
    task.done = false;
    task.doneAt = null;
    task.order = Math.max(0, ...pendingTasks().map((t) => t.order)) + 1;
    render();
  }
  persist();
}

function toggleImportant(id) {
  const task = tasks.find((t) => t.id === id);
  if (!task) return;
  task.important = !task.important;
  render();
  persist();
}

function deleteTask(id) {
  const index = tasks.findIndex((t) => t.id === id);
  if (index === -1) return;
  const li = document.querySelector(`.task[data-id="${CSS.escape(id)}"]`);
  lastDeleted = tasks[index];
  tasks.splice(index, 1);
  persist();
  showToast('Tarefa apagada');
  if (li) {
    li.classList.add('leaving');
    setTimeout(render, 420);
  } else {
    render();
  }
}

function undoDelete() {
  if (!lastDeleted) return;
  tasks.push(lastDeleted);
  lastDeleted = null;
  hideToast();
  render();
  persist();
}

function showToast(message) {
  $('toast-text').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 5000);
}

function hideToast() {
  $('toast').hidden = true;
  lastDeleted = null;
}

function startEditing(id, element) {
  const task = tasks.find((t) => t.id === id);
  if (!task || task.done) return;
  const original = task.text;
  element.setAttribute('contenteditable', 'true');
  element.focus();
  document.getSelection().selectAllChildren(element);

  const finish = (commit) => {
    element.removeAttribute('contenteditable');
    element.removeEventListener('keydown', onKey);
    element.removeEventListener('blur', onBlur);
    const value = element.textContent.trim().slice(0, 200);
    if (!commit) {
      element.textContent = original;
    } else if (!value) {
      deleteTask(id);
      return;
    } else if (value !== original) {
      task.text = value;
      persist();
    }
    render();
  };
  const onKey = (event) => {
    if (event.key === 'Enter') { event.preventDefault(); finish(true); }
    if (event.key === 'Escape') { event.preventDefault(); finish(false); }
  };
  const onBlur = () => finish(true);
  element.addEventListener('keydown', onKey);
  element.addEventListener('blur', onBlur);
}

/* ---------------- Arrastar para reordenar ---------------- */

function clearDropMarkers() {
  document.querySelectorAll('.drop-before, .drop-after').forEach((el) => el.classList.remove('drop-before', 'drop-after'));
}

function setupDrag(li) {
  li.addEventListener('dragstart', (event) => {
    dragId = li.dataset.id;
    li.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
  });
  li.addEventListener('dragend', () => {
    li.classList.remove('dragging');
    clearDropMarkers();
    dragId = null;
  });
  li.addEventListener('dragover', (event) => {
    if (!dragId || dragId === li.dataset.id || li.classList.contains('done')) return;
    event.preventDefault();
    const rect = li.getBoundingClientRect();
    const before = event.clientY < rect.top + rect.height / 2;
    clearDropMarkers();
    li.classList.add(before ? 'drop-before' : 'drop-after');
  });
  li.addEventListener('drop', (event) => {
    event.preventDefault();
    if (!dragId || dragId === li.dataset.id) return;
    const before = li.classList.contains('drop-before');
    clearDropMarkers();
    const ordered = pendingTasks().filter((t) => t.id !== dragId);
    const moved = tasks.find((t) => t.id === dragId);
    const targetIndex = ordered.findIndex((t) => t.id === li.dataset.id);
    ordered.splice(before ? targetIndex : targetIndex + 1, 0, moved);
    ordered.forEach((task, index) => { task.order = index; });
    render();
    persist();
  });
}

/* ---------------- Bot 3D (mascote) ---------------- */

function initBot() {
  try {
    bot = new window.Bot3DLib.Bot3D($('bot3d'));
  } catch (error) {
    console.warn(`Bot 3D indisponível: ${error.message}`);
    $('bot-wrap').hidden = true;
  }
}

window.todoApi.onPointer(({ x, y, inside }) => {
  if (!bot) return;
  const rect = $('bot3d').getBoundingClientRect();
  const clamp = (value) => Math.max(-1, Math.min(1, value));
  bot.setPointer({
    x: clamp((x - (rect.left + rect.width / 2)) / 200),
    y: clamp((y - (rect.top + rect.height / 2)) / 200),
    active: inside,
  });
});

/* ---------------- Ligações ---------------- */

$('add-form').addEventListener('submit', (event) => {
  event.preventDefault();
  addTask($('add-input').value);
  $('add-input').value = '';
});
$('done-toggle').addEventListener('click', () => {
  showDone = !showDone;
  render();
});
$('toast-undo').addEventListener('click', undoDelete);
$('bot-wrap').addEventListener('click', () => bot && bot.poke());

document.addEventListener('keydown', (event) => {
  if (event.ctrlKey && event.key.toLowerCase() === 'n') {
    event.preventDefault();
    $('add-input').focus();
  }
  if (event.ctrlKey && event.key.toLowerCase() === 'z' && lastDeleted && document.activeElement === document.body) {
    undoDelete();
  }
});

window.addEventListener('contextmenu', (event) => {
  if (event.target.closest('input, [contenteditable="true"]')) return;
  event.preventDefault();
  window.todoApi.openMenu();
});

window.todoApi.onFocusInput(() => {
  $('add-input').focus();
  if (bot) bot.poke();
});

window.todoApi.onChanged((fresh) => {
  tasks = fresh;
  render();
});

function updateDate() {
  const label = new Date().toLocaleDateString('pt-PT', { weekday: 'long', day: 'numeric', month: 'long' });
  $('date').textContent = label.charAt(0).toUpperCase() + label.slice(1);
}

async function init() {
  updateDate();
  setInterval(updateDate, 60_000);
  initBot();
  tasks = await window.todoApi.load();
  render();
}

init();
