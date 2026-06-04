import Phaser from 'phaser';
import { GRID, GAME_WIDTH, GAME_HEIGHT, RULES, CRYPTO_BUILD, SETTLEMENT } from '../config.js';
import {
  DIRS,
  step,
  spawnFood,
  resolveDirection,
  initialBody,
  multiplierFor,
  orbScore,
  stepInterval,
} from '../logic/snake.js';
import { requestScoreVoucher } from '../data/scoreVoucher.js';

export default class PlayScene extends Phaser.Scene {
  constructor() {
    super('Play');
  }

  init() {
    this.body = initialBody(GRID.cols, GRID.rows, RULES.startLength);
    this.dir = 'right';
    this.queuedDir = 'right';
    this.food = spawnFood(this.body, GRID.cols, GRID.rows);
    this.score = 0;
    this.grown = 0; // segments grown beyond startLength
    this.multiplier = 1;
    this.acc = 0; // ms accumulator for the step clock
    this.gameOver = false;
    this.segSprites = [];
    this.runStart = Date.now();
  }

  create() {
    // Resolve the chosen skin (falls back to first/default).
    const skins = this.registry.get('skins') || [];
    const idx = this.registry.get('selectedSkinIndex') ?? 0;
    this.skin = skins[idx] || skins[0];

    this.drawBackground();
    this.buildHud();
    this.foodSprite = this.add.image(0, 0, `orb_${this.skin.itemId}`).setDepth(4);
    this.placeFood();
    // Pulse the orb (glow tween) — the "light" the serpent feeds on.
    this.tweens.add({
      targets: this.foodSprite,
      scale: { from: 0.8, to: 1.15 },
      duration: 620,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.inOut',
    });

    this.renderSnake();
    this.bindInput();
  }

  // --- rendering --------------------------------------------------------------------- //
  drawBackground() {
    for (let r = 0; r < GRID.rows; r++) {
      for (let c = 0; c < GRID.cols; c++) {
        this.add.image(this.px(c), this.px(r), 'tile_dark').setDepth(0);
      }
    }
    // Solid-wall border hint when wrap is off.
    if (!RULES.wrap) {
      this.add
        .rectangle(GAME_WIDTH / 2, GAME_HEIGHT / 2, GAME_WIDTH - 2, GAME_HEIGHT - 2)
        .setStrokeStyle(3, 0xff5a6a, 0.5)
        .setDepth(1);
    }
  }

  px(cell) {
    return cell * GRID.tile + GRID.tile / 2;
  }

  buildHud() {
    const style = { fontFamily: 'system-ui, sans-serif', fontSize: '15px', color: '#cfe0ff' };
    this.hudScore = this.add.text(10, 6, '', style).setDepth(10);
    this.hudMult = this.add.text(GAME_WIDTH - 120, 6, '', style).setDepth(10);
    this.refreshHud();
  }

  refreshHud() {
    this.hudScore.setText(`Score ${this.score}`);
    this.hudMult.setText(`x${this.multiplier} · len ${this.body.length}`);
  }

  placeFood() {
    if (!this.food) {
      this.foodSprite.setVisible(false);
      return;
    }
    this.foodSprite.setVisible(true).setPosition(this.px(this.food.x), this.px(this.food.y));
  }

  // Rebuild segment sprites to match the body. Head uses the luminous head texture; body
  // segments fade from head-bright to tail-dark (the dark-field/bright-core gradient).
  renderSnake() {
    // grow/shrink the sprite pool to body length
    while (this.segSprites.length < this.body.length) {
      this.segSprites.push(this.add.image(0, 0, `seg_${this.skin.itemId}`).setDepth(5));
    }
    while (this.segSprites.length > this.body.length) {
      this.segSprites.pop().destroy();
    }
    const headKey = `head_${this.skin.itemId}_${this.skin.head}`;
    const len = this.body.length;
    for (let i = 0; i < len; i++) {
      const seg = this.body[i];
      const sprite = this.segSprites[i];
      sprite.setPosition(this.px(seg.x), this.px(seg.y));
      if (i === 0) {
        sprite.setTexture(headKey).setDepth(6).setAlpha(1).setScale(1);
      } else {
        // gradient: brightest just behind the head, dimming toward the tail.
        const frac = 1 - i / Math.max(1, len);
        sprite.setTexture(`seg_${this.skin.itemId}`).setDepth(5);
        sprite.setAlpha(0.45 + 0.55 * frac);
        sprite.setScale(0.82 + 0.14 * frac);
      }
    }
  }

  // --- input ------------------------------------------------------------------------- //
  bindInput() {
    // Keyboard: arrows + WASD. We queue ONE direction; resolveDirection rejects 180s.
    const k = this.input.keyboard;
    const map = {
      up: ['UP', 'W'],
      down: ['DOWN', 'S'],
      left: ['LEFT', 'A'],
      right: ['RIGHT', 'D'],
    };
    this.keys = {};
    for (const [dir, codes] of Object.entries(map)) {
      for (const code of codes) {
        const key = k.addKey(Phaser.Input.Keyboard.KeyCodes[code]);
        key.on('down', () => this.queue(dir));
        this.keys[`${dir}_${code}`] = key;
      }
    }

    // Pointer swipe: on release, the dominant drag axis sets the direction.
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
        return; // a tap, not a swipe
      }
      if (Math.abs(dx) > Math.abs(dy)) this.queue(dx > 0 ? 'right' : 'left');
      else this.queue(dy > 0 ? 'down' : 'up');
    });
  }

  queue(dir) {
    // Queue against the CURRENT committed direction so two fast turns can't 180 the snake.
    this.queuedDir = resolveDirection(this.dir, dir);
  }

  // --- main loop --------------------------------------------------------------------- //
  update(_time, deltaMs) {
    if (this.gameOver) return;
    this.acc += deltaMs;
    const interval = stepInterval(this.body.length, RULES);
    while (this.acc >= interval) {
      this.acc -= interval;
      this.tick();
      if (this.gameOver) return;
    }
  }

  tick() {
    // Commit the queued direction at the step boundary.
    this.dir = this.queuedDir;
    const result = step(
      { body: this.body, dir: this.dir, alive: true },
      { cols: GRID.cols, rows: GRID.rows, wrap: RULES.wrap, food: this.food },
    );

    if (result.dead) {
      this.die();
      return;
    }

    this.body = result.body;

    if (result.ate) {
      this.grown += 1;
      this.multiplier = multiplierFor(this.grown, RULES.multiplierEvery);
      this.score += orbScore(RULES.pointsPerOrb, this.multiplier);
      this.food = spawnFood(this.body, GRID.cols, GRID.rows);
      this.placeFood();
      this.popOrb();
      this.refreshHud();
      if (!this.food) {
        // Board filled — perfect run. Treat as a (winning) game-over.
        this.die(true);
        return;
      }
    }

    this.renderSnake();
  }

  // orb-pop juice at the head when an orb is eaten.
  popOrb() {
    const head = this.body[0];
    const fx = this.add
      .image(this.px(head.x), this.px(head.y), `orb_${this.skin.itemId}`)
      .setDepth(7);
    this.tweens.add({
      targets: fx,
      scale: { from: 1, to: 2.1 },
      alpha: { from: 0.9, to: 0 },
      duration: 260,
      ease: 'Quad.out',
      onComplete: () => fx.destroy(),
    });
  }

  // --- death / settlement ------------------------------------------------------------ //
  async die(won = false) {
    this.gameOver = true;
    // subtle screen shake on death.
    this.cameras.main.shake(won ? 120 : 240, won ? 0.004 : 0.01);

    const overlay = this.add
      .rectangle(GAME_WIDTH / 2, GAME_HEIGHT / 2, GAME_WIDTH, GAME_HEIGHT, 0x000000, 0.72)
      .setDepth(20)
      .setInteractive();
    this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 - 50, won ? 'BOARD CLEARED' : 'GAME OVER', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '40px',
        color: won ? '#62ffb0' : '#ff6a7a',
        fontStyle: 'bold',
      })
      .setOrigin(0.5)
      .setDepth(21);
    this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2, `Score ${this.score}  ·  length ${this.body.length}  ·  x${this.multiplier}`, {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '16px',
        color: '#cfe0ff',
      })
      .setOrigin(0.5)
      .setDepth(21);

    // Settlement (crypto build only). The clean build dead-code-eliminates this whole path.
    if (CRYPTO_BUILD) {
      const statusY = GAME_HEIGHT / 2 + 32;
      const status = this.add
        .text(GAME_WIDTH / 2, statusY, 'Settling score…', {
          fontFamily: 'system-ui, sans-serif',
          fontSize: '13px',
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
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 + 70, 'Click to play again', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '16px',
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
    const seed = `${this.score}:${this.body.length}:${this.grown}:${durationMs}`;
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
