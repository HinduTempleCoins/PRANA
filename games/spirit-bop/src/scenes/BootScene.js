import Phaser from 'phaser';
import { GRID } from '../config.js';
import { loadSkins, hexToInt } from '../data/skins.js';

// BootScene draws ALL textures procedurally to canvas (no binary assets): the mound/hole
// backdrop and a per-skin spirit + lantern sprite. Then it hands off to the menu.
//
// Texture keys:
//   mound                              the dark niche a spirit rises from
//   spirit_<itemId>_round / _wisp      the boppable spirit per skin
//   lantern_<itemId>                   the friendly lantern-spirit per skin (DON'T bop)
//   bop_fx                             a hit burst
export default class BootScene extends Phaser.Scene {
  constructor() {
    super('Boot');
  }

  async create() {
    const c = GRID.cell;
    this.makeMound('mound', c);
    this.makeBurst('bop_fx', c);

    this.skins = await loadSkins();
    for (const skin of this.skins) {
      this.makeSpirit(`spirit_${skin.itemId}_round`, c, skin, 'round');
      this.makeSpirit(`spirit_${skin.itemId}_wisp`, c, skin, 'wisp');
      this.makeLantern(`lantern_${skin.itemId}`, c, skin);
    }

    this.registry.set('skins', this.skins);
    this.scene.start('Menu');
  }

  // A dark niche/hole the spirit rises out of.
  makeMound(key, c) {
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    const cx = c / 2;
    g.fillStyle(0x0a0a18, 1);
    g.fillRoundedRect(c * 0.08, c * 0.08, c * 0.84, c * 0.84, c * 0.16);
    g.fillStyle(0x05050d, 1);
    g.fillEllipse(cx, c * 0.62, c * 0.62, c * 0.42); // the dark mouth
    g.lineStyle(3, 0x1a1a30, 0.8);
    g.strokeEllipse(cx, c * 0.62, c * 0.62, c * 0.42);
    g.generateTexture(key, c, c);
    g.destroy();
  }

  // The boppable spirit — a luminous wisp with a face. Round or trailing-wisp variant.
  makeSpirit(key, c, skin, face) {
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    const cx = c / 2;
    const cy = c * 0.46;
    const body = hexToInt(skin.palette.spirit);
    const accent = hexToInt(skin.palette.accent);
    // aura
    g.fillStyle(body, 0.28);
    g.fillCircle(cx, cy, c * 0.4);
    g.fillStyle(body, 1);
    if (face === 'wisp') {
      g.fillCircle(cx, cy, c * 0.3);
      // trailing tail
      g.fillTriangle(cx - c * 0.18, cy + c * 0.1, cx + c * 0.18, cy + c * 0.1, cx, cy + c * 0.42);
    } else {
      g.fillCircle(cx, cy, c * 0.32);
    }
    g.fillStyle(accent, 0.9);
    g.fillCircle(cx, cy - c * 0.06, c * 0.12); // bright core
    // angry eyes (bop me!)
    g.fillStyle(0x05080f, 1);
    g.fillCircle(cx - c * 0.1, cy - c * 0.02, c * 0.05);
    g.fillCircle(cx + c * 0.1, cy - c * 0.02, c * 0.05);
    g.generateTexture(key, c, c);
    g.destroy();
  }

  // The friendly lantern-spirit — visibly DIFFERENT (warm lantern hue, a calm flame), so the
  // player can learn NOT to bop it. Carries a glowing lantern shape.
  makeLantern(key, c, skin) {
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    const cx = c / 2;
    const cy = c * 0.46;
    const lantern = hexToInt(skin.palette.lantern);
    // big soft halo so it reads as "friendly / don't hit"
    g.fillStyle(lantern, 0.32);
    g.fillCircle(cx, cy, c * 0.46);
    // lantern body (rounded square)
    g.fillStyle(lantern, 1);
    g.fillRoundedRect(cx - c * 0.2, cy - c * 0.22, c * 0.4, c * 0.44, c * 0.08);
    // bright flame core
    g.fillStyle(0xfff6d0, 0.95);
    g.fillCircle(cx, cy, c * 0.12);
    // top handle
    g.lineStyle(3, lantern, 1);
    g.beginPath();
    g.arc(cx, cy - c * 0.24, c * 0.1, Math.PI, 0);
    g.strokePath();
    g.generateTexture(key, c, c);
    g.destroy();
  }

  makeBurst(key, c) {
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    const cx = c / 2;
    g.fillStyle(0xffffff, 0.9);
    g.fillCircle(cx, cx, c * 0.16);
    g.fillStyle(0xbff0ff, 0.5);
    g.fillCircle(cx, cx, c * 0.3);
    g.generateTexture(key, c, c);
    g.destroy();
  }
}
