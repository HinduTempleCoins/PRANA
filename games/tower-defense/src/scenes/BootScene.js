import Phaser from 'phaser';
import { GRID } from '../config.js';
import { RARITIES, rarityColor } from '../data/rarity.js';

// BootScene draws all placeholder textures procedurally to canvas (no binary assets) and
// then hands off to the menu.
export default class BootScene extends Phaser.Scene {
  constructor() {
    super('Boot');
  }

  create() {
    const t = GRID.tile;

    // --- map tiles --------------------------------------------------------------------- //
    this.makeRect('tile_grass', t, t, 0x16233f, 0x223255);
    this.makeRect('tile_path', t, t, 0x3a2a1c, 0x4d3a26);
    this.makeRect('tile_build', t, t, 0x1d3350, 0x35508a);

    // --- a square texture per rarity (towers) ------------------------------------------ //
    for (const rarity of RARITIES) {
      this.makeTower(`tower_${rarity}`, t, rarityColor(rarity));
    }
    // generic placement ghost
    this.makeTower('tower_ghost', t, 0x6688cc, 0.35);

    // --- enemy (circle) ---------------------------------------------------------------- //
    this.makeCircle('enemy', t * 0.34, 0xff5a5a, 0x9a2222);

    // --- projectile (small dot) -------------------------------------------------------- //
    this.makeCircle('bullet', 5, 0xffe680, 0xc8a83a);

    this.scene.start('Menu');
  }

  // Draw a filled rect with a 1px inset border into a named texture.
  makeRect(key, w, h, fill, border) {
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(fill, 1);
    g.fillRect(0, 0, w, h);
    g.lineStyle(2, border, 1);
    g.strokeRect(1, 1, w - 2, h - 2);
    g.generateTexture(key, w, h);
    g.destroy();
  }

  // Draw a tower as an inset rounded square plus a small turret dot.
  makeTower(key, t, color, alpha = 1) {
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    const pad = t * 0.18;
    const size = t - pad * 2;
    g.fillStyle(color, alpha);
    g.fillRoundedRect(pad, pad, size, size, 6);
    g.lineStyle(2, 0x0b1020, alpha);
    g.strokeRoundedRect(pad, pad, size, size, 6);
    g.fillStyle(0x0b1020, alpha);
    g.fillCircle(t / 2, t / 2, t * 0.1);
    g.generateTexture(key, t, t);
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
}
