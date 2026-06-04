import Phaser from 'phaser';
import { GRID } from '../config.js';
import { PIECES, PIECE_KEYS } from '../logic/stack.js';
import { loadSkins, hexToInt } from '../data/skins.js';

// BootScene draws ALL textures procedurally to canvas (no binary assets): one carved-stone
// block texture per stela colour, plus a per-skin well tile. Then hands off to the menu.
//
// Texture keys:
//   block_<PIECEKEY>   carved stone cell in that piece's colour
//   well_<itemId>      dark backdrop tile with a faint gridline (per skin)
export default class BootScene extends Phaser.Scene {
  constructor() {
    super('Boot');
  }

  async create() {
    const t = GRID.tile;

    // One stone-block texture per piece colour (shared across skins — piece colour is
    // gameplay identity, not cosmetic). Plus a neutral "ghost" tint for the drop preview.
    for (const key of PIECE_KEYS) {
      this.makeBlock(`block_${key}`, t, hexToInt(PIECES[key].color));
    }
    this.makeGhost('block_ghost', t, 0x9fb6e8);

    // Per-skin well tiles so the menu can preview each palette.
    this.skins = await loadSkins();
    for (const skin of this.skins) {
      this.makeTile(`well_${skin.itemId}`, t, hexToInt(skin.palette.well), hexToInt(skin.palette.grid));
    }

    this.registry.set('skins', this.skins);
    this.scene.start('Menu');
  }

  // Dark well tile with a faint inner gridline (the temple-floor backdrop).
  makeTile(key, t, fill, border) {
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(fill, 1);
    g.fillRect(0, 0, t, t);
    g.lineStyle(1, border, 0.5);
    g.strokeRect(0.5, 0.5, t - 1, t - 1);
    g.generateTexture(key, t, t);
    g.destroy();
  }

  // Carved-stone block: solid fill, lighter top/left bevel, darker inner shadow — gives the
  // glyphs a chiselled, engraved-stela feel rather than a flat tetromino square.
  makeBlock(key, t, color) {
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    const pad = 1;
    g.fillStyle(color, 1);
    g.fillRect(pad, pad, t - pad * 2, t - pad * 2);
    // bevel highlight (top + left)
    g.fillStyle(0xffffff, 0.18);
    g.fillRect(pad, pad, t - pad * 2, t * 0.16);
    g.fillRect(pad, pad, t * 0.16, t - pad * 2);
    // engraved inner shadow (bottom + right)
    g.fillStyle(0x000000, 0.28);
    g.fillRect(pad, t - t * 0.16 - pad, t - pad * 2, t * 0.16);
    g.fillRect(t - t * 0.16 - pad, pad, t * 0.16, t - pad * 2);
    // central carved glyph dot
    g.fillStyle(0x000000, 0.16);
    g.fillCircle(t / 2, t / 2, t * 0.12);
    g.generateTexture(key, t, t);
    g.destroy();
  }

  // Translucent outline used for the hard-drop ghost preview.
  makeGhost(key, t, color) {
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    g.lineStyle(2, color, 0.5);
    g.strokeRect(2, 2, t - 4, t - 4);
    g.generateTexture(key, t, t);
    g.destroy();
  }
}
