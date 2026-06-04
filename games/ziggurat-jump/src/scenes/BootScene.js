import Phaser from 'phaser';
import { RULES } from '../config.js';
import { loadSkins, hexToInt } from '../data/skins.js';

// BootScene draws ALL textures procedurally to canvas (no binary assets): per-skin hopper +
// the three platform types (normal stone ledge, moving ledge, crumble ledge), plus a glow
// dot for the bounce trail. Then it hands off to the menu.
//
// Texture keys:
//   hopper_<itemId>     the player sprite (rounded body, lit edge, eyes)
//   trail_<itemId>      small glow dot for the bounce trail
//   plat_normal / plat_moving / plat_crumble   the ziggurat ledges
export default class BootScene extends Phaser.Scene {
  constructor() {
    super('Boot');
  }

  async create() {
    this.skins = await loadSkins();
    for (const skin of this.skins) {
      this.makeHopper(`hopper_${skin.itemId}`, hexToInt(skin.palette.body), hexToInt(skin.palette.edge), hexToInt(skin.palette.glow));
      this.makeTrail(`trail_${skin.itemId}`, hexToInt(skin.palette.glow));
    }
    this.makePlatform('plat_normal', 0x3a4a6a, 0x6f93c8, false, false);
    this.makePlatform('plat_moving', 0x2a5a4a, 0x6fd0b0, true, false);
    this.makePlatform('plat_crumble', 0x5a3a2a, 0xd09060, false, true);

    this.registry.set('skins', this.skins);
    this.scene.start('Menu');
  }

  // Rounded hopper with a lit top bevel and two dark eyes (the bright-core motif).
  makeHopper(key, body, edge, glow) {
    const w = RULES.playerW;
    const h = RULES.playerH;
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(body, 1);
    g.fillRoundedRect(1, 1, w - 2, h - 2, w * 0.32);
    g.fillStyle(edge, 0.6);
    g.fillRoundedRect(w * 0.12, h * 0.1, w * 0.76, h * 0.24, w * 0.16);
    g.fillStyle(glow, 0.25);
    g.fillCircle(w / 2, h / 2, w * 0.3);
    // eyes
    g.fillStyle(0x070b18, 1);
    g.fillCircle(w * 0.36, h * 0.52, w * 0.07);
    g.fillCircle(w * 0.64, h * 0.52, w * 0.07);
    g.generateTexture(key, w, h);
    g.destroy();
  }

  makeTrail(key, glow) {
    const d = 14;
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(glow, 0.5);
    g.fillCircle(d / 2, d / 2, d * 0.45);
    g.fillStyle(glow, 1);
    g.fillCircle(d / 2, d / 2, d * 0.22);
    g.generateTexture(key, d, d);
    g.destroy();
  }

  // Ziggurat ledge: stepped stone block. `moving` adds side arrows; `crumble` adds cracks.
  makePlatform(key, fill, edge, moving, crumble) {
    const w = RULES.platformW;
    const h = RULES.platformH;
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(fill, 1);
    g.fillRoundedRect(0, 0, w, h, 4);
    // top lit edge
    g.fillStyle(edge, 0.7);
    g.fillRect(0, 0, w, 3);
    // stepped notch ends (ziggurat look)
    g.fillStyle(0x000000, 0.25);
    g.fillRect(0, h - 3, w, 3);
    if (moving) {
      g.fillStyle(edge, 0.9);
      // left/right chevrons
      g.fillTriangle(6, h / 2, 12, h * 0.3, 12, h * 0.7);
      g.fillTriangle(w - 6, h / 2, w - 12, h * 0.3, w - 12, h * 0.7);
    }
    if (crumble) {
      g.lineStyle(1.5, 0x1a0e08, 0.8);
      g.beginPath();
      g.moveTo(w * 0.3, 2);
      g.lineTo(w * 0.42, h - 2);
      g.moveTo(w * 0.62, 2);
      g.lineTo(w * 0.55, h - 2);
      g.strokePath();
    }
    g.generateTexture(key, w, h);
    g.destroy();
  }
}
