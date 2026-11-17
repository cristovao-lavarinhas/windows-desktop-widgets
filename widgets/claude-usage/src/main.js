'use strict';

const { app, BrowserWindow, ipcMain, Menu, screen, shell } = require('electron');
const fs = require('fs');
const { fileURLToPath } = require('url');
const path = require('path');
const { UsageTracker } = require('./usage');
const { ClaudeAiUsage, AuthRequiredError } = require('./claude-ai');
const desktop = require('@desktop-widgets/desktop-kit');

const { Placement } = desktop;

const WIDGET_SIZE = { width: 320, height: 420 };
const MARGIN = 24;
const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const RENDERER_INDEX = path.join(__dirname, 'renderer', 'index.html');

const DEFAULT_CONFIG = {
  refreshSeconds: 10,
  planRefreshSeconds: 60,
  historyDays: 7,
  workingThresholdSeconds: 120,
};

function readJson(filePath, fallback) {
  try {
    return { ...fallback, ...JSON.parse(fs.readFileSync(filePath, 'utf8')) };
  } catch {
    return { ...fallback };
  }
}

const config = readJson(CONFIG_PATH, DEFAULT_CONFIG);

// A janela vive no fundo do desktop (owner = Progman): a deteção de oclusão do Chromium
// considera-a tapada e congela o requestAnimationFrame, por isso é desligada.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-background-timer-throttling');
const statePath = () => path.join(app.getPath('userData'), 'widget-state.json');
let state = {};
let win = null;
let localTimer = null;
let planTimer = null;
let claudeAi = null;
let placement = null;
let pointerTimer = null;
let pointerWasInside = false;
const tracker = new UsageTracker({ historyDays: config.historyDays });

// Último estado conhecido de cada fonte; o renderer recebe sempre o conjunto.
let localSnapshot = null;
let plan = { status: 'loading', usage: null, error: null };

function log(message) {
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'widget.log'), `${new Date().toISOString()} ${message}\n`);
  } catch {
    /* sem log não é crítico */
  }
}

function saveState() {
  try {
    fs.writeFileSync(statePath(), JSON.stringify(state, null, 2));
  } catch {
    /* não crítico */
  }
}

function defaultPosition(workArea, size) {
  // Canto superior direito.
  return { x: workArea.x + workArea.width - size.width - MARGIN, y: workArea.y + MARGIN };
}

function sendToRenderer() {
  if (!win || win.isDestroyed() || !localSnapshot) return;
  win.webContents.send('usage:update', {
    ...localSnapshot,
    plan,
    workingThresholdMs: config.workingThresholdSeconds * 1000,
  });
}

async function refreshLocal() {
  if (!win || win.isDestroyed()) return;
  if (!state.alwaysOnTop) desktop.ensureAttached(win);
  try {
    localSnapshot = await tracker.refresh();
    sendToRenderer();
  } catch (error) {
    log(`local: ${error.message}`);
  }
}

async function refreshPlan() {
  try {
    const usage = await claudeAi.getUsage();
    plan = { status: 'ok', usage, error: null };
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      plan = { status: 'signed-out', usage: null, error: null };
    } else {
      // Mantém os últimos números válidos e sinaliza que estão desatualizados.
      plan = { status: plan.usage ? 'stale' : 'error', usage: plan.usage, error: error.message };
      log(`plan: ${error.message}`);
    }
  }
  sendToRenderer();
}

/**
 * A zona de arrastar do widget não recebe eventos de rato no renderer,
 * por isso a posição do cursor é lida aqui (~30 Hz) e só é enviada quando está sobre o widget.
 */
function trackPointer() {
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  const cursor = screen.getCursorScreenPoint();
  const bounds = win.getBounds();
  const margin = 24;
  const inside =
    cursor.x >= bounds.x - margin && cursor.x <= bounds.x + bounds.width + margin &&
    cursor.y >= bounds.y - margin && cursor.y <= bounds.y + bounds.height + margin;
  if (inside || pointerWasInside) {
    win.webContents.send('pointer:move', { x: cursor.x - bounds.x, y: cursor.y - bounds.y, inside });
  }
  pointerWasInside = inside;
}

async function signIn() {
  const signedIn = await claudeAi.openLogin();
  if (signedIn) await refreshPlan();
}

async function signOut() {
  await claudeAi.signOut();
  plan = { status: 'signed-out', usage: null, error: null };
  sendToRenderer();
}

function createWindow() {
  win = new BrowserWindow({
    ...WIDGET_SIZE,
    ...placement.current(),
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: Boolean(state.alwaysOnTop),
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  win.loadFile(RENDERER_INDEX);
  win.once('ready-to-show', () => {
    win.showInactive();
    if (!state.alwaysOnTop) desktop.attachToDesktop(win);
  });

  placement.attach(win);

  win.webContents.on('console-message', (event) => {
    if (event.level === 'warning' || event.level === 'error') {
      log(`renderer[${event.level}]: ${event.message} (${event.sourceId}:${event.lineNumber})`);
    }
  });
  win.webContents.on('render-process-gone', (_e, details) => log(`render-process-gone ${JSON.stringify(details)}`));


  // O widget nunca navega nem abre janelas.
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

/** Só aceita IPC vindo da página do próprio widget. */
function isTrustedSender(event) {
  try {
    const url = event.senderFrame && event.senderFrame.url;
    return path.resolve(fileURLToPath(url)).toLowerCase() === path.resolve(RENDERER_INDEX).toLowerCase();
  } catch {
    return false;
  }
}

function buildContextMenu() {
  const signedIn = plan.status !== 'signed-out';
  return Menu.buildFromTemplate([
    { label: 'Atualizar agora', click: () => { refreshLocal(); refreshPlan(); } },
    { type: 'separator' },
    signedIn
      ? { label: 'Terminar sessão do claude.ai', click: signOut }
      : { label: 'Iniciar sessão no claude.ai…', click: signIn },
    { label: 'Abrir uso no claude.ai', click: () => shell.openExternal('https://claude.ai/settings/usage') },
    { type: 'separator' },
    {
      label: 'Sempre por cima',
      type: 'checkbox',
      checked: Boolean(state.alwaysOnTop),
      click: (item) => {
        state.alwaysOnTop = item.checked;
        if (item.checked) {
          desktop.detachFromDesktop(win);
          win.setAlwaysOnTop(true);
        } else {
          win.setAlwaysOnTop(false);
          desktop.attachToDesktop(win);
        }
        saveState();
      },
    },
    {
      label: 'Repor posição',
      click: () => placement.reset(),
    },
    { label: 'Editar configuração…', click: () => shell.openPath(CONFIG_PATH) },
    { type: 'separator' },
    { label: 'Fechar widget', click: () => app.quit() },
  ]);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => win && win.showInactive());

  app.whenReady().then(() => {
    state = readJson(statePath(), {});
    Menu.setApplicationMenu(null);
    claudeAi = new ClaudeAiUsage({ log });
    placement = new Placement({ state, saveState, size: WIDGET_SIZE, defaultPosition });
    createWindow();

    ipcMain.on('widget:ready', (event) => {
      if (!isTrustedSender(event)) return;
      refreshLocal();
      refreshPlan();
    });
    ipcMain.on('widget:context-menu', (event) => {
      if (isTrustedSender(event)) buildContextMenu().popup({ window: win });
    });
    ipcMain.on('widget:sign-in', (event) => {
      if (isTrustedSender(event)) signIn();
    });

    localTimer = setInterval(refreshLocal, Math.max(3, config.refreshSeconds) * 1000);
    planTimer = setInterval(refreshPlan, Math.max(30, config.planRefreshSeconds) * 1000);
    pointerTimer = setInterval(trackPointer, 33);
  });

  // A janela de login pode fechar sem fechar a app; só sai quando o widget fecha.
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    clearInterval(localTimer);
    clearInterval(planTimer);
    clearInterval(pointerTimer);
  });
}
