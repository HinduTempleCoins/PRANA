import Phaser from 'phaser';
import { BOARD } from '../config.js';
import { loadSkins, hexToInt } from '../data/skins.js';
import { tierValue } from '../logic/merge.js';

// BootScene draws ALL textures procedurally to canvas (no binary assets). For each skin we
// bake a carved-rune stone tile per visible tier, brightening as the tier climbs (the
// "lit-from-within" rune look). Then it hands off to the menu.
//
// Texture keys per skin id:
//   cell_<itemId>            empty board slot (recessed dark socket)
//   stone_<itemId>_<tier>    carved stone for that tier (1..MAX_TIER)
const MAX_TIER = 13; // up to value 8192 — plenty of headroom

export default class BootScene extends Phaser.Scene {
  constructor() {
    super('Boot');
  }

  async create() {
    const t = BOARD.tile;

    this.skins = await loadSkins();
    for (const skin of this.skins) {
      const stone = hexToInt(skin.palette.stone);
      const edge = hexToInt(skin.palette.edge);
      const glow = hexToInt(skin.palette.glow);
      this.makeCell(`cell_${skin.itemId}`, t);
      for (let tier = 1; tier <= MAX_TIER; tier++) {
        this.makeStone(`stone_${skin.itemId}_${tier}`, t, tier, stone, edge, glow, skin.glyph);
      }
    }

    this.registry.set('skins', this.skins);
    this.scene.start('Menu');
  }

  // Recessed empty slot — a dark rounded socket with a faint inner border.
  makeCell(key, t) {
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(0x121a2e, 1);
    g.fillRoundedRect(0, 0, t, t, t * 0.12);
    g.fillStyle(0x0a0e1a, 1);
    g.fillRoundedRect(t * 0.06, t * 0.06, t * 0.88, t * 0.88, t * 0.1);
    g.generateTexture(key, t, t);
    g.destroy();
  }

  // Carved-stone tile for a tier. Higher tiers ride the palette toward the bright `glow`
  // (lit-from-within), get a stronger bevel, and carry a procedural carved glyph.
  makeStone(key, t, tier, stone, edge, glow, glyphStyle) {
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    const lift = Math.min(1, (tier - 1) / 9); // 0..1 how "evolved" this stone looks
    const fill = Phaser.Display.Color.Interpolate.ColorWithColor(
      Phaser.Display.Color.IntegerToColor(stone),
      Phaser.Display.Color.IntegerToColor(glow),
      100,
      Math.round(lift * 42),
    );
    const fillInt = Phaser.Display.Color.GetColor(fill.r, fill.g, fill.b);

    // base slab
    g.fillStyle(fillInt, 1);
    g.fillRoundedRect(0, 0, t, t, t * 0.12);
    // top bevel highlight (edge color), bottom shadow
    g.fillStyle(edge, 0.18 + lift * 0.22);
    g.fillRoundedRect(t * 0.06, t * 0.06, t * 0.88, t * 0.2, t * 0.08);
    g.fillStyle(0x000000, 0.22);
    g.fillRoundedRect(t * 0.06, t * 0.74, t * 0.88, t * 0.2, t * 0.08);

    // carved inset frame
    g.lineStyle(2, edge, 0.5 + lift * 0.4);
    g.strokeRoundedRect(t * 0.12, t * 0.12, t * 0.76, t * 0.76, t * 0.1);

    // carved glyph — a procedural rune/sigil keyed off the tier so each tier reads distinct.
    this.carveGlyph(g, t, tier, edge, glow, glyphStyle, lift);

    g.generateTexture(key, t, t);
    g.destroy();
  }

  // Draw a deterministic carved mark for the tier. Strokes look "engraved": a darker
  // shadow stroke offset under a bright `glow` stroke.
  carveGlyph(g, t, tier, edge, glow, glyphStyle, lift) {
    const c = t / 2;
    const R = t * 0.24;
    const spokes = 3 + (tier % 6); // 3..8 spokes — visually distinguishes tiers
    const rot = (tier * 0.7) % (Math.PI * 2);
    const drawSet = (color, alpha, ox, oy, width) => {
      g.lineStyle(width, color, alpha);
      if (glyphStyle === 'sigil') {
        // sigil: concentric arcs + radial ticks
        g.beginPath();
        g.arc(c + ox, c + oy, R, 0, Math.PI * 2);
        g.strokePath();
        g.beginPath();
        g.arc(c + ox, c + oy, R * 0.55, 0, Math.PI * 2);
        g.strokePath();
      }
      for (let s = 0; s < spokes; s++) {
        const a = rot + (s / spokes) * Math.PI * 2;
        const r0 = glyphStyle === 'sigil' ? R * 0.55 : 0;
        g.beginPath();
        g.moveTo(c + ox + Math.cos(a) * r0, c + oy + Math.sin(a) * r0);
        g.lineTo(c + ox + Math.cos(a) * R, c + oy + Math.sin(a) * R);
        g.strokePath();
      }
    };
    // engraved shadow then lit edge
    drawSet(0x000000, 0.35, 1.5, 1.5, 3);
    drawSet(glow, 0.55 + lift * 0.4, 0, 0, 2);
    // a center boss
    g.fillStyle(edge, 0.5 + lift * 0.4);
    g.fillCircle(c, c, t * 0.05 + lift * t * 0.02);
  }
}

export { MAX_TIER };
// keep tierValue referenced so a future label-on-texture path can use it without a new import
void tierValue;
