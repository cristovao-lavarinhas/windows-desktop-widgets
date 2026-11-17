'use strict';

const { screen } = require('electron');

/**
 * Posição do widget por configuração de monitores.
 * Cada combinação de ecrãs (ex.: só portátil / portátil + monitor) guarda a sua própria posição;
 * quando um monitor é ligado/desligado, o widget vai para a posição dessa combinação
 * ou, se não houver, para a posição por omissão.
 */

const SETTLE_MS = 900; // o Windows reposiciona janelas durante a mudança de ecrãs; esperamos que acalme

function displayLayoutKey() {
  return screen
    .getAllDisplays()
    .map((d) => `${d.bounds.x},${d.bounds.y},${d.bounds.width}x${d.bounds.height}@${d.scaleFactor}`)
    .sort()
    .join('|');
}

function fitsOnSomeDisplay(position, size) {
  return (
    position &&
    Number.isFinite(position.x) &&
    Number.isFinite(position.y) &&
    screen.getAllDisplays().some(({ workArea: a }) =>
      position.x >= a.x && position.y >= a.y &&
      position.x + size.width <= a.x + a.width &&
      position.y + size.height <= a.y + a.height)
  );
}

class Placement {
  /**
   * @param {object} options
   * @param {object} options.state       objeto de estado persistido (é alterado aqui)
   * @param {Function} options.saveState grava o estado
   * @param {{width:number,height:number}} options.size
   * @param {Function} options.defaultPosition (workArea, size) => {x, y}
   */
  constructor({ state, saveState, size, defaultPosition }) {
    this.state = state;
    this.saveState = saveState;
    this.size = size;
    this.defaultPosition = defaultPosition;
    this.win = null;
    this.suppressMovedUntil = 0;
    this.settleTimer = null;

    if (!this.state.positions || typeof this.state.positions !== 'object') this.state.positions = {};
    // A posição única das versões anteriores não sabe a que ecrãs pertencia: é descartada.
    if (this.state.position) {
      delete this.state.position;
      this.saveState();
    }
  }

  fallback() {
    return this.defaultPosition(screen.getPrimaryDisplay().workArea, this.size);
  }

  current() {
    const saved = this.state.positions[displayLayoutKey()];
    return fitsOnSomeDisplay(saved, this.size) ? saved : this.fallback();
  }

  attach(win) {
    this.win = win;
    win.on('moved', () => {
      if (Date.now() < this.suppressMovedUntil) return;
      const [x, y] = win.getPosition();
      this.state.positions[displayLayoutKey()] = { x, y };
      this.saveState();
    });

    const onDisplaysChanged = () => {
      // Ignora os movimentos que o próprio Windows faz durante a transição.
      this.suppressMovedUntil = Date.now() + SETTLE_MS + 1500;
      clearTimeout(this.settleTimer);
      this.settleTimer = setTimeout(() => this.apply(), SETTLE_MS);
    };
    screen.on('display-added', onDisplaysChanged);
    screen.on('display-removed', onDisplaysChanged);
    screen.on('display-metrics-changed', onDisplaysChanged);
  }

  apply() {
    if (!this.win || this.win.isDestroyed()) return;
    const { x, y } = this.current();
    this.suppressMovedUntil = Date.now() + 1500;
    this.win.setBounds({ x, y, ...this.size });
  }

  reset() {
    delete this.state.positions[displayLayoutKey()];
    this.saveState();
    this.apply();
  }
}

module.exports = { Placement };
