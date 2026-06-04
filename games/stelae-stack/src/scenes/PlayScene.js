import Phaser from 'phaser';
import { GRID, GAME_WIDTH, GAME_HEIGHT, RULES, CRYPTO_BUILD, SETTLEMENT } from '../config.js';
import {
  emptyWell,
  pieceCells,
  tryMove,
  tryRotate,
  hardDropPos,
  lockPiece,
  clearLines,
  lineScore,
  dropScore,
  nextCombo,
  levelForLines,
  gravityInterval,
  spawnPos,
  randomPiece,
  isToppedOut,
} from '../logic/stack.js';
import { hexToInt } from '../data/skins.js';
import { requestScoreVoucher } from '../data/scoreVoucher.js';

export default class PlayScene extends Phaser.Scene {
  constructor() {
    super('Play');
  }

  init() {
    this.well = emptyWell(GRID.cols, GRID.rows);
    this.score = 0;
    this.lines = 0;
    this.level = 0;
    this.combo = -1; // -1 => no active combo
    this.acc = 0;
    this.lockTimer = 0;
    this.landed = false;
    this.gameOver = false;
    this.runStart = Date.now();
    this.nextKey = randomPiece();
    this.cellSprites = [];
    this.activeSprites = [];
    this.ghostSprites = [];
  }

  create() {
    const skins = this.registry.get('skins') || [];
    const idx = this.registry.get('selectedSkinIndex') ?? 0;
    this.skin = skins[idx] || skins[0];

    this.drawBackground();
    this.buildHud();
    this.spawnPiece();
    this.bindInput();
  }

  // --- rendering --------------------------------------------------------------------- //
  drawBackground() {
    for (let r = 0; r < GRID.rows; r++) {
      for (let c = 0; c < GRID.cols; c++) {
        this.add.image(this.px(c), this.px(r), `well_${this.skin.itemId}`).setDepth(0);
      }
    }
    // well border (right edge of the playfield, dividing it from the HUD gutter)
    const wellW = GRID.cols * GRID.tile;
    this.add
      .rectangle(wellW / 2, GAME_HEIGHT / 2, wellW - 2, GAME_HEIGHT - 2)
      .setStrokeStyle(2, hexToInt(this.skin.palette.glow), 0.35)
      .setDepth(1);
  }

  px(cell) {
    return cell * GRID.tile + GRID.tile / 2;
  }

  buildHud() {
    const gx = GRID.cols * GRID.tile + 12;
    const style = { fontFamily: 'system-ui, sans-serif', fontSize: '13px', color: '#cfe0ff' };
    this.hudScore = this.add.text(gx, 12, '', style).setDepth(10);
    this.hudLines = this.add.text(gx, 36, '', style).setDepth(10);
    this.hudLevel = this.add.text(gx, 60, '', style).setDepth(10);
    this.hudCombo = this.add.text(gx, 84, '', style).setDepth(10);
    this.add.text(gx, 120, 'NEXT', { ...style, color: '#54689a' }).setDepth(10);
    this.refreshHud();
  }

  refreshHud() {
    this.hudScore.setText(`Score\n${this.score}`);
    this.hudLines.setText(`Lines ${this.lines}`);
    this.hudLevel.setText(`Level ${this.level + 1}`);
    this.hudCombo.setText(this.combo > 0 ? `Combo ${this.combo}` : '');
  }

  // --- piece lifecycle --------------------------------------------------------------- //
  spawnPiece() {
    this.pieceKey = this.nextKey;
    this.nextKey = randomPiece();
    this.rot = 0;
    this.pos = spawnPos(this.pieceKey, GRID.cols);
    this.landed = false;
    this.lockTimer = 0;

    if (isToppedOut(this.well, this.pieceKey, GRID.cols, GRID.rows)) {
      this.die();
      return;
    }
    this.renderActive();
    this.renderNext();
  }

  // Redraw the static well (locked cells).
  renderWell() {
    // pool of sprites for the locked stack
    const occupied = [];
    for (let y = 0; y < GRID.rows; y++) {
      for (let x = 0; x < GRID.cols; x++) {
        const cell = this.well[y][x];
        if (cell !== 0) occupied.push({ x, y, key: cell });
      }
    }
    while (this.cellSprites.length < occupied.length) {
      this.cellSprites.push(this.add.image(0, 0, 'block_OBELISK').setDepth(3));
    }
    while (this.cellSprites.length > occupied.length) {
      this.cellSprites.pop().destroy();
    }
    occupied.forEach((o, i) => {
      this.cellSprites[i]
        .setTexture(`block_${o.key}`)
        .setPosition(this.px(o.x), this.px(o.y))
        .setAlpha(1)
        .setVisible(true);
    });
  }

  renderActive() {
    const cells = pieceCells(this.pieceKey, this.rot, this.pos);
    while (this.activeSprites.length < cells.length) {
      this.activeSprites.push(this.add.image(0, 0, `block_${this.pieceKey}`).setDepth(5));
    }
    while (this.activeSprites.length > cells.length) {
      this.activeSprites.pop().destroy();
    }
    cells.forEach((c, i) => {
      this.activeSprites[i]
        .setTexture(`block_${this.pieceKey}`)
        .setPosition(this.px(c.x), this.px(c.y))
        .setVisible(c.y >= 0);
    });
    this.renderGhost();
  }

  // Hard-drop landing preview.
  renderGhost() {
    const { pos } = hardDropPos(this.well, this.pieceKey, this.rot, this.pos, GRID.cols, GRID.rows);
    const cells = pieceCells(this.pieceKey, this.rot, pos);
    while (this.ghostSprites.length < cells.length) {
      this.ghostSprites.push(this.add.image(0, 0, 'block_ghost').setDepth(2));
    }
    while (this.ghostSprites.length > cells.length) {
      this.ghostSprites.pop().destroy();
    }
    cells.forEach((c, i) => {
      this.ghostSprites[i].setPosition(this.px(c.x), this.px(c.y)).setVisible(c.y >= 0);
    });
  }

  renderNext() {
    if (this.nextSprites) this.nextSprites.forEach((s) => s.destroy());
    this.nextSprites = [];
    const cells = pieceCells(this.nextKey, 0, { x: 0, y: 0 });
    const baseX = GRID.cols * GRID.tile + 16;
    const baseY = 150;
    const t = GRID.tile * 0.7;
    cells.forEach((c) => {
      const s = this.add
        .image(baseX + c.x * t + t / 2, baseY + c.y * t + t / 2, `block_${this.nextKey}`)
        .setDisplaySize(t - 2, t - 2)
        .setDepth(10);
      this.nextSprites.push(s);
    });
  }

  // --- input ------------------------------------------------------------------------- //
  bindInput() {
    const k = this.input.keyboard;
    this.keyLeft = k.addKey(Phaser.Input.Keyboard.KeyCodes.LEFT);
    this.keyRight = k.addKey(Phaser.Input.Keyboard.KeyCodes.RIGHT);
    this.keyDown = k.addKey(Phaser.Input.Keyboard.KeyCodes.DOWN);
    this.keyUp = k.addKey(Phaser.Input.Keyboard.KeyCodes.UP);
    this.keyZ = k.addKey(Phaser.Input.Keyboard.KeyCodes.Z);
    this.keyX = k.addKey(Phaser.Input.Keyboard.KeyCodes.X);
    this.keySpace = k.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);

    this.keyLeft.on('down', () => this.move(-1));
    this.keyRight.on('down', () => this.move(1));
    this.keyUp.on('down', () => this.rotate(1));
    this.keyZ.on('down', () => this.rotate(-1));
    this.keyX.on('down', () => this.rotate(1));
    this.keySpace.on('down', () => this.hardDrop());

    // tap to restart on game-over.
    this.input.on('pointerup', () => {
      if (this.gameOver) this.restart();
    });
  }

  move(dx) {
    if (this.gameOver) return;
    const next = tryMove(this.well, this.pieceKey, this.rot, this.pos, dx, 0, GRID.cols, GRID.rows);
    if (next) {
      this.pos = next;
      this.resetLockIfLanded();
      this.renderActive();
    }
  }

  rotate(dir) {
    if (this.gameOver) return;
    const r = tryRotate(this.well, this.pieceKey, this.rot, this.pos, dir, GRID.cols, GRID.rows);
    if (r) {
      this.rot = r.rot;
      this.pos = r.pos;
      this.resetLockIfLanded();
      this.renderActive();
    }
  }

  // If the piece can't fall, (re)start the lock delay; if it can, clear the landed flag.
  resetLockIfLanded() {
    const canFall = !!tryMove(this.well, this.pieceKey, this.rot, this.pos, 0, 1, GRID.cols, GRID.rows);
    if (canFall) {
      this.landed = false;
    } else if (!this.landed) {
      this.landed = true;
      this.lockTimer = 0;
    }
  }

  hardDrop() {
    if (this.gameOver) return;
    const { pos, dropped } = hardDropPos(this.well, this.pieceKey, this.rot, this.pos, GRID.cols, GRID.rows);
    this.pos = pos;
    this.score += dropScore(dropped, true);
    this.lockPieceNow();
  }

  // --- main loop --------------------------------------------------------------------- //
  update(_time, deltaMs) {
    if (this.gameOver) return;
    const soft = this.keyDown.isDown;
    const interval = soft ? RULES.softDropMs : gravityInterval(this.level, RULES.baseGravityMs, RULES.gravityPerLevel, RULES.minGravityMs);

    if (this.landed) {
      // landed: count down the lock delay; any successful move/rotate resets it elsewhere.
      this.lockTimer += deltaMs;
      if (this.lockTimer >= RULES.lockDelayMs) {
        this.lockPieceNow();
      }
      return;
    }

    this.acc += deltaMs;
    while (this.acc >= interval) {
      this.acc -= interval;
      this.gravityStep(soft);
      if (this.gameOver || this.landed) return;
    }
  }

  gravityStep(soft) {
    const next = tryMove(this.well, this.pieceKey, this.rot, this.pos, 0, 1, GRID.cols, GRID.rows);
    if (next) {
      this.pos = next;
      if (soft) this.score += dropScore(1, false);
      this.renderActive();
    } else {
      // can't fall — enter lock delay.
      this.landed = true;
      this.lockTimer = 0;
    }
  }

  lockPieceNow() {
    this.well = lockPiece(this.well, this.pieceKey, this.rot, this.pos);
    const { well, cleared } = clearLines(this.well, GRID.cols);
    this.well = well;

    if (cleared > 0) {
      this.combo = nextCombo(this.combo, cleared);
      this.score += lineScore(cleared, this.level, this.combo);
      this.lines += cleared;
      this.level = levelForLines(this.lines, RULES.linesPerLevel);
      this.flashClear();
    } else {
      this.combo = nextCombo(this.combo, 0);
    }

    this.renderWell();
    this.refreshHud();
    this.acc = 0;
    this.landed = false;
    this.spawnPiece();
  }

  // brief glow flash when lines clear.
  flashClear() {
    const wellW = GRID.cols * GRID.tile;
    const fx = this.add
      .rectangle(wellW / 2, GAME_HEIGHT / 2, wellW, GAME_HEIGHT, hexToInt(this.skin.palette.glow), 0.25)
      .setDepth(8);
    this.tweens.add({ targets: fx, alpha: 0, duration: 220, onComplete: () => fx.destroy() });
    this.cameras.main.shake(90, 0.003);
  }

  // --- death / settlement ------------------------------------------------------------ //
  async die() {
    this.gameOver = true;
    this.cameras.main.shake(240, 0.01);

    const overlay = this.add
      .rectangle(GAME_WIDTH / 2, GAME_HEIGHT / 2, GAME_WIDTH, GAME_HEIGHT, 0x000000, 0.72)
      .setDepth(20)
      .setInteractive();
    this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 - 60, 'STACK-OUT', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '34px',
        color: '#ff6a7a',
        fontStyle: 'bold',
      })
      .setOrigin(0.5)
      .setDepth(21);
    this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 - 14, `Score ${this.score}  ·  ${this.lines} lines  ·  level ${this.level + 1}`, {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '14px',
        color: '#cfe0ff',
        align: 'center',
        wordWrap: { width: GAME_WIDTH - 30 },
      })
      .setOrigin(0.5)
      .setDepth(21);

    // Settlement (crypto build only). The clean build dead-code-eliminates this whole path.
    if (CRYPTO_BUILD) {
      const status = this.add
        .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 + 24, 'Settling score…', {
          fontFamily: 'system-ui, sans-serif',
          fontSize: '12px',
          color: '#7f97c8',
        })
        .setOrigin(0.5)
        .setDepth(21);
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
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 + 64, 'Click to play again', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '15px',
        color: '#05080f',
        backgroundColor: '#62d0ff',
        padding: { x: 16, y: 8 },
      })
      .setOrigin(0.5)
      .setDepth(21)
      .setInteractive({ useHandCursor: true });
    retry.on('pointerup', () => this.restart());
    overlay.on('pointerup', () => this.restart());
  }

  // Lightweight non-cryptographic integrity digest of the run. The attester re-derives /
  // re-checks server-side; this only has to be a stable per-run reference, not secure.
  computeRunHash() {
    const durationMs = Date.now() - this.runStart;
    const seed = `${this.score}:${this.lines}:${this.level}:${durationMs}`;
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
