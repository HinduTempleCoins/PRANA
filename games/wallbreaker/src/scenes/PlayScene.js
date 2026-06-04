import Phaser from 'phaser';
import { GAME_WIDTH, GAME_HEIGHT, RULES, CRYPTO_BUILD, SETTLEMENT } from '../config.js';
import {
  FIELD,
  buildBricks,
  aliveCount,
  paddleOffset,
  paddleBounce,
  speedOf,
  reflectWalls,
  fellOff,
  brickHitAxis,
  damageBrick,
  reflect,
  brickScore,
  clearBonus,
  ballSpeedForLevel,
  maybeDropPowerup,
  widenPaddle,
  splitBall,
  clampPaddle,
  POWERUPS,
} from '../logic/bounce.js';
import { hexToInt } from '../data/skins.js';
import { requestScoreVoucher } from '../data/scoreVoucher.js';

// The canvas matches the abstract field 1:1 (config GAME_WIDTH/HEIGHT == FIELD.w/h),
// so logic units == pixels here. A `scale` guard keeps it correct if that ever changes.
const SX = GAME_WIDTH / FIELD.w;
const SY = GAME_HEIGHT / FIELD.h;

export default class PlayScene extends Phaser.Scene {
  constructor() {
    super('Play');
  }

  init() {
    this.score = 0;
    this.lives = RULES.lives;
    this.level = 0;
    this.gameOver = false;
    this.launched = false;
    this.runStart = Date.now();
    this.paddleW = RULES.paddleWidth;
    this.balls = []; // [{ pos:{x,y}, vel:{vx,vy}, sprite }]
    this.powerups = []; // [{ x, y, type, sprite, label }]
    this.brickSprites = [];
    this.wideTimer = 0;
  }

  create() {
    const skins = this.registry.get('skins') || [];
    const idx = this.registry.get('selectedSkinIndex') ?? 0;
    this.skin = skins[idx] || skins[0];

    this.cameras.main.setBackgroundColor(this.skin.palette.bg);

    this.bricks = buildBricks(FIELD);
    this.renderBricks();

    this.buildPaddle();
    this.buildHud();
    this.resetBall();
    this.bindInput();
  }

  // --- rendering --------------------------------------------------------------------- //
  renderBricks() {
    this.brickSprites.forEach((s) => s.destroy());
    this.brickSprites = [];
    for (const b of this.bricks) {
      if (!b.alive) continue;
      const spr = this.add
        .image(this.sx(b.x + b.w / 2), this.sy(b.y + b.h / 2), `brick_hp${b.maxHp}`)
        .setDisplaySize(b.w * SX - 2, b.h * SY - 2)
        .setDepth(3);
      spr.setData('brick', b);
      b._sprite = spr;
      this.brickSprites.push(spr);
    }
  }

  buildPaddle() {
    this.paddleX = (FIELD.w - this.paddleW) / 2;
    this.paddleSprite = this.add
      .image(0, 0, `paddle_${this.skin.itemId}`)
      .setDepth(5);
    this.layoutPaddle();
  }

  layoutPaddle() {
    this.paddleSprite
      .setDisplaySize(this.paddleW * SX, RULES.paddleHeight * SY)
      .setPosition(this.sx(this.paddleX + this.paddleW / 2), this.sy(RULES.paddleY + RULES.paddleHeight / 2));
  }

  buildHud() {
    const style = { fontFamily: 'system-ui, sans-serif', fontSize: '15px', color: '#cfe0ff' };
    this.hudScore = this.add.text(10, 6, '', style).setDepth(10);
    this.hudLives = this.add.text(GAME_WIDTH - 200, 6, '', style).setDepth(10);
    this.refreshHud();
  }

  refreshHud() {
    this.hudScore.setText(`Score ${this.score}`);
    this.hudLives.setText(`Lives ${this.lives}  ·  Level ${this.level + 1}`);
  }

  sx(x) { return x * SX; }
  sy(y) { return y * SY; }

  // --- ball lifecycle ---------------------------------------------------------------- //
  resetBall() {
    // clear any extra balls
    this.balls.forEach((b) => b.sprite.destroy());
    this.balls = [];
    this.launched = false;
    const pos = { x: FIELD.w / 2, y: RULES.paddleY - RULES.ballRadius - 2 };
    const sprite = this.add.image(this.sx(pos.x), this.sy(pos.y), `ball_${this.skin.itemId}`).setDepth(6);
    this.balls.push({ pos, vel: { vx: 0, vy: 0 }, sprite });
  }

  launch() {
    if (this.launched || this.gameOver) return;
    this.launched = true;
    const speed = ballSpeedForLevel(this.level);
    // launch upward with a slight angle based on where the paddle is.
    const off = paddleOffset(this.balls[0].pos.x, this.paddleX, this.paddleW);
    this.balls[0].vel = paddleBounce(speed, off * 0.4);
  }

  bindInput() {
    this.input.on('pointermove', (p) => {
      this.paddleX = clampPaddle(p.x / SX - this.paddleW / 2, this.paddleW, FIELD);
      this.layoutPaddle();
    });
    this.input.on('pointerdown', () => {
      if (this.gameOver) this.restart();
      else this.launch();
    });
    this.keySpace = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);
    this.keyLeft = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.LEFT);
    this.keyRight = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.RIGHT);
    this.keySpace.on('down', () => this.launch());
  }

  // --- main loop --------------------------------------------------------------------- //
  update(_time, deltaMs) {
    if (this.gameOver) return;
    const dt = Math.min(0.05, deltaMs / 1000); // clamp dt to avoid tunnelling on stalls

    // keyboard paddle nudge
    const kbSpeed = 520;
    if (this.keyLeft.isDown) { this.paddleX = clampPaddle(this.paddleX - kbSpeed * dt, this.paddleW, FIELD); this.layoutPaddle(); }
    if (this.keyRight.isDown) { this.paddleX = clampPaddle(this.paddleX + kbSpeed * dt, this.paddleW, FIELD); this.layoutPaddle(); }

    // wide-paddle timer
    if (this.wideTimer > 0) {
      this.wideTimer -= deltaMs;
      if (this.wideTimer <= 0) {
        this.paddleW = RULES.paddleWidth;
        this.paddleX = clampPaddle(this.paddleX, this.paddleW, FIELD);
        this.layoutPaddle();
      }
    }

    if (!this.launched) {
      // ball rides the paddle until launch
      this.balls[0].pos.x = this.paddleX + this.paddleW / 2;
      this.balls[0].pos.y = RULES.paddleY - RULES.ballRadius - 2;
      this.balls[0].sprite.setPosition(this.sx(this.balls[0].pos.x), this.sy(this.balls[0].pos.y));
    } else {
      this.stepBalls(dt);
    }

    this.stepPowerups(dt);
  }

  stepBalls(dt) {
    const r = RULES.ballRadius;
    const survivors = [];
    for (const ball of this.balls) {
      // integrate
      ball.pos.x += ball.vel.vx * dt;
      ball.pos.y += ball.vel.vy * dt;

      // walls
      const w = reflectWalls(ball.pos, ball.vel, r, FIELD);
      ball.pos = w.pos;
      ball.vel = w.vel;

      // paddle
      this.tryPaddleBounce(ball, r);

      // bricks
      this.tryBrickBounce(ball, r);

      // fell off?
      if (fellOff(ball.pos, r, FIELD)) {
        ball.sprite.destroy();
        continue; // dropped
      }

      ball.sprite.setPosition(this.sx(ball.pos.x), this.sy(ball.pos.y));
      survivors.push(ball);
    }
    this.balls = survivors;

    if (this.balls.length === 0) {
      this.loseLife();
      return;
    }
    if (aliveCount(this.bricks) === 0) {
      this.advanceLevel();
    }
  }

  tryPaddleBounce(ball, r) {
    const py = RULES.paddleY;
    // only when moving down and overlapping the paddle band
    if (ball.vel.vy <= 0) return;
    if (ball.pos.y + r < py || ball.pos.y - r > py + RULES.paddleHeight) return;
    if (ball.pos.x < this.paddleX - r || ball.pos.x > this.paddleX + this.paddleW + r) return;

    const speed = speedOf(ball.vel.vx, ball.vel.vy);
    const off = paddleOffset(ball.pos.x, this.paddleX, this.paddleW);
    ball.vel = paddleBounce(speed, off);
    ball.pos.y = py - r - 0.5; // lift clear of the paddle
  }

  tryBrickBounce(ball, r) {
    for (const b of this.bricks) {
      if (!b.alive) continue;
      const axis = brickHitAxis(ball.pos, r, b);
      if (!axis) continue;
      ball.vel = reflect(ball.vel, axis);
      const res = damageBrick(b);
      if (res.destroyed) {
        this.score += brickScore(b, this.level);
        if (b._sprite) b._sprite.destroy();
        this.maybeDrop(b);
      } else {
        // visual damage: dim the brick
        if (b._sprite) b._sprite.setAlpha(0.45 + 0.18 * b.hp);
      }
      this.refreshHud();
      break; // one brick per frame keeps reflections sane
    }
  }

  // --- powerups ---------------------------------------------------------------------- //
  maybeDrop(brick) {
    const type = maybeDropPowerup(Math.random, RULES.powerupChance);
    if (!type) return;
    const x = brick.x + brick.w / 2;
    const y = brick.y + brick.h / 2;
    const key = type === POWERUPS.WIDE ? 'pu_wide' : 'pu_multi';
    const sprite = this.add.image(this.sx(x), this.sy(y), key).setDepth(7);
    const label = this.add
      .text(this.sx(x), this.sy(y), type === POWERUPS.WIDE ? 'W' : 'M', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '11px',
        color: '#ffffff',
      })
      .setOrigin(0.5)
      .setDepth(8);
    this.powerups.push({ x, y, type, sprite, label });
  }

  stepPowerups(dt) {
    const survivors = [];
    for (const pu of this.powerups) {
      pu.y += RULES.powerupFallSpeed * dt;
      pu.sprite.setPosition(this.sx(pu.x), this.sy(pu.y));
      pu.label.setPosition(this.sx(pu.x), this.sy(pu.y));

      // caught by the paddle?
      const onPaddle =
        pu.y >= RULES.paddleY - 6 &&
        pu.y <= RULES.paddleY + RULES.paddleHeight + 6 &&
        pu.x >= this.paddleX &&
        pu.x <= this.paddleX + this.paddleW;
      if (onPaddle) {
        this.applyPowerup(pu.type);
        pu.sprite.destroy();
        pu.label.destroy();
        continue;
      }
      if (pu.y > FIELD.h + 20) {
        pu.sprite.destroy();
        pu.label.destroy();
        continue;
      }
      survivors.push(pu);
    }
    this.powerups = survivors;
  }

  applyPowerup(type) {
    if (type === POWERUPS.WIDE) {
      this.paddleW = widenPaddle(RULES.paddleWidth);
      this.paddleX = clampPaddle(this.paddleX - (this.paddleW - RULES.paddleWidth) / 2, this.paddleW, FIELD);
      this.wideTimer = RULES.widePaddleMs;
      this.layoutPaddle();
    } else if (type === POWERUPS.MULTI && this.balls.length > 0) {
      // split the first active ball into two extra balls.
      const src = this.balls[0];
      const extras = splitBall(src.vel);
      for (const v of extras) {
        const pos = { x: src.pos.x, y: src.pos.y };
        const sprite = this.add.image(this.sx(pos.x), this.sy(pos.y), `ball_${this.skin.itemId}`).setDepth(6);
        this.balls.push({ pos, vel: v, sprite });
      }
    }
  }

  // --- level / life flow ------------------------------------------------------------- //
  advanceLevel() {
    this.score += clearBonus(this.level);
    this.level += 1;
    this.bricks = buildBricks(FIELD);
    this.renderBricks();
    // reset paddle width and ball; new ball speed is read at launch via ballSpeedForLevel.
    this.paddleW = RULES.paddleWidth;
    this.wideTimer = 0;
    this.layoutPaddle();
    this.resetBall();
    this.refreshHud();
    this.flashLevel();
  }

  loseLife() {
    this.lives -= 1;
    this.refreshHud();
    this.cameras.main.shake(160, 0.008);
    if (this.lives <= 0) {
      this.die();
    } else {
      this.resetBall();
    }
  }

  flashLevel() {
    const txt = this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2, `LEVEL ${this.level + 1}`, {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '40px',
        color: '#62ffb0',
        fontStyle: 'bold',
      })
      .setOrigin(0.5)
      .setDepth(15);
    this.tweens.add({ targets: txt, alpha: 0, duration: 900, onComplete: () => txt.destroy() });
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
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 - 60, 'GAME OVER', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '44px',
        color: '#ff6a7a',
        fontStyle: 'bold',
      })
      .setOrigin(0.5)
      .setDepth(21);
    this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 - 10, `Score ${this.score}  ·  reached level ${this.level + 1}`, {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '16px',
        color: '#cfe0ff',
      })
      .setOrigin(0.5)
      .setDepth(21);

    // Settlement (crypto build only). The clean build dead-code-eliminates this whole path.
    if (CRYPTO_BUILD) {
      const status = this.add
        .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 + 28, 'Settling score…', {
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
    const seed = `${this.score}:${this.level}:${this.lives}:${durationMs}`;
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
