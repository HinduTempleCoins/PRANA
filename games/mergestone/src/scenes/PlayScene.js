import Phaser from 'phaser';
import { BOARD, GAME_WIDTH, GAME_HEIGHT, RULES, CRYPTO_BUILD, SETTLEMENT } from '../config.js';
import {
  SIZE,
  newGame,
  move,
  spawn,
  isGameOver,
  makeRng,
  maxTier,
  tierValue,
  idx,
} from '../logic/merge.js';
import { requestScoreVoucher } from '../data/scoreVoucher.js';
import { MAX_TIER } from './BootScene.js';

// PlayScene owns the whole loop: it keeps the logic board in `this.board`, renders a stone
// sprite per occupied cell, and on each move computes the OLD->NEW positions so it can tween
// the stones smoothly into place, then pops in the spawned stone. All rules live in the pure
// logic module; this scene is presentation + input + settlement only.
export default class PlayScene extends Phaser.Scene {
  constructor() {
    super('Play');
  }

  init() {
    // Seed from time so each run differs; the SEEDED prng makes the run reproducible/testable.
    this.rng = makeRng((Date.now() & 0x7fffffff) || 1);
    this.board = newGame(this.rng, SIZE);
    this.score = 0;
    this.busy = false; // true while a slide tween is in flight (input locked)
    this.gameOver = false;
    this.runStart = Date.now();
    this.stones = new Map(); // cell index -> sprite (rebuilt each settled frame)
  }

  create() {
    const skins = this.registry.get('skins') || [];
    const idxSel = this.registry.get('selectedSkinIndex') ?? 0;
    this.skin = skins[idxSel] || skins[0];

    this.drawFrame();
    this.buildHud();
    this.renderBoard();
    this.bindInput();
  }

  // --- geometry ---------------------------------------------------------------------- //
  cellX(x) {
    return BOARD.pad + x * (BOARD.tile + BOARD.gap) + BOARD.tile / 2;
  }

  cellY(y) {
    return this.boardTop + BOARD.pad + y * (BOARD.tile + BOARD.gap) + BOARD.tile / 2;
  }

  drawFrame() {
    this.boardTop = 96; // HUD strip height
    const w = GAME_WIDTH;
    const h = GAME_HEIGHT - this.boardTop;
    this.add
      .rectangle(w / 2, this.boardTop + h / 2, w - 8, h - 8, 0x0e1426)
      .setStrokeStyle(2, 0x1d2a4a)
      .setDepth(0);
    // empty sockets
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        this.add.image(this.cellX(x), this.cellY(y), `cell_${this.skin.itemId}`).setDepth(1);
      }
    }
  }

  buildHud() {
    this.add
      .text(14, 14, 'MERGESTONE', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '18px',
        color: '#bfe0ff',
        fontStyle: 'bold',
      })
      .setDepth(10);
    const style = { fontFamily: 'system-ui, sans-serif', fontSize: '15px', color: '#cfe0ff' };
    this.hudScore = this.add.text(14, 46, '', style).setDepth(10);
    this.hudBest = this.add.text(GAME_WIDTH - 14, 46, '', style).setOrigin(1, 0).setDepth(10);
    this.refreshHud();
  }

  refreshHud() {
    this.hudScore.setText(`Score ${this.score}`);
    this.hudBest.setText(`Best stone ${tierValue(maxTier(this.board))}`);
  }

  // Tear down and rebuild all stone sprites from the current board (used after a settle).
  renderBoard() {
    for (const s of this.stones.values()) {
      if (s.label) s.label.destroy();
      s.destroy();
    }
    this.stones.clear();
    for (let i = 0; i < this.board.length; i++) {
      if (this.board[i] !== 0) this.makeStoneSprite(i, this.board[i]);
    }
    this.refreshHud();
  }

  makeStoneSprite(cell, tier) {
    const x = cell % SIZE;
    const y = Math.floor(cell / SIZE);
    const tex = `stone_${this.skin.itemId}_${Math.min(tier, MAX_TIER)}`;
    const img = this.add.image(this.cellX(x), this.cellY(y), tex).setDepth(5);
    const label = this.add
      .text(this.cellX(x), this.cellY(y), String(tierValue(tier)), {
        fontFamily: 'system-ui, sans-serif',
        fontSize: tier >= 7 ? '24px' : '30px',
        color: '#f2f8ff',
        fontStyle: 'bold',
      })
      .setOrigin(0.5)
      .setDepth(6);
    img.label = label;
    this.stones.set(cell, img);
    return img;
  }

  // --- input ------------------------------------------------------------------------- //
  bindInput() {
    const k = this.input.keyboard;
    const map = { left: ['LEFT', 'A'], right: ['RIGHT', 'D'], up: ['UP', 'W'], down: ['DOWN', 'S'] };
    for (const [dir, codes] of Object.entries(map)) {
      for (const code of codes) {
        k.addKey(Phaser.Input.Keyboard.KeyCodes[code]).on('down', () => this.doMove(dir));
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
      if (Math.abs(dx) < 16 && Math.abs(dy) < 16) {
        if (this.gameOver) this.restart();
        return;
      }
      if (Math.abs(dx) > Math.abs(dy)) this.doMove(dx > 0 ? 'right' : 'left');
      else this.doMove(dy > 0 ? 'down' : 'up');
    });
  }

  // --- the move ---------------------------------------------------------------------- //
  doMove(dir) {
    if (this.busy || this.gameOver) return;
    const result = move(this.board, dir, SIZE);
    if (!result.moved) return; // illegal move — ignore

    this.busy = true;
    const before = this.board;
    this.board = result.board;
    this.score += result.gained;

    // Animate: for the visual we simply slide each existing sprite toward its row/col edge
    // and fade, then rebuild from the settled board + pop the spawn. This keeps the tween
    // honest to the rule outcome without re-deriving per-cell paths.
    this.tweenSlide(dir, before, () => {
      const sp = spawn(this.board, this.rng);
      if (sp) this.board = sp.board;
      this.renderBoard();
      if (sp) this.popSpawn(sp.cell);
      this.popMerges(result.merges.length);
      this.busy = false;
      if (isGameOver(this.board, SIZE)) this.die();
    });
  }

  // Slide every current stone sprite hard toward the move direction, fading slightly — a
  // quick, readable motion cue. The authoritative new layout is rebuilt on completion.
  tweenSlide(dir, before, onDone) {
    const shift = (BOARD.tile + BOARD.gap) * 0.9;
    const dx = dir === 'left' ? -shift : dir === 'right' ? shift : 0;
    const dy = dir === 'up' ? -shift : dir === 'down' ? shift : 0;
    const sprites = [...this.stones.values()];
    if (sprites.length === 0) {
      onDone();
      return;
    }
    let done = 0;
    for (const s of sprites) {
      this.tweens.add({
        targets: [s, s.label].filter(Boolean),
        x: `+=${dx}`,
        y: `+=${dy}`,
        duration: RULES.slideMs,
        ease: 'Quad.easeIn',
        onComplete: () => {
          done += 1;
          if (done === sprites.length) onDone();
        },
      });
    }
    void before;
  }

  popSpawn(cell) {
    const s = this.stones.get(cell);
    if (!s) return;
    s.setScale(0.1);
    this.tweens.add({ targets: s, scale: 1, duration: RULES.popMs, ease: 'Back.easeOut' });
  }

  // Flash a brief glow when merges happen this move (count-driven juice).
  popMerges(count) {
    if (count <= 0) return;
    this.cameras.main.flash(80, 40, 80, 140);
  }

  // --- death / settlement ------------------------------------------------------------ //
  async die() {
    this.gameOver = true;
    this.cameras.main.shake(200, 0.006);

    const overlay = this.add
      .rectangle(GAME_WIDTH / 2, GAME_HEIGHT / 2, GAME_WIDTH, GAME_HEIGHT, 0x000000, 0.72)
      .setDepth(20)
      .setInteractive();
    this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 - 60, 'NO MOVES LEFT', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '34px',
        color: '#ff6a7a',
        fontStyle: 'bold',
      })
      .setOrigin(0.5)
      .setDepth(21);
    this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 - 14, `Score ${this.score}  ·  best stone ${tierValue(maxTier(this.board))}`, {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '16px',
        color: '#cfe0ff',
      })
      .setOrigin(0.5)
      .setDepth(21);

    if (CRYPTO_BUILD) {
      const status = this.add
        .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 + 24, 'Settling score…', {
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
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 + 64, 'Click to play again', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '16px',
        color: '#0a0e1a',
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
    const seed = `${this.score}:${maxTier(this.board)}:${durationMs}`;
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

// keep idx referenced for any future per-cell tween-path work without a new import
void idx;
