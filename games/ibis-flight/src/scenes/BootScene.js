import Phaser from 'phaser';
import { RULES } from '../config.js';

// BootScene draws ALL textures procedurally to canvas (no binary assets): the ibis, a pillar
// segment (tiled to any height), and the ground strip. Then it hands off to the menu.
//
// Texture keys:
//   ibis          luminous bird (dark body, bright core, beak + wing accent)
//   pillar        a vertical pillar tile (dark base, bright inner light-line)
//   pillar_cap    a rounded cap drawn at the gap-facing end of each pillar
//   ground        the floor strip
export default class BootScene extends Phaser.Scene {
  constructor() {
    super('Boot');
  }

  create() {
    this.makeIbis('ibis', RULES.birdR, 0xbff0ff, 0x0a3a66);
    this.makePillar('pillar', RULES.pillarW, 0x123a5e, 0x62d0ff);
    this.makeCap('pillar_cap', RULES.pillarW, 0x1a4f7a, 0x9be4ff);
    this.makeGround('ground', this.scale.width, 28, 0x0a1830, 0x1a3a6a);
    this.scene.start('Menu');
  }

  // Ibis: dark rounded body, bright luminous core, a beak and a wing tick (the dark-field /
  // bright-core motif). Drawn into a square texture sized to the collision diameter + halo.
  makeIbis(key, r, glow, base) {
    const d = r * 2 + 10;
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    const c = d / 2;
    // halo
    g.fillStyle(glow, 0.18);
    g.fillCircle(c, c, r + 4);
    // body
    g.fillStyle(base, 1);
    g.fillCircle(c, c, r);
    // bright core
    g.fillStyle(glow, 0.9);
    g.fillCircle(c, c, r * 0.55);
    // beak (points right — the direction of travel)
    g.fillStyle(0xffd27f, 1);
    g.beginPath();
    g.moveTo(c + r * 0.7, c);
    g.lineTo(c + r * 1.35, c - r * 0.18);
    g.lineTo(c + r * 1.35, c + r * 0.18);
    g.closePath();
    g.fillPath();
    // eye
    g.fillStyle(0x05080f, 1);
    g.fillCircle(c + r * 0.25, c - r * 0.2, r * 0.12);
    g.generateTexture(key, d, d);
    g.destroy();
  }

  // A 1px-tall would be wasteful; make a tall tile we stretch to any pillar height.
  makePillar(key, w, base, light) {
    const h = 32;
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(base, 1);
    g.fillRect(0, 0, w, h);
    g.fillStyle(light, 0.5);
    g.fillRect(w * 0.42, 0, w * 0.16, h); // inner light-line
    g.lineStyle(2, light, 0.35);
    g.strokeRect(1, 0, w - 2, h);
    g.generateTexture(key, w, h);
    g.destroy();
  }

  makeCap(key, w, base, light) {
    const h = 18;
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(base, 1);
    g.fillRoundedRect(0, 0, w, h, 8);
    g.fillStyle(light, 0.6);
    g.fillRoundedRect(w * 0.36, 3, w * 0.28, h - 6, 6);
    g.generateTexture(key, w, h);
    g.destroy();
  }

  makeGround(key, w, h, base, edge) {
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(base, 1);
    g.fillRect(0, 0, w, h);
    g.lineStyle(2, edge, 0.7);
    g.lineBetween(0, 1, w, 1);
    g.generateTexture(key, w, h);
    g.destroy();
  }
}
