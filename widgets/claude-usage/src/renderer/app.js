'use strict';

const WEEKDAYS = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];
const $ = (id) => document.getElementById(id);
const card = $('card');

let latest = null;
let displayedPercent = 0;
let previousFiveHour = null;
let lastPlanIncreaseMs = 0;
let bot3d = null;

function initBot3D() {
  // O canvas tem de estar visível antes de criar o renderer, senão arranca com 0×0.
  $('bot-wrap').classList.add('has-3d');
  try {
    bot3d = new window.Bot3DLib.Bot3D($('bot3d'));
  } catch (error) {
    $('bot-wrap').classList.remove('has-3d');
    console.warn(`Bot 3D indisponível, a usar 2D: ${error.message}`);
    bot3d = null;
  }
}

function formatTokens(value) {
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(value >= 1e8 ? 0 : 1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(value >= 1e5 ? 0 : 1)}K`;
  return String(Math.round(value));
}

function formatReset(isoString) {
  if (!isoString) return '';
  const target = new Date(isoString);
  const diffMs = target.getTime() - Date.now();
  if (diffMs <= 0) return 'a repor…';
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 60) return `repõe em ${minutes} min`;
  const time = target.toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' });
  if (diffMs < 24 * 3600 * 1000) return `repõe às ${time}`;
  const day = target.toLocaleDateString('pt-PT', { weekday: 'short' }).replace('.', '');
  return `repõe ${day} ${time}`;
}

function animatePercent(target) {
  const start = displayedPercent;
  const startedAt = performance.now();
  function step(now) {
    const t = Math.min(1, (now - startedAt) / 900);
    displayedPercent = start + (target - start) * (1 - Math.pow(1 - t, 3));
    $('session-pct').textContent = `${Math.round(displayedPercent)}%`;
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

function setBar(fillId, labelId, limit) {
  const fill = $(fillId);
  if (!limit) {
    fill.style.width = '0%';
    $(labelId).textContent = '—';
    fill.dataset.level = '';
    return;
  }
  const pct = limit.utilization;
  fill.style.width = `${Math.min(100, pct)}%`;
  fill.dataset.level = pct >= 100 ? 'over' : pct >= 80 ? 'hot' : '';
  $(labelId).textContent = `${Math.round(pct)}%`;
}

function pickMood(data) {
  const fiveHour = data.plan.usage && data.plan.usage.fiveHour;
  const pct = fiveHour ? fiveHour.utilization : 0;
  if (pct >= 100) return 'mood-over';
  if (pct >= 80) return 'mood-hot';

  const threshold = data.workingThresholdMs;
  const codeActive = data.lastActivityMs && Date.now() - data.lastActivityMs < threshold;
  const planActive = Date.now() - lastPlanIncreaseMs < threshold;
  return codeActive || planActive ? 'mood-working' : 'mood-idle';
}

function trackPlanActivity(plan) {
  const current = plan.usage && plan.usage.fiveHour ? plan.usage.fiveHour.utilization : null;
  if (current !== null && previousFiveHour !== null && current > previousFiveHour) lastPlanIncreaseMs = Date.now();
  if (current !== null) previousFiveHour = current;
}

function renderHistory(history) {
  const max = Math.max(1, ...history.map((d) => d.total));
  $('history').replaceChildren(
    ...history.map((day, index) => {
      const bar = document.createElement('div');
      bar.className = `hbar${index === history.length - 1 ? ' today' : ''}`;
      bar.title = `${day.day}: ${day.total.toLocaleString('pt-PT')} tokens (Claude Code)`;
      const fill = document.createElement('div');
      fill.className = 'hbar-fill';
      fill.style.height = `${Math.max(8, (day.total / max) * 100)}%`;
      const label = document.createElement('span');
      label.className = 'hbar-label';
      label.textContent = WEEKDAYS[day.weekday];
      bar.append(fill, label);
      return bar;
    }),
  );
}

function renderPlan(plan) {
  const signedOut = plan.status === 'signed-out';
  $('signin').hidden = !signedOut;
  $('session-reset').hidden = signedOut;

  const usage = plan.usage;
  const fiveHour = usage && usage.fiveHour;
  const sevenDay = usage && usage.sevenDay;

  if (fiveHour) {
    animatePercent(fiveHour.utilization);
    $('session-reset').textContent = formatReset(fiveHour.resetsAt) || 'sem sessão ativa';
  } else {
    $('session-pct').textContent = '—';
    displayedPercent = 0;
    $('session-reset').textContent = plan.status === 'loading' ? 'a carregar…' : ' ';
  }

  setBar('five-fill', 'five-label', fiveHour);
  setBar('week-fill', 'week-label', sevenDay);
  $('week-reset').textContent = sevenDay ? formatReset(sevenDay.resetsAt) : ' ';

  const notice = $('notice');
  if (plan.status === 'stale' || plan.status === 'error') {
    notice.hidden = false;
    notice.textContent = 'Dados do plano indisponíveis — a tentar novamente';
    notice.title = plan.error || '';
  } else {
    notice.hidden = true;
  }
}

function render(data) {
  latest = data;
  const mood = pickMood(data);
  card.className = `card ${mood}`;
  if (bot3d) bot3d.setMood(mood.replace('mood-', ''));
  const statusText = {
    'mood-idle': 'em pausa',
    'mood-working': 'a trabalhar',
    'mood-hot': 'perto do limite',
    'mood-over': 'limite atingido',
  };
  $('status-text').textContent = statusText[mood];

  renderPlan(data.plan);

  const today = data.today;
  $('code-total').textContent = `${formatTokens(today.total)} tokens`;
  $('code-total').title =
    `Input ${formatTokens(today.input)} · Output ${formatTokens(today.output)} · ` +
    `Cache escrita ${formatTokens(today.cacheWrite)} · Cache leitura ${formatTokens(today.cacheRead)} · ` +
    `${today.sessions} sessões`;
  renderHistory(data.history);
}

window.widget.onUpdate((data) => {
  trackPlanActivity(data.plan);
  render(data);
});

// Mantém "repõe em…" e o humor do bot atualizados entre leituras.
setInterval(() => latest && render(latest), 30_000);

$('signin').addEventListener('click', () => window.widget.signIn());

window.widget.onPointer(({ x, y, inside }) => {
  if (!bot3d) return;
  $('bot-wrap').classList.toggle('awake', inside);
  const rect = $('bot3d').getBoundingClientRect();
  const clamp = (value) => Math.max(-1, Math.min(1, value));
  bot3d.setPointer({
    x: clamp((x - (rect.left + rect.width / 2)) / 170),
    y: clamp((y - (rect.top + rect.height / 2)) / 170),
    active: inside,
  });
});

$('bot-wrap').addEventListener('click', () => bot3d && bot3d.poke());

initBot3D();

window.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  window.widget.openMenu();
});

window.widget.ready();
