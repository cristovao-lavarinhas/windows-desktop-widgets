'use strict';

/**
 * Prende uma BrowserWindow ao ambiente de trabalho do Windows (como os widgets do Rainmeter):
 * - a janela passa a ter o Progman (o "desktop") como owner, por isso não é escondida pelo Win+D;
 * - é mantida no fundo da ordem Z, por baixo de todas as outras janelas.
 */

const GWLP_HWNDPARENT = -8;
const HWND_BOTTOM = 1;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOACTIVATE = 0x0010;
const SMTO_NORMAL = 0x0000;
const WM_SPAWN_WORKER = 0x052c;

let user32 = null;

function loadUser32() {
  if (user32) return user32;
  const koffi = require('koffi');
  const lib = koffi.load('user32.dll');
  user32 = {
    FindWindowW: lib.func('intptr __stdcall FindWindowW(str16 lpClassName, str16 lpWindowName)'),
    SetWindowLongPtrW: lib.func('intptr __stdcall SetWindowLongPtrW(intptr hWnd, int nIndex, intptr dwNewLong)'),
    SetWindowPos: lib.func('bool __stdcall SetWindowPos(intptr hWnd, intptr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags)'),
    SendMessageTimeoutW: lib.func('intptr __stdcall SendMessageTimeoutW(intptr hWnd, uint Msg, uintptr wParam, intptr lParam, uint fuFlags, uint uTimeout, _Out_ uintptr *lpdwResult)'),
  };
  return user32;
}

function hwndOf(win) {
  const handle = win.getNativeWindowHandle();
  return handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0));
}

function sendToBottom(win) {
  if (process.platform !== 'win32' || win.isDestroyed()) return;
  const api = loadUser32();
  api.SetWindowPos(hwndOf(win), HWND_BOTTOM, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
}

let attachedProgman = null;

function attachToDesktop(win) {
  if (process.platform !== 'win32' || win.isDestroyed()) return false;
  try {
    const api = loadUser32();
    const progman = api.FindWindowW('Progman', null);
    if (!progman) return false;

    // Garante que o Explorer criou a camada WorkerW (necessário em algumas builds do Windows).
    api.SendMessageTimeoutW(progman, WM_SPAWN_WORKER, 0, 0, SMTO_NORMAL, 1000, [0]);
    api.SetWindowLongPtrW(hwndOf(win), GWLP_HWNDPARENT, progman);
    sendToBottom(win);

    if (attachedProgman === null) {
      // Se o utilizador clicar no widget, ele volta ao fundo assim que perde o foco.
      win.on('blur', () => sendToBottom(win));
      win.on('show', () => sendToBottom(win));
    }
    attachedProgman = progman;
    return true;
  } catch (error) {
    console.error('[desktop-embed] falhou:', error);
    return false;
  }
}

/** Volta a prender a janela se o Explorer tiver sido reiniciado (o Progman muda de handle). */
function ensureAttached(win) {
  if (process.platform !== 'win32' || attachedProgman === null) return;
  try {
    const current = loadUser32().FindWindowW('Progman', null);
    if (current && current !== attachedProgman) attachToDesktop(win);
  } catch {
    /* tentamos novamente no próximo ciclo */
  }
}

function detachFromDesktop(win) {
  if (process.platform !== 'win32' || win.isDestroyed()) return;
  loadUser32().SetWindowLongPtrW(hwndOf(win), GWLP_HWNDPARENT, 0);
}

module.exports = { attachToDesktop, ensureAttached, detachFromDesktop, sendToBottom };
