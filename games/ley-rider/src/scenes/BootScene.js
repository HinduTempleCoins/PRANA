import Phaser from 'phaser';

// BootScene draws all placeholder textures procedurally (no binary assets) then hands off.
export default class BootScene extends Phaser.Scene {
  constructor() {
    super('Boot');
  }

  create() {
    // Rider sled: a rounded rectangle body with a small rider dot.
    this.makeSled('sled', 34, 16, 0x6fd3ff, 0x103048);
    // Rider body circle (used for the physics-radius marker).
    this.makeCircle('rider', 9, 0xffe680, 0xc8a83a);
    // Start + finish flags.
    this.makeFlag('flag_start', 0x49d17a);
    this.makeFlag('flag_finish', 0xff6f6f);

    this.scene.start('Menu');
  }

  makeSled(key, w, h, fill, border) {
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(fill, 1);
    g.fillRoundedRect(0, h * 0.45, w, h * 0.55, 4);
    g.lineStyle(2, border, 1);
    g.strokeRoundedRect(1, h * 0.45 + 1, w - 2, h * 0.55 - 2, 4);
    // rider dot
    g.fillStyle(0xffe680, 1);
    g.fillCircle(w * 0.5, h * 0.32, h * 0.3);
    g.generateTexture(key, w, h + 2);
    g.destroy();
  }

  makeCircle(key, r, fill, border) {
    const d = r * 2 + 4;
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(fill, 1);
    g.fillCircle(d / 2, d / 2, r);
    g.lineStyle(2, border, 1);
    g.strokeCircle(d / 2, d / 2, r);
    g.generateTexture(key, d, d);
    g.destroy();
  }

  makeFlag(key, color) {
    const w = 22;
    const h = 32;
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    g.lineStyle(2, 0xdfe9ff, 1);
    g.beginPath();
    g.moveTo(2, 0);
    g.lineTo(2, h);
    g.strokePath();
    g.fillStyle(color, 1);
    g.fillTriangle(2, 2, w, 8, 2, 16);
    g.generateTexture(key, w, h);
    g.destroy();
  }
}
