import Phaser from 'phaser';
import { GRID, GAME_WIDTH, GAME_HEIGHT, RULES, CRYPTO_BUILD, SETTLEMENT } from '../config.js';
import {
  KIND,
  buildSchedule,
  classifyTap,
  applyAction,
  initialState,
} from '../logic/bop.js';
import { requestScoreVoucher } from '../data/scoreVoucher.js';

export default class PlayScene extends Phaser.Scene {
  constructor() {
    super('Play');
  }

  init() {
    this.state = initialState();
    this.gameOver = false;
    this.runStart = Date.now();
    this.elapsed = 0;
    // Each spawn gets an id so we can track which were already resolved/expired.
    this.nextSpawnIdx = 0;
    this.active = []; // [{ spawn, sprite, resolved }]
  }

  create() {
    const skins = this.registry.get('skins') || [];
    const idx = this.registry.get('selectedSkinIndex') ?? 0;
    this.skin = skins[idx] || skins[0];

    // Deterministic schedule for the whole round (seed + run start jitter for variety).
    const seed = (RULES.seed ^ (Date.now() & 0xffff)) >>> 0;
    this.schedule = buildSchedule(seed, RULES);

    this.drawBoard();
    this.buildHud();
  }

  // --- board ------------------------------------------------------------------------- //
  drawBoard() {
    this.moundSprites = [];
    for (let r = 0; r < GRID.rows; r++) {
      for (let c = 0; c < GRID.cols; c++) {
        const mound = r * GRID.cols + c;
        const { x, y } = this.moundCenter(mound);
        const m = this.add.image(x, y, 'mound').setDepth(1);
        m.setInteractive({ useHandCursor: true });
        m.on('pointerdown', () => this.tap(mound));
        this.moundSprites[mound] = m;
      }
    }
  }

  moundCenter(mound) {
    const c = mound % GRID.cols;
    const r = Math.floor(mound / GRID.cols);
    return {
      x: GRID.pad + c * GRID.cell + GRID.cell / 2,
      y: 60 + GRID.pad + r * GRID.cell + GRID.cell / 2,
    };
  }

  buildHud() {
    const style = { fontFamily: 'system-ui, sans-serif', fontSize: '16px', color: '#cfe0ff' };
    this.hudScore = this.add.text(GRID.pad, 18, '', style).setDepth(20);
    this.hudCombo = this.add.text(GAME_WIDTH / 2, 18, '', { ...style, color: '#ffd27f' }).setOrigin(0.5, 0).setDepth(20);
    this.hudTime = this.add.text(GAME_WIDTH - GRID.pad, 18, '', style).setOrigin(1, 0).setDepth(20);
    this.refreshHud();
  }

  refreshHud() {
    const left = Math.max(0, Math.ceil((RULES.roundMs - this.elapsed) / 1000));
    this.hudScore.setText(`Score ${this.state.score}`);
    this.hudCombo.setText(this.state.combo > 1 ? `combo x${this.state.combo}` : '');
    this.hudTime.setText(`⏱ ${left}`);
  }

  // --- input ------------------------------------------------------------------------- //
  tap(mound) {
    if (this.gameOver) return;
    const now = this.elapsed;
    const liveSpawns = this.active.filter((a) => !a.resolved).map((a) => a.spawn);
    const action = classifyTap(liveSpawns, mound, now);
    this.state = applyAction(this.state, action, RULES);

    if (action.type === 'miss') {
      this.flashMound(mound, 0xff5a6a, 0.25);
    } else {
      // resolve the matched active entry: remove its sprite.
      const entry = this.active.find((a) => !a.resolved && a.spawn === action.spawn);
      if (entry) {
        entry.resolved = true;
        this.popSpirit(entry, action.type);
      }
      if (action.type === 'lantern') {
        this.flashMound(mound, 0xffd27f, 0.4);
        this.cameras.main.shake(140, 0.008);
      }
    }
    this.refreshHud();
  }

  flashMound(mound, color, alpha) {
    const { x, y } = this.moundCenter(mound);
    const fx = this.add.rectangle(x, y, GRID.cell * 0.7, GRID.cell * 0.7, color, alpha).setDepth(5);
    this.tweens.add({ targets: fx, alpha: 0, duration: 200, onComplete: () => fx.destroy() });
  }

  popSpirit(entry, type) {
    const { x, y } = this.moundCenter(entry.spawn.mound);
    if (entry.sprite) {
      this.tweens.add({
        targets: entry.sprite,
        scale: { from: entry.sprite.scale, to: type === 'lantern' ? entry.sprite.scale : 0 },
        alpha: 0,
        duration: 160,
        onComplete: () => entry.sprite.destroy(),
      });
    }
    if (type === 'hit') {
      const burst = this.add.image(x, y - GRID.cell * 0.06, 'bop_fx').setDepth(8);
      this.tweens.add({
        targets: burst,
        scale: { from: 0.8, to: 1.8 },
        alpha: { from: 1, to: 0 },
        duration: 240,
        onComplete: () => burst.destroy(),
      });
    }
  }

  // --- main loop --------------------------------------------------------------------- //
  update(_time, deltaMs) {
    if (this.gameOver) return;
    this.elapsed += deltaMs;

    if (this.elapsed >= RULES.roundMs) {
      this.endRun();
      return;
    }

    // Spawn any scheduled pops whose time has arrived.
    while (
      this.nextSpawnIdx < this.schedule.length &&
      this.schedule[this.nextSpawnIdx].at <= this.elapsed
    ) {
      this.spawn(this.schedule[this.nextSpawnIdx]);
      this.nextSpawnIdx += 1;
    }

    // Retire spawns whose hit window has closed (an un-bopped spirit "sinks" = a miss only
    // if it was a spirit; an un-bopped lantern correctly leaving is fine).
    for (const a of this.active) {
      if (a.resolved) continue;
      if (this.elapsed >= a.spawn.at + a.spawn.window) {
        a.resolved = true;
        if (a.spawn.kind === KIND.SPIRIT) {
          // sank un-bopped: counts as a missed spirit (breaks combo).
          this.state = applyAction(this.state, { type: 'miss' }, RULES);
        }
        if (a.sprite) {
          this.tweens.add({
            targets: a.sprite,
            y: a.sprite.y + GRID.cell * 0.3,
            alpha: 0,
            duration: 160,
            onComplete: () => a.sprite.destroy(),
          });
        }
      }
    }
    this.active = this.active.filter((a) => !a.resolved || (a.sprite && a.sprite.active));

    this.refreshHud();
  }

  spawn(spawnDef) {
    const { x, y } = this.moundCenter(spawnDef.mound);
    const key =
      spawnDef.kind === KIND.LANTERN
        ? `lantern_${this.skin.itemId}`
        : `spirit_${this.skin.itemId}_${this.skin.face}`;
    const sprite = this.add.image(x, y + GRID.cell * 0.2, key).setDepth(4).setScale(0.2);
    // rise + scale up
    this.tweens.add({
      targets: sprite,
      y,
      scale: 0.92,
      duration: Math.min(180, spawnDef.window * 0.4),
      ease: 'Back.out',
    });
    this.active.push({ spawn: spawnDef, sprite, resolved: false });
  }

  // --- end / settlement -------------------------------------------------------------- //
  async endRun() {
    this.gameOver = true;

    const overlay = this.add
      .rectangle(GAME_WIDTH / 2, GAME_HEIGHT / 2, GAME_WIDTH, GAME_HEIGHT, 0x000000, 0.74)
      .setDepth(40)
      .setInteractive();
    this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 - 70, 'TIME!', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '42px',
        color: '#d6bfff',
        fontStyle: 'bold',
      })
      .setOrigin(0.5)
      .setDepth(41);
    this.add
      .text(
        GAME_WIDTH / 2,
        GAME_HEIGHT / 2 - 24,
        `Score ${this.state.score}  ·  ${this.state.hits} hits  ·  ${this.state.lanternHits} lantern slips`,
        { fontFamily: 'system-ui, sans-serif', fontSize: '14px', color: '#cfe0ff' },
      )
      .setOrigin(0.5)
      .setDepth(41);

    if (CRYPTO_BUILD) {
      const status = this.add
        .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 + 16, 'Settling score…', {
          fontFamily: 'system-ui, sans-serif',
          fontSize: '13px',
          color: '#9f7fc8',
        })
        .setOrigin(0.5)
        .setDepth(41);
      const voucher = await requestScoreVoucher({
        player: SETTLEMENT.player,
        score: this.state.score,
        runHash: this.computeRunHash(),
      });
      if (voucher) {
        const tag = voucher.fixture ? ' (demo)' : '';
        status.setText(`Reward voucher ready${tag} — claim in your wallet.`).setColor('#cbaaff');
      } else {
        status.setText('No settlement endpoint configured.').setColor('#6a548a');
      }
    }

    const retry = this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 + 56, 'Click to play again', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '16px',
        color: '#05080f',
        backgroundColor: '#b07fff',
        padding: { x: 16, y: 8 },
      })
      .setOrigin(0.5)
      .setDepth(41)
      .setInteractive({ useHandCursor: true });
    retry.on('pointerup', () => this.restart());
    overlay.on('pointerup', () => this.restart());
  }

  // Lightweight non-cryptographic integrity digest of the run.
  computeRunHash() {
    const durationMs = Date.now() - this.runStart;
    const seed = `${this.state.score}:${this.state.hits}:${this.state.misses}:${this.state.lanternHits}:${durationMs}`;
    let h = 0;
    for (let i = 0; i < seed.length; i++) {
      h = (h * 31 + seed.charCodeAt(i)) >>> 0;
    }
    return '0x' + h.toString(16).padStart(8, '0');
  }

  restart() {
    this.scene.start('Menu');
  }
}
