import Phaser from 'phaser';
import { GAME_WIDTH, GAME_HEIGHT, RULES } from '../config.js';

// BootScene draws ALL textures procedurally to canvas (no binary assets), then hands off
// to the menu.
//
// IMPORTANT — TRADE DRESS: the sentinel "invaders" are ORIGINAL geometric SIGILS (concentric
// rings, chevrons, faceted diamonds), NOT the classic 1978 alien bitmaps. This is a
// deliberate departure so nothing here resembles that game's protected character art. The
// row tiers each get a distinct sigil + PRANA-palette hue (cool blues -> warm violet).
//
// Texture keys:
//   star_field                full-screen starfield backdrop
//   player                    the bottom ship (cyan wedge)
//   sentinel_0..(rows-1)      per-row sigil designs (original)
//   p_bolt                    player bolt (upward, cyan)
//   e_bolt                    enemy bolt (downward, amber)
//   cover_full..cover_0       cover arc at each erosion stage
export default class BootScene extends Phaser.Scene {
  constructor() {
    super('Boot');
  }

  create() {
    this.makeStarField('star_field', GAME_WIDTH, GAME_HEIGHT);
    this.makePlayer('player', RULES.player.width, RULES.player.height);
    this.makePBolt('p_bolt', RULES.player);
    this.makeEBolt('e_bolt', RULES.enemyBolt);

    const hues = [0x7fd6ff, 0x7fb0ff, 0x9b8aff, 0xb07fff, 0xc77fe0];
    for (let row = 0; row < RULES.grid.rows; row++) {
      this.makeSentinel(`sentinel_${row}`, RULES.grid.sentinelRadius, hues[row % hues.length], row);
    }

    // cover at each erosion stage 0..maxCells
    for (let stage = 0; stage <= RULES.cover.cells; stage++) {
      this.makeCover(`cover_${stage}`, RULES.cover, stage);
    }

    this.scene.start('Menu');
  }

  makeStarField(key, w, h) {
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(0x04060e, 1);
    g.fillRect(0, 0, w, h);
    g.fillStyle(0x0a1640, 0.22);
    g.fillCircle(w / 2, h * 0.35, Math.min(w, h) * 0.5);
    let seed = 909;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < 200; i++) {
      const a = 0.3 + rnd() * 0.6;
      g.fillStyle(0xcfe0ff, a);
      g.fillCircle(rnd() * w, rnd() * h, rnd() < 0.85 ? 0.8 : 1.6);
    }
    g.generateTexture(key, w, h);
    g.destroy();
  }

  makePlayer(key, w, h) {
    const tw = w + 8;
    const th = h + 8;
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    const cx = tw / 2;
    // a flat wedge with a central cannon
    g.fillStyle(0x0a2a4a, 1);
    g.lineStyle(2, 0x7fd6ff, 1);
    g.beginPath();
    g.moveTo(4, th - 4);
    g.lineTo(tw - 4, th - 4);
    g.lineTo(tw - 12, th * 0.45);
    g.lineTo(cx + 4, th * 0.45);
    g.lineTo(cx, 4); // cannon tip
    g.lineTo(cx - 4, th * 0.45);
    g.lineTo(12, th * 0.45);
    g.closePath();
    g.fillPath();
    g.strokePath();
    g.fillStyle(0xbff0ff, 0.9);
    g.fillCircle(cx, th * 0.6, 3);
    g.generateTexture(key, tw, th);
    g.destroy();
  }

  // ORIGINAL sentinel sigils — variety by row index, never the classic alien shapes.
  makeSentinel(key, radius, color, row) {
    const t = radius * 2.5;
    const c = t / 2;
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    const variant = row % 4;
    g.lineStyle(2, color, 1);
    g.fillStyle(color, 0.18);

    if (variant === 0) {
      // concentric ring sigil with a bright core
      g.strokeCircle(c, c, radius * 0.92);
      g.strokeCircle(c, c, radius * 0.55);
      g.fillStyle(color, 0.9);
      g.fillCircle(c, c, radius * 0.22);
      // four cardinal ticks
      g.lineStyle(2, color, 0.8);
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2;
        g.beginPath();
        g.moveTo(c + Math.cos(a) * radius * 0.55, c + Math.sin(a) * radius * 0.55);
        g.lineTo(c + Math.cos(a) * radius * 0.92, c + Math.sin(a) * radius * 0.92);
        g.strokePath();
      }
    } else if (variant === 1) {
      // faceted diamond with inner cross
      const r = radius * 0.9;
      g.beginPath();
      g.moveTo(c, c - r);
      g.lineTo(c + r, c);
      g.lineTo(c, c + r);
      g.lineTo(c - r, c);
      g.closePath();
      g.fillPath();
      g.strokePath();
      g.beginPath();
      g.moveTo(c, c - r);
      g.lineTo(c, c + r);
      g.moveTo(c - r, c);
      g.lineTo(c + r, c);
      g.strokePath();
    } else if (variant === 2) {
      // double chevron sigil
      const r = radius * 0.85;
      for (const off of [-0.3, 0.3]) {
        g.beginPath();
        g.moveTo(c - r, c + off * radius - r * 0.3);
        g.lineTo(c, c + off * radius + r * 0.4);
        g.lineTo(c + r, c + off * radius - r * 0.3);
        g.strokePath();
      }
      g.fillStyle(color, 0.9);
      g.fillCircle(c, c - r * 0.4, radius * 0.16);
    } else {
      // hexagonal sigil with a dot lattice
      const r = radius * 0.9;
      g.beginPath();
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2 + Math.PI / 6;
        const px = c + Math.cos(a) * r;
        const py = c + Math.sin(a) * r;
        if (k === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      }
      g.closePath();
      g.fillPath();
      g.strokePath();
      g.fillStyle(color, 0.9);
      g.fillCircle(c, c, radius * 0.18);
    }
    g.generateTexture(key, t, t);
    g.destroy();
  }

  makePBolt(key, playerCfg) {
    const w = 6;
    const h = 16;
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(0x9be4ff, 0.4);
    g.fillRoundedRect(0, 0, w, h, 3);
    g.fillStyle(0xffffff, 1);
    g.fillRoundedRect(w / 2 - 1.5, 1, 3, h - 2, 1.5);
    g.generateTexture(key, w, h);
    g.destroy();
  }

  makeEBolt(key, cfg) {
    const w = cfg.width + 4;
    const h = cfg.height;
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(0xffb15a, 0.45);
    g.fillRoundedRect(0, 0, w, h, 2);
    g.fillStyle(0xfff0d0, 1);
    g.fillRoundedRect(w / 2 - 1.5, 1, 3, h - 2, 1.5);
    g.generateTexture(key, w, h);
    g.destroy();
  }

  // Cover arc that visibly erodes: stage = remaining cells (0 = destroyed/empty).
  makeCover(key, cfg, stage) {
    const w = cfg.width;
    const h = cfg.radius * 1.6;
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    if (stage > 0) {
      const frac = stage / cfg.cells;
      const color = 0x3fe0a0;
      g.fillStyle(color, 0.18 + 0.22 * frac);
      g.lineStyle(2, color, 0.4 + 0.5 * frac);
      // a dome arc; as it erodes we shave the top and punch holes
      g.beginPath();
      g.arc(w / 2, h, w / 2 - 2, Math.PI, 0, false);
      g.lineTo(w / 2 + (w / 2 - 2), h);
      g.lineTo(w / 2 - (w / 2 - 2), h);
      g.closePath();
      g.fillPath();
      g.strokePath();
      // erosion bites: punch dark notches proportional to damage
      const bites = cfg.cells - stage;
      g.fillStyle(0x04060e, 1);
      for (let b = 0; b < bites; b++) {
        const bx = 8 + (b * (w - 16)) / Math.max(1, cfg.cells - 1);
        g.fillCircle(bx, h - 6 - (b % 2) * 8, 6);
      }
    }
    g.generateTexture(key, w, Math.ceil(h));
    g.destroy();
  }
}
