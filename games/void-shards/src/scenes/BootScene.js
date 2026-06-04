import Phaser from 'phaser';
import { GAME_WIDTH, GAME_HEIGHT, RULES } from '../config.js';

// BootScene draws ALL textures procedurally to canvas (no binary assets), then hands off
// to the menu. The Void Shards palette is the PRANA dark-field / bright-core motif:
// near-black space, luminous cyan ship + bolts, faceted blue-violet shards, amber saucer.
//
// Texture keys:
//   star_field           full-screen procedural starfield backdrop
//   ship                 triangular ship (cyan), nose pointing +x (angle 0)
//   ship_thrust          ship with an exhaust flare
//   bolt                 small luminous bolt
//   hostile_bolt         amber saucer bolt
//   shard_large/medium/small   faceted polygon shards (rough-rock silhouettes)
//   saucer               hostile saucer
export default class BootScene extends Phaser.Scene {
  constructor() {
    super('Boot');
  }

  create() {
    this.makeStarField('star_field', GAME_WIDTH, GAME_HEIGHT);
    this.makeShip('ship', RULES.ship.radius, false);
    this.makeShip('ship_thrust', RULES.ship.radius, true);
    this.makeBolt('bolt', RULES.bolt.radius, 0x9be4ff, 0xffffff);
    this.makeBolt('hostile_bolt', 3, 0xffb15a, 0xfff0d0);
    this.makeShard('shard_large', RULES.shards.large.radius, 0x6a78d8);
    this.makeShard('shard_medium', RULES.shards.medium.radius, 0x8a7ff0);
    this.makeShard('shard_small', RULES.shards.small.radius, 0xb07fff);
    this.makeSaucer('saucer', RULES.saucer.radius);

    this.scene.start('Menu');
  }

  makeStarField(key, w, h) {
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(0x04060e, 1);
    g.fillRect(0, 0, w, h);
    // faint nebula wash toward center (dark-field, brighter core)
    g.fillStyle(0x0a1640, 0.25);
    g.fillCircle(w / 2, h / 2, Math.min(w, h) * 0.45);
    // deterministic-ish starfield
    let seed = 1337;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < 220; i++) {
      const x = rnd() * w;
      const y = rnd() * h;
      const r = rnd() < 0.85 ? 0.8 : 1.6;
      const a = 0.3 + rnd() * 0.6;
      g.fillStyle(0xcfe0ff, a);
      g.fillCircle(x, y, r);
    }
    g.generateTexture(key, w, h);
    g.destroy();
  }

  // Triangular ship: drawn in a square texture, nose pointing +x (right) so angle 0 = facing right.
  makeShip(key, radius, thrust) {
    const t = radius * 3;
    const c = t / 2;
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    if (thrust) {
      // exhaust flare behind the ship (toward -x)
      g.fillStyle(0xff9b5a, 0.9);
      g.beginPath();
      g.moveTo(c - radius * 0.9, c - radius * 0.4);
      g.lineTo(c - radius * 1.7, c);
      g.lineTo(c - radius * 0.9, c + radius * 0.4);
      g.closePath();
      g.fillPath();
    }
    // hull
    g.fillStyle(0x0a2a4a, 1);
    g.lineStyle(2, 0x7fd6ff, 1);
    g.beginPath();
    g.moveTo(c + radius, c); // nose (+x)
    g.lineTo(c - radius * 0.8, c - radius * 0.8);
    g.lineTo(c - radius * 0.4, c);
    g.lineTo(c - radius * 0.8, c + radius * 0.8);
    g.closePath();
    g.fillPath();
    g.strokePath();
    // cockpit glow core
    g.fillStyle(0xbff0ff, 0.9);
    g.fillCircle(c + radius * 0.1, c, radius * 0.22);
    g.generateTexture(key, t, t);
    g.destroy();
  }

  makeBolt(key, radius, glow, core) {
    const t = radius * 4;
    const c = t / 2;
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(glow, 0.3);
    g.fillCircle(c, c, radius * 1.8);
    g.fillStyle(glow, 0.7);
    g.fillCircle(c, c, radius * 1.1);
    g.fillStyle(core, 1);
    g.fillCircle(c, c, radius * 0.6);
    g.generateTexture(key, t, t);
    g.destroy();
  }

  // Faceted shard: an irregular polygon ring with an inner darker facet (rough-rock look).
  makeShard(key, radius, color) {
    const t = radius * 2.4;
    const c = t / 2;
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    const pts = [];
    const n = 9;
    let seed = Math.floor(radius * 7) + 3;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * Math.PI * 2;
      const rr = radius * (0.74 + rnd() * 0.26);
      pts.push({ x: c + Math.cos(ang) * rr, y: c + Math.sin(ang) * rr });
    }
    g.fillStyle(color, 0.18);
    this.poly(g, pts);
    g.fillPath();
    g.lineStyle(2, color, 1);
    this.poly(g, pts);
    g.strokePath();
    // a couple of inner facet lines for a crystalline read
    g.lineStyle(1, color, 0.5);
    g.beginPath();
    g.moveTo(pts[0].x, pts[0].y);
    g.lineTo(pts[3].x, pts[3].y);
    g.lineTo(pts[6].x, pts[6].y);
    g.strokePath();
    g.fillStyle(0xbff0ff, 0.12);
    g.fillCircle(c, c, radius * 0.3);
    g.generateTexture(key, t, t);
    g.destroy();
  }

  makeSaucer(key, radius) {
    const t = radius * 3;
    const c = t / 2;
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    // hull body (amber, hostile)
    g.fillStyle(0x5a3a10, 1);
    g.lineStyle(2, 0xffb15a, 1);
    g.fillEllipse(c, c + radius * 0.15, radius * 2, radius * 0.9);
    g.strokeEllipse(c, c + radius * 0.15, radius * 2, radius * 0.9);
    // dome
    g.fillStyle(0xffd9a0, 0.9);
    g.fillEllipse(c, c - radius * 0.2, radius * 0.9, radius * 0.7);
    g.fillStyle(0xfff0d0, 1);
    g.fillCircle(c, c - radius * 0.25, radius * 0.18);
    g.generateTexture(key, t, t);
    g.destroy();
  }

  poly(g, pts) {
    g.beginPath();
    g.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
    g.closePath();
  }
}
