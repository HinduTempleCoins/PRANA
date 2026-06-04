import Phaser from 'phaser';
import { GRID, GAME_WIDTH, GAME_HEIGHT, RULES, CRYPTO_BUILD, SETTLEMENT } from '../config.js';
import {
  LANE,
  buildBoard,
  stepPlayer,
  advanceOffset,
  occupiedColumns,
  carry,
  evaluateCell,
  forwardScore,
  alcoveScore,
  allAlcovesFilled,
  newAlcoveState,
} from '../logic/crossing.js';
import { requestScoreVoucher } from '../data/scoreVoucher.js';

export default class PlayScene extends Phaser.Scene {
  constructor() {
    super('Play');
  }

  init() {
    this.tier = 0;
    this.score = 0;
    this.lives = RULES.lives;
    this.timeLeft = RULES.runSeconds;
    this.gameOver = false;
    this.runStart = Date.now();
    this.laneOffsets = [];
    this.obstacleSprites = [];
    this.alcoveSprites = [];
  }

  create() {
    const skins = this.registry.get('skins') || [];
    const idx = this.registry.get('selectedSkinIndex') ?? 0;
    this.skin = skins[idx] || skins[0];

    this.startTier(0);
    this.buildHud();
    this.bindInput();

    // 1-second run countdown.
    this.time.addEvent({
      delay: 1000,
      loop: true,
      callback: () => {
        if (this.gameOver) return;
        this.timeLeft -= 1;
        if (this.timeLeft <= 0) {
          this.timeLeft = 0;
          this.endRun(false);
        }
        this.refreshHud();
      },
    });
  }

  // (Re)build the field for a difficulty tier and reset the hopper to the start bank.
  startTier(tier) {
    this.tier = tier;
    this.board = buildBoard(GRID.cols, GRID.rows, tier, RULES.seed);
    this.filled = newAlcoveState(RULES.alcoveCount);
    this.laneOffsets = this.board.lanes.map(() => 0);
    this.bestRow = this.board.startRow;

    this.drawBackground();
    this.buildObstacleSprites();
    this.buildAlcoveSprites();
    this.resetHopper();
  }

  resetHopper() {
    this.pos = { x: Math.floor(GRID.cols / 2), y: this.board.startRow };
    this.bestRow = this.board.startRow;
    if (this.hopper) this.hopper.destroy();
    this.hopper = this.add
      .image(this.px(this.pos.x), this.px(this.pos.y), `hopper_${this.skin.itemId}_${this.skin.shape}`)
      .setDepth(10);
  }

  // --- rendering --------------------------------------------------------------------- //
  drawBackground() {
    if (this.bgGroup) this.bgGroup.forEach((s) => s.destroy());
    this.bgGroup = [];
    for (let y = 0; y < GRID.rows; y++) {
      const lane = this.board.lanes[y];
      const key =
        lane.kind === LANE.WATER ? 'tile_water'
        : lane.kind === LANE.ROAD ? 'tile_road'
        : lane.kind === LANE.GOAL ? 'tile_goal'
        : 'tile_bank';
      for (let x = 0; x < GRID.cols; x++) {
        this.bgGroup.push(this.add.image(this.px(x), this.px(y), key).setDepth(0));
      }
    }
  }

  buildObstacleSprites() {
    this.obstacleSprites.forEach((s) => s.destroy());
    this.obstacleSprites = [];
    for (let y = 0; y < GRID.rows; y++) {
      const lane = this.board.lanes[y];
      if (lane.kind !== LANE.ROAD && lane.kind !== LANE.WATER) continue;
      const key = lane.kind === LANE.ROAD ? 'vehicle' : 'log';
      for (const o of lane.obstacles) {
        for (let i = 0; i < o.len; i++) {
          const spr = this.add.image(0, this.px(y), key).setDepth(2);
          spr._cellX = o.x + i;
          spr._laneY = y;
          this.obstacleSprites.push(spr);
        }
      }
    }
  }

  buildAlcoveSprites() {
    this.alcoveSprites.forEach((s) => s.destroy());
    this.alcoveSprites = [];
    this.board.alcoves.forEach((col, idx) => {
      const spr = this.add
        .image(this.px(col), this.px(this.board.goalRow), 'alcove_empty')
        .setDepth(1);
      spr._idx = idx;
      this.alcoveSprites.push(spr);
    });
  }

  px(cell) {
    return cell * GRID.tile + GRID.tile / 2;
  }

  buildHud() {
    const style = { fontFamily: 'system-ui, sans-serif', fontSize: '15px', color: '#cfe0ff' };
    this.hudScore = this.add.text(8, 6, '', style).setDepth(30);
    this.hudInfo = this.add.text(GAME_WIDTH - 8, 6, '', { ...style }).setOrigin(1, 0).setDepth(30);
    this.refreshHud();
  }

  refreshHud() {
    this.hudScore.setText(`Score ${this.score}`);
    this.hudInfo.setText(`♥ ${this.lives}  ·  ⏱ ${this.timeLeft}  ·  tier ${this.tier + 1}`);
  }

  // --- input ------------------------------------------------------------------------- //
  bindInput() {
    const k = this.input.keyboard;
    const map = { up: ['UP', 'W'], down: ['DOWN', 'S'], left: ['LEFT', 'A'], right: ['RIGHT', 'D'] };
    for (const [dir, codes] of Object.entries(map)) {
      for (const code of codes) {
        const key = k.addKey(Phaser.Input.Keyboard.KeyCodes[code]);
        key.on('down', () => this.hop(dir));
      }
    }
    this.input.on('pointerdown', (p) => {
      this.swipeStart = { x: p.x, y: p.y };
    });
    this.input.on('pointerup', (p) => {
      if (!this.swipeStart) return;
      const dx = p.x - this.swipeStart.x;
      const dy = p.y - this.swipeStart.y;
      this.swipeStart = null;
      if (Math.abs(dx) < 12 && Math.abs(dy) < 12) {
        if (this.gameOver) this.restart();
        return;
      }
      if (Math.abs(dx) > Math.abs(dy)) this.hop(dx > 0 ? 'right' : 'left');
      else this.hop(dy > 0 ? 'down' : 'up');
    });
  }

  // A single discrete hop. Resolves the destination cell, then immediately evaluates fate.
  hop(dir) {
    if (this.gameOver) return;
    const next = stepPlayer(this.pos, dir, GRID.cols, GRID.rows);
    this.pos = next;
    this.syncHopper();
    this.popHop();

    // Forward progress score (net-new highest row toward the goal).
    const gained = forwardScore(this.bestRow, this.pos.y, RULES.pointsPerRow);
    if (gained > 0) {
      this.score += gained;
      this.bestRow = this.pos.y;
    }
    this.evaluate();
    this.refreshHud();
  }

  syncHopper() {
    this.hopper.setPosition(this.px(this.pos.x), this.px(this.pos.y));
  }

  popHop() {
    const fx = this.add
      .image(this.px(this.pos.x), this.px(this.pos.y), `hopper_${this.skin.itemId}_${this.skin.shape}`)
      .setDepth(9)
      .setAlpha(0.5);
    this.tweens.add({
      targets: fx,
      scale: { from: 1, to: 1.6 },
      alpha: { from: 0.5, to: 0 },
      duration: 180,
      onComplete: () => fx.destroy(),
    });
  }

  // --- main loop --------------------------------------------------------------------- //
  update(_time, deltaMs) {
    if (this.gameOver) return;
    const dt = deltaMs / 1000;

    // Advance every lane's drift and reposition its obstacle sprites.
    for (let y = 0; y < GRID.rows; y++) {
      this.laneOffsets[y] = advanceOffset(this.laneOffsets[y], this.board.lanes[y], dt);
    }
    for (const spr of this.obstacleSprites) {
      const lane = this.board.lanes[spr._laneY];
      const shift = lane.dir * this.laneOffsets[spr._laneY];
      let wx = spr._cellX + shift;
      // wrap into visible range
      wx = ((wx % GRID.cols) + GRID.cols) % GRID.cols;
      spr.x = this.px(wx);
    }

    // While on the river, the player drifts with the log. We compute integer cell movement
    // from the lane offset delta and carry the hopper.
    const lane = this.board.lanes[this.pos.y];
    if (lane.kind === LANE.WATER) {
      const occ = occupiedColumns(lane, this.laneOffsets[this.pos.y], GRID.cols);
      if (occ.has(this.pos.x)) {
        // riding — drift continuously (sub-cell) by mirroring the lane shift on the sprite.
        const shift = lane.dir * (this.laneOffsets[this.pos.y] - (this._lastWaterOffset ?? this.laneOffsets[this.pos.y]));
        this.hopper.x += shift * GRID.tile;
        // snap player cell to the nearest column for logic, and drown if carried off-board.
        const cell = Math.round((this.hopper.x - GRID.tile / 2) / GRID.tile);
        if (cell < 0 || cell >= GRID.cols) {
          this.loseLife();
        } else {
          this.pos.x = cell;
        }
      } else {
        // fell in
        this.loseLife();
      }
      this._lastWaterOffset = this.laneOffsets[this.pos.y];
    } else {
      this._lastWaterOffset = undefined;
      this.evaluate();
    }
  }

  // Resolve the hopper's fate at its current cell against live lane state.
  evaluate() {
    if (this.gameOver) return;
    const lane = this.board.lanes[this.pos.y];
    const occ = occupiedColumns(lane, this.laneOffsets[this.pos.y] ?? 0, GRID.cols);
    const res = evaluateCell(this.pos, lane, occ, this.filled);
    if (res.outcome === 'dead') {
      this.loseLife();
    } else if (res.outcome === 'goal') {
      this.fillAlcove(res.alcoveIndex);
    }
  }

  fillAlcove(idx) {
    if (this.filled[idx]) {
      this.loseLife();
      return;
    }
    const before = this.filled.filter(Boolean).length;
    this.filled[idx] = true;
    this.score += alcoveScore(before, RULES.alcoveBase, RULES.alcoveBonus);
    const spr = this.alcoveSprites[idx];
    if (spr) spr.setTexture('alcove_full');
    this.cameras.main.flash(120, 60, 255, 160);

    if (allAlcovesFilled(this.filled)) {
      this.score += RULES.tierClearBonus;
      this.refreshHud();
      // advance a difficulty tier, fresh field.
      this.time.delayedCall(350, () => {
        if (!this.gameOver) this.startTier(this.tier + 1);
      });
    } else {
      this.resetHopper();
    }
    this.refreshHud();
  }

  loseLife() {
    if (this.gameOver) return;
    this.lives -= 1;
    this.cameras.main.shake(180, 0.012);
    this.refreshHud();
    if (this.lives <= 0) {
      this.endRun(false);
    } else {
      this.resetHopper();
    }
  }

  // --- end / settlement -------------------------------------------------------------- //
  async endRun() {
    this.gameOver = true;
    this.cameras.main.shake(240, 0.01);

    const overlay = this.add
      .rectangle(GAME_WIDTH / 2, GAME_HEIGHT / 2, GAME_WIDTH, GAME_HEIGHT, 0x000000, 0.74)
      .setDepth(40)
      .setInteractive();
    this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 - 56, 'RUN OVER', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '40px',
        color: '#ff6a7a',
        fontStyle: 'bold',
      })
      .setOrigin(0.5)
      .setDepth(41);
    this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 - 6, `Score ${this.score}  ·  tier ${this.tier + 1}`, {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '16px',
        color: '#cfe0ff',
      })
      .setOrigin(0.5)
      .setDepth(41);

    if (CRYPTO_BUILD) {
      const status = this.add
        .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 + 30, 'Settling score…', {
          fontFamily: 'system-ui, sans-serif',
          fontSize: '13px',
          color: '#7f97c8',
        })
        .setOrigin(0.5)
        .setDepth(41);
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
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 + 68, 'Click to play again', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '16px',
        color: '#05080f',
        backgroundColor: '#62d0ff',
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
    const seed = `${this.score}:${this.tier}:${this.lives}:${durationMs}`;
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
