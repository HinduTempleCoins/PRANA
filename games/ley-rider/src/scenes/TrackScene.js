import Phaser from 'phaser';
import { GAME_WIDTH, GAME_HEIGHT, PHYSICS, DRAW } from '../config.js';
import {
  stepRider,
  isOffWorld,
  reachedFinish,
  LINE_NORMAL,
  LINE_BOOST,
} from '../logic/physics.js';
import {
  emptyTrack,
  simplifyPoints,
  pointsToLines,
  trackHash,
  saveTrack,
  loadTrack,
  listTracks,
  recordBestTime,
  getBestTime,
  exportTrack,
  importTrack,
} from '../logic/track.js';
import { postRun } from '../data/runVoucher.js';

const COLOR_NORMAL = 0x9fd0ff;
const COLOR_BOOST = 0xffb24d;
const FIXED_DT = 1 / 120; // physics fixed step (s)
const FINISH_RADIUS = 18;

export default class TrackScene extends Phaser.Scene {
  constructor() {
    super('Track');
  }

  create() {
    this.track = emptyTrack();
    this.mode = 'draw'; // 'draw' | 'ride'
    this.tool = LINE_NORMAL; // active draw line type, or 'erase' / 'start' / 'finish'
    this.placing = null; // 'start' | 'finish' | null

    // World camera: we render in world space; the camera scrolls. Pan offset lives in the
    // camera scroll, so draw/erase must convert pointer -> world coords.
    this.cam = this.cameras.main;
    this.cam.setBackgroundColor('#070b16');

    this.gfx = this.add.graphics(); // track + flags (world space)
    this.gridGfx = this.add.graphics().setScrollFactor(0.0); // subtle parallax grid drawn in update

    this.sled = this.add.image(0, 0, 'sled').setVisible(false).setDepth(10);

    // Drawing state.
    this.drawing = false;
    this.curPoints = [];
    this.panning = false;
    this.panStart = null;

    // Rider physics state.
    this.rider = null;
    this.runStartMs = 0;
    this.runDistance = 0;
    this.lastRiderPos = null;
    this.accumulator = 0;

    this.setupInput();
    this.buildHud();
    this.seedDemoTrack();
    this.redraw();
  }

  // A tiny starter ramp so the canvas isn't empty on first load.
  seedDemoTrack() {
    const pts = [];
    for (let x = 0; x <= 600; x += 30) {
      pts.push([100 + x, 180 + Math.sin(x / 120) * 40 + x * 0.25]);
    }
    this.track.lines = pointsToLines(pts, LINE_NORMAL);
    this.track.start = [110, 170];
  }

  // ----------------------------------------------------------------------------------- //
  //  Input
  // ----------------------------------------------------------------------------------- //
  setupInput() {
    const kb = this.input.keyboard;
    this.keys = kb.addKeys({ space: 'SPACE' });

    kb.on('keydown-B', () => this.mode === 'draw' && this.setTool('boost'));
    kb.on('keydown-N', () => this.mode === 'draw' && this.setTool('normal'));
    kb.on('keydown-E', () => this.mode === 'draw' && this.setTool('erase'));
    kb.on('keydown-S', (e) => {
      if (e.ctrlKey || e.metaKey) return this.doSave();
      if (this.mode === 'draw') this.beginPlace('start');
      return undefined;
    });
    kb.on('keydown-F', () => this.mode === 'draw' && this.beginPlace('finish'));
    kb.on('keydown-ENTER', () => this.toggleMode());
    kb.on('keydown-L', (e) => (e.ctrlKey || e.metaKey) && this.doLoad());
    kb.on('keydown-X', (e) => (e.ctrlKey || e.metaKey) && this.doExport());
    kb.on('keydown-I', (e) => (e.ctrlKey || e.metaKey) && this.doImport());
    kb.on('keydown-C', () => this.mode === 'draw' && this.clearTrack());

    this.input.on('pointerdown', (p) => this.onPointerDown(p));
    this.input.on('pointermove', (p) => this.onPointerMove(p));
    this.input.on('pointerup', (p) => this.onPointerUp(p));
  }

  setTool(name) {
    this.placing = null;
    if (name === 'boost') this.tool = LINE_BOOST;
    else if (name === 'normal') this.tool = LINE_NORMAL;
    else this.tool = name; // 'erase'
    this.updateHud();
  }

  beginPlace(which) {
    this.placing = which;
    this.updateHud();
  }

  toScreenToWorld(p) {
    return { x: p.x + this.cam.scrollX, y: p.y + this.cam.scrollY };
  }

  onPointerDown(p) {
    if (this.mode === 'ride') return;
    const w = this.toScreenToWorld(p);

    // Pan: right button OR space held.
    if (p.rightButtonDown() || this.keys.space.isDown) {
      this.panning = true;
      this.panStart = { x: p.x, y: p.y, sx: this.cam.scrollX, sy: this.cam.scrollY };
      return;
    }

    if (this.placing === 'start') {
      this.track.start = [w.x, w.y];
      this.placing = null;
      this.afterEdit();
      return;
    }
    if (this.placing === 'finish') {
      this.track.finish = [w.x, w.y];
      this.placing = null;
      this.afterEdit();
      return;
    }
    if (this.tool === 'erase') {
      this.eraseAt(w.x, w.y);
      this.drawing = true; // allow drag-erase
      return;
    }
    // Begin a polyline.
    this.drawing = true;
    this.curPoints = [[w.x, w.y]];
  }

  onPointerMove(p) {
    if (this.panning) {
      this.cam.scrollX = this.panStart.sx - (p.x - this.panStart.x);
      this.cam.scrollY = this.panStart.sy - (p.y - this.panStart.y);
      return;
    }
    if (!this.drawing || this.mode === 'ride') return;
    const w = this.toScreenToWorld(p);
    if (this.tool === 'erase') {
      this.eraseAt(w.x, w.y);
      return;
    }
    const last = this.curPoints[this.curPoints.length - 1];
    const dx = w.x - last[0];
    const dy = w.y - last[1];
    if (dx * dx + dy * dy >= DRAW.minPointDist * DRAW.minPointDist) {
      this.curPoints.push([w.x, w.y]);
      this.redraw(); // live preview
    }
  }

  onPointerUp() {
    if (this.panning) {
      this.panning = false;
      return;
    }
    if (!this.drawing) return;
    this.drawing = false;
    if (this.tool === 'erase') {
      this.afterEdit();
      return;
    }
    if (this.curPoints.length >= 2) {
      const simplified = simplifyPoints(this.curPoints, DRAW.minPointDist);
      const type = this.tool === LINE_BOOST ? LINE_BOOST : LINE_NORMAL;
      this.track.lines.push(...pointsToLines(simplified, type));
    }
    this.curPoints = [];
    this.afterEdit();
  }

  eraseAt(x, y) {
    const r2 = DRAW.eraseRadius * DRAW.eraseRadius;
    this.track.lines = this.track.lines.filter((l) => {
      const mx = (l[0] + l[2]) / 2;
      const my = (l[1] + l[3]) / 2;
      const dx = mx - x;
      const dy = my - y;
      return dx * dx + dy * dy > r2;
    });
    this.redraw();
  }

  clearTrack() {
    this.track.lines = [];
    this.afterEdit();
  }

  afterEdit() {
    this.redraw();
    this.updateHud();
  }

  // ----------------------------------------------------------------------------------- //
  //  Mode switching
  // ----------------------------------------------------------------------------------- //
  toggleMode() {
    if (this.mode === 'draw') this.startRide();
    else this.stopRide();
  }

  startRide() {
    if (!this.track.start) {
      this.flash('place a start flag first ([S])');
      return;
    }
    this.mode = 'ride';
    this.rider = {
      x: this.track.start[0],
      y: this.track.start[1] - PHYSICS.spawnDrop,
      vx: 0,
      vy: 0,
    };
    this.lastRiderPos = { x: this.rider.x, y: this.rider.y };
    this.runDistance = 0;
    this.runStartMs = this.time.now;
    this.accumulator = 0;
    this.sled.setVisible(true);
    this.cam.startFollow(this.sled, true, 0.12, 0.12);
    this.updateHud();
  }

  stopRide() {
    this.mode = 'draw';
    this.rider = null;
    this.sled.setVisible(false);
    this.cam.stopFollow();
    this.updateHud();
  }

  async finishRun(finished) {
    const timeMs = this.time.now - this.runStartMs;
    const hash = trackHash(this.track);
    let best = null;
    if (finished) best = recordBestTime(hash, timeMs);
    this.stopRide();

    const summary = finished
      ? `FINISH! ${(timeMs / 1000).toFixed(2)}s  (best ${(best / 1000).toFixed(2)}s)`
      : `run over — distance ${Math.round(this.runDistance)}`;
    this.flash(summary, 2500);

    // Best-effort settlement (no-op / stub in clean build).
    try {
      const voucher = await postRun({
        finished,
        timeMs,
        distance: this.runDistance,
        trackHash: hash,
      });
      if (voucher && voucher.stub === false) this.flash('run submitted', 1500);
    } catch {
      /* settlement must never break play */
    }
  }

  // ----------------------------------------------------------------------------------- //
  //  Update loop
  // ----------------------------------------------------------------------------------- //
  update(time, delta) {
    if (this.mode !== 'ride' || !this.rider) {
      // Allow keyboard panning even when idle.
      return;
    }

    // Fixed-step integration for determinism regardless of frame rate.
    this.accumulator += Math.min(delta / 1000, 0.05); // clamp huge frame gaps
    while (this.accumulator >= FIXED_DT) {
      const next = stepRider(this.rider, this.track.lines, FIXED_DT, PHYSICS);
      this.rider = { x: next.x, y: next.y, vx: next.vx, vy: next.vy };
      this.accumulator -= FIXED_DT;
    }

    // Distance ridden (score).
    const dx = this.rider.x - this.lastRiderPos.x;
    const dy = this.rider.y - this.lastRiderPos.y;
    this.runDistance += Math.hypot(dx, dy);
    this.lastRiderPos = { x: this.rider.x, y: this.rider.y };

    // Orient + position the sled sprite.
    this.sled.setPosition(this.rider.x, this.rider.y);
    const speed = Math.hypot(this.rider.vx, this.rider.vy);
    if (speed > 1) this.sled.setRotation(Math.atan2(this.rider.vy, this.rider.vx));

    // End conditions.
    if (
      reachedFinish(this.rider.x, this.rider.y, this.track.finish, FINISH_RADIUS)
    ) {
      this.finishRun(true);
      return;
    }
    if (
      isOffWorld(
        this.rider.y,
        this.track.lines,
        PHYSICS,
        this.track.start ? this.track.start[1] : 0,
        this.track.finish ? this.track.finish[1] : 0,
      )
    ) {
      this.finishRun(false);
    }
  }

  // ----------------------------------------------------------------------------------- //
  //  Rendering
  // ----------------------------------------------------------------------------------- //
  redraw() {
    const g = this.gfx;
    g.clear();

    // Committed lines.
    for (const [x1, y1, x2, y2, type] of this.track.lines) {
      g.lineStyle(4, type === LINE_BOOST ? COLOR_BOOST : COLOR_NORMAL, 1);
      g.beginPath();
      g.moveTo(x1, y1);
      g.lineTo(x2, y2);
      g.strokePath();
    }

    // Live preview of the in-progress stroke.
    if (this.drawing && this.curPoints.length >= 2 && this.tool !== 'erase') {
      g.lineStyle(3, this.tool === LINE_BOOST ? COLOR_BOOST : COLOR_NORMAL, 0.6);
      g.beginPath();
      g.moveTo(this.curPoints[0][0], this.curPoints[0][1]);
      for (let i = 1; i < this.curPoints.length; i++) {
        g.lineTo(this.curPoints[i][0], this.curPoints[i][1]);
      }
      g.strokePath();
    }

    // Flags.
    if (this.track.start) this.drawFlag(g, this.track.start, 0x49d17a);
    if (this.track.finish) this.drawFlag(g, this.track.finish, 0xff6f6f);
  }

  drawFlag(g, pos, color) {
    const [x, y] = pos;
    g.lineStyle(2, 0xdfe9ff, 1);
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x, y - 34);
    g.strokePath();
    g.fillStyle(color, 1);
    g.fillTriangle(x, y - 34, x + 20, y - 28, x, y - 22);
  }

  // ----------------------------------------------------------------------------------- //
  //  HUD
  // ----------------------------------------------------------------------------------- //
  buildHud() {
    const style = { fontFamily: 'monospace', fontSize: '14px', color: '#bcd2ff' };
    this.hud = this.add.text(10, 10, '', style).setScrollFactor(0).setDepth(100);
    this.toast = this.add
      .text(GAME_WIDTH / 2, 40, '', { ...style, color: '#ffe680', fontSize: '16px' })
      .setOrigin(0.5, 0)
      .setScrollFactor(0)
      .setDepth(100);
    this.updateHud();
  }

  updateHud() {
    let toolName = this.tool === LINE_BOOST ? 'BOOST line' : this.tool === 'erase' ? 'ERASER' : 'normal line';
    if (this.placing) toolName = `placing ${this.placing} flag (click)`;
    const hash = trackHash(this.track);
    const best = getBestTime(hash);
    const lines = [
      `mode: ${this.mode.toUpperCase()}   tool: ${toolName}   lines: ${this.track.lines.length}`,
      `trackHash: ${hash.slice(0, 18)}…   best: ${best != null ? (best / 1000).toFixed(2) + 's' : '—'}`,
      this.mode === 'ride' ? `dist: ${Math.round(this.runDistance)}   t: ${((this.time.now - this.runStartMs) / 1000).toFixed(2)}s` : '[Enter] ride · [B]oost [N]ormal [E]raser [S]tart [F]inish · space-drag pan',
    ];
    if (this.hud) this.hud.setText(lines.join('\n'));
  }

  flash(msg, ms = 1800) {
    this.toast.setText(msg);
    this.time.delayedCall(ms, () => this.toast.setText(''));
  }

  // ----------------------------------------------------------------------------------- //
  //  Persistence UI (prompt-based; minimal, no DOM framework)
  // ----------------------------------------------------------------------------------- //
  doSave() {
    const name = typeof prompt === 'function' ? prompt('Save track as:', 'my-track') : 'my-track';
    if (!name) return;
    saveTrack(name, this.track);
    this.flash(`saved "${name}"`);
  }

  doLoad() {
    const names = listTracks();
    if (!names.length) return this.flash('no saved tracks');
    const name =
      typeof prompt === 'function' ? prompt(`Load which?\n${names.join(', ')}`, names[0]) : names[0];
    if (!name) return undefined;
    const t = loadTrack(name);
    if (t) {
      this.track = t;
      this.afterEdit();
      this.flash(`loaded "${name}"`);
    }
    return undefined;
  }

  doExport() {
    const json = exportTrack(this.track);
    if (typeof prompt === 'function') prompt('Track JSON (copy):', json);
    this.flash('exported');
  }

  doImport() {
    const json = typeof prompt === 'function' ? prompt('Paste track JSON:') : null;
    if (!json) return;
    try {
      this.track = importTrack(json);
      this.afterEdit();
      this.flash('imported');
    } catch {
      this.flash('bad JSON');
    }
  }
}
