'use strict';

const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, screen } = require('electron');
const { fileURLToPath } = require('url');
const fs = require('fs');
const path = require('path');
const desktop = require('@desktop-widgets/desktop-kit');

const { Placement } = desktop;
const { TaskStore } = require('./store');

// Preso ao desktop, o Chromium julgaria a janela tapada e congelaria as animações.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

const WIDGET_SIZE = { width: 340, height: 520 };
const MARGIN = 24;
const RIGHT_COLUMN_WIDTH = 320; // espaço reservado à direita (ex.: outro widget)
const RENDERER_INDEX = path.join(__dirname, 'renderer', 'index.html');
const LOG_PATH = path.join(app.getPath('userData'), 'todo.log');

function log(message) {
  try {
    if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > 512 * 1024) fs.renameSync(LOG_PATH, `${LOG_PATH}.old`);
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${message}\n`);
  } catch {
    /* sem log não é crítico */
  }
}

process.on('uncaughtException', (error) => log(`uncaughtException: ${error.stack || error}`));
process.on('unhandledRejection', (reason) => log(`unhandledRejection: ${reason && reason.stack ? reason.stack : reason}`));
log(`start pid=${process.pid}`);

let win = null;
let tray = null;
let store = null;
let state = {};
let pointerWasInside = false;
let placement = null;
let lastDay = new Date().toDateString();

const statePath = () => path.join(app.getPath('userData'), 'widget-state.json');

function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8'));
  } catch {
    return {};
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
  // Canto superior direito, deixando uma coluna livre à direita para outro widget.
  return {
    x: workArea.x + workArea.width - MARGIN - RIGHT_COLUMN_WIDTH - 8 - size.width,
    y: workArea.y + MARGIN,
  };
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
      spellcheck: true,
      backgroundThrottling: false,
    },
  });

  win.loadFile(RENDERER_INDEX);
  win.once('ready-to-show', () => {
    win.showInactive();
    if (!state.alwaysOnTop) desktop.attachToDesktop(win);
  });
  placement.attach(win);
  win.webContents.on('render-process-gone', (_e, details) => {
    log(`render-process-gone ${JSON.stringify(details)}`);
    if (details.reason !== 'clean-exit' && !win.isDestroyed()) win.reload();
  });
  win.webContents.on('did-finish-load', () => log(`loaded bounds=${JSON.stringify(win.getBounds())}`));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

function trackPointer() {
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  const cursor = screen.getCursorScreenPoint();
  const b = win.getBounds();
  const inside = cursor.x >= b.x - 24 && cursor.x <= b.x + b.width + 24 && cursor.y >= b.y - 24 && cursor.y <= b.y + b.height + 24;
  if (inside || pointerWasInside) win.webContents.send('pointer:move', { x: cursor.x - b.x, y: cursor.y - b.y, inside });
  pointerWasInside = inside;
}

function checkNewDay() {
  if (!win || win.isDestroyed()) return;
  if (!state.alwaysOnTop) desktop.ensureAttached(win);
  updateTrayTooltip();
  const today = new Date().toDateString();
  if (today === lastDay) return;
  lastDay = today;
  store.rollover();
  win.webContents.send('todos:changed', store.tasks);
}

/** Traz o widget para a frente (ex.: clique no ícone) e foca a caixa de texto; volta ao fundo ao perder o foco. */
function summon() {
  if (!win || win.isDestroyed()) return;
  win.show();
  win.moveTop();
  win.focus();
  win.webContents.send('todo:focus-input');
}

function quitByUser() {
  log('quit by user');
  app.quit();
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'tray.ico'));
  tray = new Tray(icon);
  tray.setToolTip('Tarefas');
  tray.on('click', summon);
  tray.on('right-click', () => tray.popUpContextMenu(buildContextMenu(true)));
  updateTrayTooltip();
}

function updateTrayTooltip() {
  if (!tray || !store) return;
  const pending = store.tasks.filter((task) => !task.done).length;
  tray.setToolTip(pending ? `Tarefas — ${pending} por fazer` : 'Tarefas — tudo feito');
}

function buildContextMenu(fromTray = false) {
  return Menu.buildFromTemplate([
    ...(fromTray ? [{ label: 'Nova tarefa…', click: summon }, { type: 'separator' }] : []),
    {
      label: 'Limpar concluídas',
      click: () => {
        store.save(store.tasks.filter((task) => !task.done));
        win.webContents.send('todos:changed', store.tasks);
        updateTrayTooltip();
      },
    },
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
    { type: 'separator' },
    { label: 'Fechar widget', click: quitByUser },
  ]);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => win && win.showInactive());

  app.whenReady().then(() => {
    state = readState();
    store = new TaskStore(app.getPath('userData'));
    store.load();
    placement = new Placement({ state, saveState, size: WIDGET_SIZE, defaultPosition });
    Menu.setApplicationMenu(null);

    ipcMain.handle('todos:load', (event) => (isTrustedSender(event) ? store.tasks : []));
    ipcMain.handle('todos:save', (event, tasks) => {
      if (!isTrustedSender(event)) return store.tasks;
      const saved = store.save(tasks);
      updateTrayTooltip();
      return saved;
    });
    ipcMain.on('widget:context-menu', (event) => {
      if (isTrustedSender(event)) buildContextMenu().popup({ window: win });
    });

    createWindow();
    createTray();
    setInterval(trackPointer, 33);
    setInterval(checkNewDay, 60_000);
  });

  app.on('child-process-gone', (_e, details) => log(`child-process-gone ${JSON.stringify(details)}`));
  app.on('window-all-closed', () => app.quit());
  app.on('quit', (_e, code) => log(`quit code=${code}`));
}
