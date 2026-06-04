import Phaser from 'phaser';
import { GRID } from '../config.js';
import { loadSkins, hexToInt } from '../data/skins.js';

// BootScene draws ALL textures procedurally to canvas (no binary assets): lane backdrops
// (bank/road/water), vehicles, logs/reeds, alcoves, and a per-skin hopper sprite. Then it
// hands off to the menu.
//
// Texture keys:
//   tile_bank / tile_road / tile_water / tile_goal   lane backdrops
//   vehicle                                          a road obstacle
//   log                                              a river ride span
//   alcove_empty / alcove_full                       far-bank slots
//   hopper_<itemId>_round / _diamond                 luminous player marker per skin
export default class BootScene extends Phaser.Scene {
  constructor() {
    super('Boot');
  }

  async create() {
    const t = GRID.tile;

    // Lane backdrops — dark-field motif, each lane kind a distinct hue.
    this.makeTile('tile_bank', t, 0x0a2818, 0x12482a);
    this.makeTile('tile_road', t, 0x0c0c14, 0x1a1a2a);
    this.makeTile('tile_water', t, 0x06122a, 0x0c2450);
    this.makeTile('tile_goal', t, 0x081c12, 0x10381f);

    this.makeVehicle('vehicle', t, 0xff6a7a, 0xffd0d6);
    this.makeLog('log', t, 0x6a4a2a, 0x8a6a3a);
    this.makeAlcove('alcove_empty', t, 0x10381f, 0x1a6a3a, false);
    this.makeAlcove('alcove_full', t, 0x10381f, 0x62ffb0, true);

    // Load skins and bake a hopper texture per palette so the menu can preview each.
    this.skins = await loadSkins();
    for (const skin of this.skins) {
      this.makeHopper(`hopper_${skin.itemId}_round`, t, skin, 'round');
      this.makeHopper(`hopper_${skin.itemId}_diamond`, t, skin, 'diamond');
    }

    this.registry.set('skins', this.skins);
    this.scene.start('Menu');
  }

  makeTile(key, t, fill, border) {
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(fill, 1);
    g.fillRect(0, 0, t, t);
    g.lineStyle(1, border, 0.5);
    g.strokeRect(0.5, 0.5, t - 1, t - 1);
    g.generateTexture(key, t, t);
    g.destroy();
  }

  // A vehicle spans one cell; drawn as a rounded chassis with a bright cabin highlight.
  makeVehicle(key, t, body, glow) {
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    const pad = t * 0.12;
    const size = t - pad * 2;
    g.fillStyle(body, 1);
    g.fillRoundedRect(pad, pad + size * 0.18, size, size * 0.64, t * 0.18);
    g.fillStyle(glow, 0.85);
    g.fillRoundedRect(pad + size * 0.22, pad + size * 0.3, size * 0.56, size * 0.28, t * 0.1);
    g.generateTexture(key, t, t);
    g.destroy();
  }

  // A log/reed span: woody bar with grain lines; a ridable surface across the river.
  makeLog(key, t, body, grain) {
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    const pad = t * 0.06;
    const size = t - pad * 2;
    g.fillStyle(body, 1);
    g.fillRoundedRect(pad, pad + size * 0.22, size, size * 0.56, t * 0.16);
    g.lineStyle(2, grain, 0.7);
    g.beginPath();
    g.moveTo(pad + 2, t * 0.5);
    g.lineTo(pad + size - 2, t * 0.5);
    g.strokePath();
    g.generateTexture(key, t, t);
    g.destroy();
  }

  // An alcove slot on the far bank: a dark niche; when full, a luminous core sits inside.
  makeAlcove(key, t, fill, ring, full) {
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    const c = t / 2;
    g.fillStyle(fill, 1);
    g.fillRect(0, 0, t, t);
    g.lineStyle(3, ring, 0.9);
    g.strokeCircle(c, c, t * 0.34);
    if (full) {
      g.fillStyle(ring, 0.3);
      g.fillCircle(c, c, t * 0.3);
      g.fillStyle(0xffffff, 0.9);
      g.fillCircle(c, c, t * 0.14);
    }
    g.generateTexture(key, t, t);
    g.destroy();
  }

  // The player marker — a luminous spark crossing the dark river. Round or diamond body.
  makeHopper(key, t, skin, shape) {
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    const c = t / 2;
    const body = hexToInt(skin.palette.body);
    const accent = hexToInt(skin.palette.accent);
    const glow = hexToInt(skin.palette.glow);
    // aura
    g.fillStyle(glow, 0.3);
    g.fillCircle(c, c, t * 0.42);
    g.fillStyle(body, 1);
    if (shape === 'diamond') {
      const r = t * 0.34;
      g.beginPath();
      g.moveTo(c, c - r);
      g.lineTo(c + r, c);
      g.lineTo(c, c + r);
      g.lineTo(c - r, c);
      g.closePath();
      g.fillPath();
    } else {
      g.fillCircle(c, c, t * 0.32);
    }
    g.fillStyle(accent, 1);
    g.fillCircle(c, c - t * 0.06, t * 0.12); // bright core
    // eyes (dark-core motif)
    g.fillStyle(0x05080f, 1);
    g.fillCircle(c - t * 0.1, c - t * 0.04, t * 0.045);
    g.fillCircle(c + t * 0.1, c - t * 0.04, t * 0.045);
    g.generateTexture(key, t, t);
    g.destroy();
  }
}
