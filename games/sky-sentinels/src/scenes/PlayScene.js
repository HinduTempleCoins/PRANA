import Phaser from 'phaser';
import { GAME_WIDTH, GAME_HEIGHT, RULES, CRYPTO_BUILD, SETTLEMENT } from '../config.js';
import {
  makeFormation,
  cellPos,
  liveCount,
  lowestLiveY,
  stepInterval,
  stepFormation,
  boltHitsSentinel,
  killSentinel,
  rowScoreFor,
  chooseEnemyShot,
  makeCovers,
  boltHitsCover,
  erodeCover,
  stepVerticalBolts,
  clampPlayerX,
  enemyBoltHitsPlayer,
} from '../logic/sentinels.js';
import { requestScoreVoucher } from '../data/scoreVoucher.js';

const W = GAME_WIDTH;
const H = GAME_HEIGHT;

export default class PlayScene extends Phaser.Scene {
  constructor() {
    super('Play');
  }

  init() {
    this.score = 0;
    this.lives = RULES.lives;
    this.wave = 1;
    this.gameOver = false;
    this.runStart = Date.now();

    this.formation = makeFormation(RULES.grid);
    this.covers = makeCovers(RULES.cover, W);
    this.playerX = W / 2;
    this.pBolts = []; // player bolts {x,y,vy}
    this.eBolts = []; // enemy bolts {x,y,vy}
    this.lastFire = -9999;
    this.stepAcc = 0;

    this.sentinelSprites = [];
    this.coverSprites = [];
    this.pBoltSprites = [];
    this.eBoltSprites = [];
  }

  create() {
    this.add.image(W / 2, H / 2, 'star_field').setDepth(0);

    // build sentinel sprite grid
    for (const s of this.formation.sentinels) {
      const spr = this.add.image(0, 0, `sentinel_${s.row}`).setDepth(4);
      this.sentinelSprites.push(spr);
    }
    for (let i = 0; i < this.covers.length; i++) {
      this.coverSprites.push(this.add.image(this.covers[i].x, this.covers[i].y, `cover_${this.covers[i].cells}`).setDepth(3));
    }

    this.playerSprite = this.add.image(this.playerX, RULES.player.y, 'player').setDepth(6);

    const style = { fontFamily: 'system-ui, sans-serif', fontSize: '15px', color: '#cfe0ff' };
    this.hudScore = this.add.text(10, 6, '', style).setDepth(20);
    this.hudInfo = this.add.text(W - 200, 6, '', style).setDepth(20);
    this.refreshHud();

    this.cursors = this.input.keyboard.createCursorKeys();
    this.keyA = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.A);
    this.keyD = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.D);
    this.keyFire = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);
    this.keyFire.on('down', () => this.tryFire());

    this.input.on('pointerup', () => {
      if (this.gameOver) this.restart();
    });

    this.renderFormation();
  }

  refreshHud() {
    this.hudScore.setText(`Score ${this.score}`);
    this.hudInfo.setText(`Lives ${this.lives}  ·  Wave ${this.wave}`);
  }

  tryFire() {
    if (this.gameOver) return;
    const now = performance.now();
    if (now - this.lastFire < RULES.player.cooldownMs) return;
    // one player bolt on screen at a time (classic feel)
    if (this.pBolts.length > 0) return;
    this.lastFire = now;
    this.pBolts.push({ x: this.playerX, y: RULES.player.y - 16, vy: -RULES.player.boltSpeed });
  }

  update(_time, deltaMs) {
    if (this.gameOver) return;
    const dt = Math.min(deltaMs, 50) / 1000;

    // --- player movement ---
    let dx = 0;
    if (this.cursors.left.isDown || this.keyA.isDown) dx -= 1;
    if (this.cursors.right.isDown || this.keyD.isDown) dx += 1;
    this.playerX = clampPlayerX(this.playerX + dx * RULES.player.speed * dt, RULES.player, W);

    // --- formation stepping ---
    this.stepAcc += deltaMs;
    const interval = stepInterval(this.formation, RULES.grid, RULES.step, this.wave);
    while (this.stepAcc >= interval) {
      this.stepAcc -= interval;
      this.formation = stepFormation(this.formation, RULES.grid, W);
      // a chance to fire on each step
      if (this.eBolts.length < RULES.enemyBolt.maxOnScreen) {
        const origin = chooseEnemyShot(this.formation, RULES.grid, RULES.enemyBolt.dropChancePerStep);
        if (origin) this.eBolts.push({ x: origin.x, y: origin.y, vy: RULES.enemyBolt.speed });
      }
      // landed? -> game over
      if (lowestLiveY(this.formation, RULES.grid) >= RULES.landingY) {
        this.die();
        return;
      }
    }

    // --- bolts ---
    this.pBolts = stepVerticalBolts(this.pBolts, dt, H);
    this.eBolts = stepVerticalBolts(this.eBolts, dt, H);

    // --- player bolt vs cover, then vs sentinel ---
    for (let i = this.pBolts.length - 1; i >= 0; i--) {
      const b = this.pBolts[i];
      const cvIdx = boltHitsCover({ x: b.x, y: b.y }, 3, this.covers, RULES.cover);
      if (cvIdx !== -1) {
        this.covers = erodeCover(this.covers, cvIdx);
        this.pBolts.splice(i, 1);
        this.updateCoverSprite(cvIdx);
        continue;
      }
      const sIdx = boltHitsSentinel({ x: b.x, y: b.y }, 3, this.formation, RULES.grid);
      if (sIdx !== -1) {
        const sent = this.formation.sentinels[sIdx];
        this.score += rowScoreFor(sent.row, RULES.rowScore);
        this.popAt(cellPos(sent.col, sent.row, this.formation.offsetX, this.formation.offsetY, RULES.grid));
        this.formation = killSentinel(this.formation, sIdx);
        this.pBolts.splice(i, 1);
        this.refreshHud();
      }
    }

    // --- enemy bolt vs cover, then vs player ---
    for (let i = this.eBolts.length - 1; i >= 0; i--) {
      const b = this.eBolts[i];
      const cvIdx = boltHitsCover({ x: b.x, y: b.y }, 3, this.covers, RULES.cover);
      if (cvIdx !== -1) {
        this.covers = erodeCover(this.covers, cvIdx);
        this.eBolts.splice(i, 1);
        this.updateCoverSprite(cvIdx);
        continue;
      }
      if (enemyBoltHitsPlayer({ x: b.x, y: b.y }, this.playerX, RULES.player)) {
        this.eBolts.splice(i, 1);
        this.loseLife();
        if (this.gameOver) return;
      }
    }

    // --- wave clear ---
    if (liveCount(this.formation) === 0) {
      this.wave += 1;
      this.formation = makeFormation(RULES.grid);
      this.covers = makeCovers(RULES.cover, W); // fresh cover each wave
      this.eBolts = [];
      this.rebuildSentinelSprites();
      this.rebuildCoverSprites();
      this.refreshHud();
    }

    this.render();
  }

  loseLife() {
    this.lives -= 1;
    this.cameras.main.shake(220, 0.012);
    this.refreshHud();
    if (this.lives <= 0) {
      this.die();
      return;
    }
    this.playerX = W / 2;
  }

  // --- rendering --------------------------------------------------------------------- //
  render() {
    this.playerSprite.setPosition(this.playerX, RULES.player.y);
    this.renderFormation();
    this.syncVBolts(this.pBolts, this.pBoltSprites, 'p_bolt');
    this.syncVBolts(this.eBolts, this.eBoltSprites, 'e_bolt');
  }

  renderFormation() {
    for (let i = 0; i < this.formation.sentinels.length; i++) {
      const s = this.formation.sentinels[i];
      const spr = this.sentinelSprites[i];
      if (!s.alive) {
        spr.setVisible(false);
        continue;
      }
      const c = cellPos(s.col, s.row, this.formation.offsetX, this.formation.offsetY, RULES.grid);
      spr.setVisible(true).setPosition(c.x, c.y);
    }
  }

  rebuildSentinelSprites() {
    for (const spr of this.sentinelSprites) spr.destroy();
    this.sentinelSprites = [];
    for (const s of this.formation.sentinels) {
      this.sentinelSprites.push(this.add.image(0, 0, `sentinel_${s.row}`).setDepth(4));
    }
    this.renderFormation();
  }

  rebuildCoverSprites() {
    for (const spr of this.coverSprites) spr.destroy();
    this.coverSprites = [];
    for (let i = 0; i < this.covers.length; i++) {
      this.coverSprites.push(this.add.image(this.covers[i].x, this.covers[i].y, `cover_${this.covers[i].cells}`).setDepth(3));
    }
  }

  updateCoverSprite(idx) {
    const cv = this.covers[idx];
    const spr = this.coverSprites[idx];
    if (cv.cells <= 0) spr.setVisible(false);
    else spr.setTexture(`cover_${cv.cells}`);
  }

  syncVBolts(bolts, pool, key) {
    while (pool.length < bolts.length) pool.push(this.add.image(0, 0, key).setDepth(5));
    while (pool.length > bolts.length) pool.pop().destroy();
    for (let i = 0; i < bolts.length; i++) pool[i].setPosition(bolts[i].x, bolts[i].y);
  }

  popAt(pos) {
    const fx = this.add.image(pos.x, pos.y, 'p_bolt').setDepth(8).setTint(0xbff0ff);
    this.tweens.add({
      targets: fx,
      scale: { from: 1, to: 4 },
      alpha: { from: 0.9, to: 0 },
      duration: 240,
      ease: 'Quad.out',
      onComplete: () => fx.destroy(),
    });
  }

  // --- death / settlement ------------------------------------------------------------ //
  async die() {
    if (this.gameOver) return;
    this.gameOver = true;
    this.cameras.main.shake(300, 0.02);

    const overlay = this.add
      .rectangle(W / 2, H / 2, W, H, 0x000000, 0.72)
      .setDepth(30)
      .setInteractive();
    this.add
      .text(W / 2, H / 2 - 60, 'GAME OVER', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '42px',
        color: '#ff6a7a',
        fontStyle: 'bold',
      })
      .setOrigin(0.5)
      .setDepth(31);
    this.add
      .text(W / 2, H / 2 - 10, `Score ${this.score}  ·  reached wave ${this.wave}`, {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '16px',
        color: '#cfe0ff',
      })
      .setOrigin(0.5)
      .setDepth(31);

    // Settlement (crypto build only). The clean build dead-code-eliminates this whole path.
    if (CRYPTO_BUILD) {
      const status = this.add
        .text(W / 2, H / 2 + 30, 'Settling score…', {
          fontFamily: 'system-ui, sans-serif',
          fontSize: '13px',
          color: '#7f97c8',
        })
        .setOrigin(0.5)
        .setDepth(31);
      const voucher = await requestScoreVoucher({
        player: SETTLEMENT.player,
        score: this.score,
        runHash: this.computeRunHash(),
      });
      if (voucher) {
        const tag = voucher.fixture ? ' (demo)' : '';
        status.setText(`Reward voucher ready${tag} — claim in your wallet.`).setColor('#9be4ff');
      } else {
        status.setText('No settlement endpoint configured.').setColor('#54689a');
      }
    }

    const retry = this.add
      .text(W / 2, H / 2 + 74, 'Click to play again', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '16px',
        color: '#04060e',
        backgroundColor: '#62d0ff',
        padding: { x: 16, y: 8 },
      })
      .setOrigin(0.5)
      .setDepth(31)
      .setInteractive({ useHandCursor: true });
    retry.on('pointerup', () => this.restart());
    overlay.on('pointerup', () => this.restart());
  }

  // Lightweight non-cryptographic integrity digest of the run. The attester re-derives /
  // re-checks server-side; this only has to be a stable per-run reference, not secure.
  computeRunHash() {
    const durationMs = Date.now() - this.runStart;
    const seed = `${this.score}:${this.wave}:${this.lives}:${durationMs}`;
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
