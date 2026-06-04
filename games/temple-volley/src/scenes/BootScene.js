import Phaser from 'phaser';
import { FIELD } from '../config.js';

// BootScene draws ALL textures procedurally to canvas (no binary assets): the two paddles,
// the ball, and a soft center-net dash. Then it hands off to the menu.
//
// Texture keys:
//   paddle_left / paddle_right  luminous temple-pillar paddles (dark base, bright core edge)
//   ball                        glowing orb with a soft halo
//   net_dash                    one dash of the center divider
export default class BootScene extends Phaser.Scene {
  constructor() {
    super('Boot');
  }

  create() {
    this.makePaddle('paddle_left', FIELD.paddleW, FIELD.paddleH, 0x62d0ff, 0x0a3a66);
    this.makePaddle('paddle_right', FIELD.paddleW, FIELD.paddleH, 0xffd27f, 0x7a4a0a);
    this.makeBall('ball', FIELD.ballSize, 0xbff0ff, 0xffffff);
    this.makeNetDash('net_dash', 4, 18, 0x2a3f6a);
    this.scene.start('Menu');
  }

  // A paddle: dark rounded base with a bright inner light-bar (dark-field / bright-core motif).
  makePaddle(key, w, h, bright, base) {
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(base, 1);
    g.fillRoundedRect(0, 0, w, h, w * 0.45);
    g.fillStyle(bright, 0.9);
    const pad = w * 0.28;
    g.fillRoundedRect(pad, pad, w - pad * 2, h - pad * 2, w * 0.3);
    g.fillStyle(0xffffff, 0.5);
    g.fillRoundedRect(w * 0.4, h * 0.1, w * 0.2, h * 0.8, w * 0.2);
    g.generateTexture(key, w, h);
    g.destroy();
  }

  // Glowing ball: bright core + soft halo.
  makeBall(key, size, glow, core) {
    const d = size * 2; // give halo room
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    const c = d / 2;
    g.fillStyle(glow, 0.22);
    g.fillCircle(c, c, size * 0.95);
    g.fillStyle(glow, 0.5);
    g.fillCircle(c, c, size * 0.65);
    g.fillStyle(core, 1);
    g.fillCircle(c, c, size * 0.42);
    g.generateTexture(key, d, d);
    g.destroy();
  }

  makeNetDash(key, w, h, color) {
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(color, 0.8);
    g.fillRoundedRect(0, 0, w, h, w * 0.5);
    g.generateTexture(key, w, h);
    g.destroy();
  }
}
