'use strict';

const { BrowserWindow, session } = require('electron');

/**
 * Lê os limites de uso do plano (janela de 5 h e semanal) a partir do claude.ai,
 * usando uma sessão Chromium própria do widget (cookies encriptados pelo Electron/DPAPI).
 * Os endpoints usados são internos do claude.ai e não documentados: tudo é validado de forma defensiva.
 */

const ORIGIN = 'https://claude.ai';
const PARTITION = 'persist:claudeai';
const LIMIT_KEYS = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'];

class AuthRequiredError extends Error {}

function chromeLikeUserAgent(userAgent) {
  // O UA por omissão inclui "Electron/x" e o nome da app, o que pode ativar proteções anti-bot.
  return userAgent.replace(/\s(?:Electron|claude-token-widget)\/\S+/g, '');
}

function toPercent(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, value);
}

function normalizeLimit(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const utilization = toPercent(raw.utilization);
  if (utilization === null) return null;
  const resetsAt = typeof raw.resets_at === 'string' && !Number.isNaN(Date.parse(raw.resets_at)) ? raw.resets_at : null;
  return { utilization, resetsAt };
}

class ClaudeAiUsage {
  constructor({ log = () => {} } = {}) {
    this.log = log;
    this.ses = session.fromPartition(PARTITION);
    this.ses.setUserAgent(chromeLikeUserAgent(this.ses.getUserAgent()));
    this.ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    this.organizationId = null;
    this.loginWindow = null;
  }

  async hasSession() {
    const cookies = await this.ses.cookies.get({ url: ORIGIN, name: 'sessionKey' });
    return cookies.length > 0;
  }

  async signOut() {
    await this.ses.clearStorageData();
    this.organizationId = null;
  }

  /** Abre o login do claude.ai e resolve quando o cookie de sessão aparece (ou a janela fecha). */
  openLogin() {
    if (this.loginWindow && !this.loginWindow.isDestroyed()) {
      this.loginWindow.focus();
      return this.loginPromise;
    }

    this.loginWindow = new BrowserWindow({
      width: 480,
      height: 760,
      title: 'Iniciar sessão no claude.ai — Claude Tokens',
      autoHideMenuBar: true,
      webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });

    // Popups (ex.: login Google) abrem na mesma sessão isolada.
    this.loginWindow.webContents.setWindowOpenHandler(() => ({
      action: 'allow',
      overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: { partition: PARTITION, sandbox: true } },
    }));
    this.loginWindow.loadURL(`${ORIGIN}/login`);

    this.loginPromise = new Promise((resolve) => {
      const timer = setInterval(async () => {
        if (!this.loginWindow || this.loginWindow.isDestroyed()) return;
        if (await this.hasSession()) {
          clearInterval(timer);
          this.log('claude.ai: sessão iniciada');
          this.loginWindow.close();
          resolve(true);
        }
      }, 1000);
      this.loginWindow.on('closed', () => {
        clearInterval(timer);
        this.loginWindow = null;
        this.hasSession().then(resolve);
      });
    });
    return this.loginPromise;
  }

  async fetchJson(pathname) {
    const response = await this.ses.fetch(`${ORIGIN}${pathname}`, {
      headers: { accept: 'application/json', 'content-type': 'application/json' },
    });
    if (response.status === 401 || response.status === 403) {
      throw new AuthRequiredError(`HTTP ${response.status} em ${pathname}`);
    }
    if (!response.ok) throw new Error(`HTTP ${response.status} em ${pathname}`);
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('json')) throw new Error(`Resposta não-JSON em ${pathname} (${contentType})`);
    return response.json();
  }

  async resolveOrganizationId() {
    if (this.organizationId) return this.organizationId;
    const organizations = await this.fetchJson('/api/organizations');
    if (!Array.isArray(organizations) || organizations.length === 0) throw new Error('Sem organizações na conta');

    const withChat = organizations.find((org) => Array.isArray(org.capabilities) && org.capabilities.includes('chat'));
    const chosen = withChat || organizations[0];
    if (typeof chosen.uuid !== 'string') throw new Error('Organização sem uuid');
    this.organizationId = chosen.uuid;
    return this.organizationId;
  }

  /** Devolve { fiveHour, sevenDay, sevenDayOpus, sevenDaySonnet } ou lança AuthRequiredError. */
  async getUsage() {
    if (!(await this.hasSession())) throw new AuthRequiredError('Sem sessão');
    const organizationId = await this.resolveOrganizationId();
    const raw = await this.fetchJson(`/api/organizations/${encodeURIComponent(organizationId)}/usage`);

    const limits = {};
    for (const key of LIMIT_KEYS) limits[key] = normalizeLimit(raw && raw[key]);
    if (!limits.five_hour && !limits.seven_day) {
      this.log(`claude.ai: formato inesperado, chaves=${Object.keys(raw || {}).join(',')}`);
      throw new Error('Formato de uso desconhecido');
    }

    return {
      fiveHour: limits.five_hour,
      sevenDay: limits.seven_day,
      sevenDayOpus: limits.seven_day_opus,
      sevenDaySonnet: limits.seven_day_sonnet,
      fetchedAt: Date.now(),
    };
  }
}

module.exports = { ClaudeAiUsage, AuthRequiredError };
