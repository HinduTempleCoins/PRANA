import Phaser from 'phaser';
import { GAME_WIDTH, GAME_HEIGHT, FIELD, RULES, AI, CRYPTO_BUILD, SETTLEMENT } from '../config.js';
import {
  serve,
  resolveStep,
  aiTrackStep,
  movePaddleToward,
  applyPoint,
  matchWinner,
  nextServer,
  paddleYBounds,
} from '../logic/volley.js';
import { requestScoreVoucher } from '../data/scoreVoucher.js';

export default class PlayScene extends Phaser.Scene {
  constructor() {
    super('Play');
  }

  init(data) {
    this.mode = data?.mode === 'local-2p' ? 'local-2p' : 'vs-ai'; // default safe to vs-ai
    this.vsAI = this.mode === 'vs-ai';

    const { min } = paddleYBounds(FIELD.paddleH, FIELD.height);
    void min;
    const midY = FIELD.height / 2;

    this.paddles = {
      left: { x: FIELD.margin, y: midY, w: FIELD.paddleW, h: FIELD.paddleH },
      right: { x: FIELD.width - FIELD.margin, y: midY, w: FIELD.paddleW, h: FIELD.paddleH },
    };
    this.score = { left: 0, right: 0 };
    this.server = 'left'; // who serves first
    this.ball = null;
    this.matchOver = false;
    this.servePending = true;
    this.serveTimer = 0;
    this.runStart = Date.now();
    this.hits = 0; // total paddle hits this match (feeds the run hash)
  }

  create() {
    this.drawBackground();
    this.leftSprite = this.add.image(this.paddles.left.x, this.paddles.left.y, 'paddle_left').setDepth(5);
    this.rightSprite = this.add.image(this.paddles.right.x, this.paddles.right.y, 'paddle_right').setDepth(5);
    this.ballSprite = this.add.image(GAME_WIDTH / 2, GAME_HEIGHT / 2, 'ball').setDepth(6).setVisible(false);

    this.buildHud();
    this.bindInput();
    this.queueServe();
  }

  drawBackground() {
    // Center net of dashes.
    const dashGap = 26;
    for (let y = 12; y < GAME_HEIGHT; y += dashGap) {
      this.add.image(GAME_WIDTH / 2, y, 'net_dash').setDepth(1).setAlpha(0.7);
    }
    // Goal-side glow hints.
    this.add.rectangle(2, GAME_HEIGHT / 2, 4, GAME_HEIGHT, 0x62d0ff, 0.18).setDepth(0);
    this.add.rectangle(GAME_WIDTH - 2, GAME_HEIGHT / 2, 4, GAME_HEIGHT, 0xffd27f, 0.18).setDepth(0);
  }

  buildHud() {
    const style = { fontFamily: 'system-ui, sans-serif', fontSize: '34px', color: '#cfe0ff', fontStyle: 'bold' };
    this.hudLeft = this.add.text(GAME_WIDTH * 0.36, 14, '0', style).setOrigin(0.5, 0).setDepth(10);
    this.hudRight = this.add.text(GAME_WIDTH * 0.64, 14, '0', style).setOrigin(0.5, 0).setDepth(10);
    this.hudMode = this.add
      .text(GAME_WIDTH / 2, 18, this.vsAI ? 'VS  AI' : '2P  LOCAL', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '12px',
        color: '#54689a',
      })
      .setOrigin(0.5, 0)
      .setDepth(10);
    this.refreshHud();
  }

  refreshHud() {
    this.hudLeft.setText(`${this.score.left}`);
    this.hudRight.setText(`${this.score.right}`);
  }

  bindInput() {
    const k = this.input.keyboard;
    this.keyW = k.addKey(Phaser.Input.Keyboard.KeyCodes.W);
    this.keyS = k.addKey(Phaser.Input.Keyboard.KeyCodes.S);
    this.keyUp = k.addKey(Phaser.Input.Keyboard.KeyCodes.UP);
    this.keyDown = k.addKey(Phaser.Input.Keyboard.KeyCodes.DOWN);
    this.keySpace = k.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);
    this.input.on('pointerup', () => {
      if (this.matchOver) this.scene.start('Menu');
    });
  }

  queueServe() {
    this.servePending = true;
    this.serveTimer = 0;
    this.ballSprite.setVisible(false);
    this.ball = null;
  }

  doServe() {
    this.ball = serve(this.server, RULES, FIELD.width, FIELD.height, FIELD.ballSize);
    this.servePending = false;
    this.ballSprite.setVisible(true);
  }

  update(_time, deltaMs) {
    if (this.matchOver) return;
    const dt = Math.min(deltaMs, 40) / 1000; // clamp huge frames so physics stays stable

    this.updatePaddles(dt);

    if (this.servePending) {
      this.serveTimer += deltaMs;
      // Keep the serving paddle parked near center while waiting (visual readiness).
      if (this.serveTimer >= 700) this.doServe();
      this.syncSprites();
      return;
    }

    const { ball, hit, scoredOn } = resolveStep(this.ball, dt, this.paddles, RULES, FIELD.width, FIELD.height);
    this.ball = ball;
    if (hit) {
      this.hits += 1;
      this.cameras.main.shake(40, 0.003);
    }
    if (scoredOn) {
      this.score = applyPoint(this.score, scoredOn);
      this.refreshHud();
      const winner = matchWinner(this.score, RULES);
      if (winner) {
        this.endMatch(winner);
        return;
      }
      this.server = nextServer(scoredOn); // loser serves
      this.queueServe();
    }
    this.syncSprites();
  }

  updatePaddles(dt) {
    // LEFT paddle: always W/S human.
    let ly = this.paddles.left.y;
    if (this.keyW.isDown) ly = movePaddleToward(ly, 0, FIELD.paddleSpeed, dt, FIELD.paddleH, FIELD.height);
    if (this.keyS.isDown) ly = movePaddleToward(ly, FIELD.height, FIELD.paddleSpeed, dt, FIELD.paddleH, FIELD.height);
    this.paddles.left.y = ly;

    // RIGHT paddle: AI in vs-ai, else ↑/↓ human.
    if (this.vsAI) {
      const refBall = this.ball || { x: FIELD.width / 2, y: FIELD.height / 2, vx: 1, vy: 0, size: FIELD.ballSize };
      this.paddles.right.y = aiTrackStep(this.paddles.right, refBall, 'right', AI, dt, FIELD.paddleH, FIELD.height);
    } else {
      let ry = this.paddles.right.y;
      if (this.keyUp.isDown) ry = movePaddleToward(ry, 0, FIELD.paddleSpeed, dt, FIELD.paddleH, FIELD.height);
      if (this.keyDown.isDown) ry = movePaddleToward(ry, FIELD.height, FIELD.paddleSpeed, dt, FIELD.paddleH, FIELD.height);
      this.paddles.right.y = ry;
    }
  }

  syncSprites() {
    this.leftSprite.setPosition(this.paddles.left.x, this.paddles.left.y);
    this.rightSprite.setPosition(this.paddles.right.x, this.paddles.right.y);
    if (this.ball) this.ballSprite.setPosition(this.ball.x, this.ball.y);
  }

  async endMatch(winner) {
    this.matchOver = true;
    this.cameras.main.shake(200, 0.008);

    this.add
      .rectangle(GAME_WIDTH / 2, GAME_HEIGHT / 2, GAME_WIDTH, GAME_HEIGHT, 0x000000, 0.72)
      .setDepth(20)
      .setInteractive();

    const winLabel = this.vsAI
      ? winner === 'left'
        ? 'YOU WIN'
        : 'AI WINS'
      : `${winner === 'left' ? 'LEFT' : 'RIGHT'} WINS`;

    this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 - 56, winLabel, {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '44px',
        color: winner === 'left' ? '#62d0ff' : '#ffd27f',
        fontStyle: 'bold',
      })
      .setOrigin(0.5)
      .setDepth(21);

    this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 - 6, `${this.score.left} — ${this.score.right}`, {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '22px',
        color: '#cfe0ff',
      })
      .setOrigin(0.5)
      .setDepth(21);

    // Settlement (crypto build only). The clean build dead-code-eliminates this whole path.
    // ONLY vs-AI wins by the human (left) settle — local-2P and AI wins never do.
    if (CRYPTO_BUILD) {
      const attestable = this.vsAI && winner === 'left';
      const status = this.add
        .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 + 34, attestable ? 'Settling score…' : '', {
          fontFamily: 'system-ui, sans-serif',
          fontSize: '13px',
          color: '#7f97c8',
        })
        .setOrigin(0.5)
        .setDepth(21);
      if (attestable) {
        const voucher = await requestScoreVoucher({
          player: SETTLEMENT.player,
          score: this.score.left,
          runHash: this.computeRunHash(),
          mode: 'vs-ai',
        });
        if (voucher) {
          const tag = voucher.fixture ? ' (demo)' : '';
          status.setText(`Reward voucher ready${tag} — claim in your wallet.`).setColor('#9be4ff');
        } else {
          status.setText('No settlement endpoint configured.').setColor('#54689a');
        }
      }
    }

    this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 + 76, 'Click to return to menu', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '15px',
        color: '#05080f',
        backgroundColor: '#62d0ff',
        padding: { x: 16, y: 8 },
      })
      .setOrigin(0.5)
      .setDepth(21);
  }

  // Lightweight non-cryptographic integrity digest of the run. Attester re-derives server-side.
  computeRunHash() {
    const durationMs = Date.now() - this.runStart;
    const seed = `${this.score.left}:${this.score.right}:${this.hits}:${durationMs}:${this.mode}`;
    let h = 0;
    for (let i = 0; i < seed.length; i++) {
      h = (h * 31 + seed.charCodeAt(i)) >>> 0;
    }
    return '0x' + h.toString(16).padStart(8, '0');
  }
}
