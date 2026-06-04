import Phaser from 'phaser';
import { RULES } from '../config.js';
import { HP_COLOR } from '../logic/bounce.js';
import { loadSkins, hexToInt } from '../data/skins.js';

// BootScene draws ALL textures procedurally to canvas (no binary assets): the ball, a paddle
// per skin, a brick per HP tier, and the powerup capsules. Then hands off to the menu.
//
// Texture keys:
//   ball_<itemId>        round ball in the skin's ball colour
//   paddle_<itemId>      rounded paddle bar in the skin's paddle colour
//   brick_hp<n>          brick for HP tier n (colour from HP_COLOR)
//   pu_wide / pu_multi   powerup capsules
export default class BootScene extends Phaser.Scene {
  constructor() {
    super('Boot');
  }

  async create() {
    // Brick textures per HP tier (shared across skins — tier colour is gameplay identity).
    for (const tier of Object.keys(HP_COLOR)) {
      this.makeBrick(`brick_hp${tier}`, 90, 28, hexToInt(HP_COLOR[tier]));
    }

    // Powerup capsules.
    this.makeCapsule('pu_wide', 0x62d0ff, 'W');
    this.makeCapsule('pu_multi', 0xffd27f, 'M');

    // Per-skin ball + paddle so the menu can preview each palette.
    this.skins = await loadSkins();
    for (const skin of this.skins) {
      this.makeBall(`ball_${skin.itemId}`, RULES.ballRadius, hexToInt(skin.palette.ball));
      this.makePaddle(`paddle_${skin.itemId}`, 160, RULES.paddleHeight, hexToInt(skin.palette.paddle));
    }

    this.registry.set('skins', this.skins);
    this.scene.start('Menu');
  }

  // Brick: solid fill, top bevel highlight, bottom inner shadow.
  makeBrick(key, w, h, color) {
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(color, 1);
    g.fillRoundedRect(0, 0, w, h, 5);
    g.fillStyle(0xffffff, 0.18);
    g.fillRoundedRect(0, 0, w, h * 0.4, 5);
    g.fillStyle(0x000000, 0.22);
    g.fillRect(0, h - 4, w, 4);
    g.generateTexture(key, w, h);
    g.destroy();
  }

  // Ball: bright core with a soft halo ring.
  makeBall(key, r, color) {
    const d = r * 2 + 6;
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    const c = d / 2;
    g.fillStyle(color, 0.25);
    g.fillCircle(c, c, r + 3); // halo
    g.fillStyle(color, 1);
    g.fillCircle(c, c, r);
    g.fillStyle(0xffffff, 0.5);
    g.fillCircle(c - r * 0.3, c - r * 0.3, r * 0.35); // specular
    g.generateTexture(key, d, d);
    g.destroy();
  }

  // Paddle: rounded bar with a centre highlight (the "sweet spot" cue).
  makePaddle(key, w, h, color) {
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(color, 1);
    g.fillRoundedRect(0, 0, w, h, h / 2);
    g.fillStyle(0xffffff, 0.22);
    g.fillRoundedRect(w * 0.5 - h, 2, h * 2, h * 0.4, h * 0.2);
    g.generateTexture(key, w, h);
    g.destroy();
  }

  // Powerup capsule: pill with a letter cue.
  makeCapsule(key, color, letter) {
    const w = 34;
    const h = 18;
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(color, 0.3);
    g.fillRoundedRect(0, 0, w, h, h / 2);
    g.lineStyle(2, color, 1);
    g.strokeRoundedRect(1, 1, w - 2, h - 2, h / 2);
    g.generateTexture(key, w, h);
    g.destroy();
    // The letter is drawn as a Text object in the scene; we keep the capsule art textureless
    // of glyphs so a single texture serves both. (Scene overlays the letter.)
    this._capsuleLetters = this._capsuleLetters || {};
    this._capsuleLetters[key] = letter;
  }
}
