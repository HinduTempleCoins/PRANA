import Phaser from 'phaser';
import { GRID } from '../config.js';
import { loadSkins, hexToInt } from '../data/skins.js';

// BootScene draws ALL textures procedurally to canvas (no binary assets), generating a
// per-skin segment/head/orb set, then hands off to the menu.
//
// Texture keys per skin id:
//   seg_<itemId>     rounded body segment (dark base palette.body)
//   head_<itemId>_round / _diamond   luminous head (palette.head) with the chosen shape
//   orb_<itemId>     glowing light-orb (palette.glow) — pulse tween applied in PlayScene
export default class BootScene extends Phaser.Scene {
  constructor() {
    super('Boot');
  }

  async create() {
    const t = GRID.tile;

    // Board backdrop tiles (dark field with a faint grid).
    this.makeTile('tile_dark', t, 0x070b16, 0x0e1830);

    // Load skins and bake a texture set for each so the menu can preview every palette.
    this.skins = await loadSkins();
    for (const skin of this.skins) {
      this.makeSegment(`seg_${skin.itemId}`, t, hexToInt(skin.palette.body), hexToInt(skin.palette.head));
      this.makeHead(`head_${skin.itemId}_round`, t, hexToInt(skin.palette.head), 'round');
      this.makeHead(`head_${skin.itemId}_diamond`, t, hexToInt(skin.palette.head), 'diamond');
      this.makeOrb(`orb_${skin.itemId}`, t, hexToInt(skin.palette.glow), hexToInt(skin.palette.head));
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

  // Rounded body segment: dark fill, lighter inner highlight (gradient feel toward the head).
  makeSegment(key, t, body, head) {
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    const pad = t * 0.1;
    const size = t - pad * 2;
    g.fillStyle(body, 1);
    g.fillRoundedRect(pad, pad, size, size, t * 0.28);
    // subtle inner glow toward the head color
    g.fillStyle(head, 0.16);
    g.fillRoundedRect(pad + size * 0.2, pad + size * 0.2, size * 0.6, size * 0.6, t * 0.18);
    g.generateTexture(key, t, t);
    g.destroy();
  }

  // Luminous head, two shape variants.
  makeHead(key, t, color, shape) {
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    const c = t / 2;
    g.fillStyle(color, 1);
    if (shape === 'diamond') {
      const r = t * 0.42;
      g.beginPath();
      g.moveTo(c, c - r);
      g.lineTo(c + r, c);
      g.lineTo(c, c + r);
      g.lineTo(c - r, c);
      g.closePath();
      g.fillPath();
    } else {
      g.fillRoundedRect(t * 0.08, t * 0.08, t * 0.84, t * 0.84, t * 0.38);
    }
    // eyes (the dark-core motif — bright head, dark pupils)
    g.fillStyle(0x05080f, 1);
    g.fillCircle(c - t * 0.16, c - t * 0.08, t * 0.07);
    g.fillCircle(c + t * 0.16, c - t * 0.08, t * 0.07);
    g.generateTexture(key, t, t);
    g.destroy();
  }

  // Glowing light-orb: bright core with a soft halo ring.
  makeOrb(key, t, glow, core) {
    const d = t;
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    const c = d / 2;
    g.fillStyle(glow, 0.22);
    g.fillCircle(c, c, t * 0.46); // halo
    g.fillStyle(glow, 0.45);
    g.fillCircle(c, c, t * 0.32);
    g.fillStyle(core, 1);
    g.fillCircle(c, c, t * 0.2); // bright core
    g.generateTexture(key, d, d);
    g.destroy();
  }
}
