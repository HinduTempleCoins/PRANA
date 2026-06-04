import Phaser from 'phaser';
import { GAME_WIDTH, GAME_HEIGHT, CRYPTO_BUILD } from '../config.js';

// Menu: title + mode select (local 2-player vs vs-AI), then play.
export default class MenuScene extends Phaser.Scene {
  constructor() {
    super('Menu');
  }

  create() {
    const cx = GAME_WIDTH / 2;

    this.add
      .text(cx, GAME_HEIGHT * 0.16, 'TEMPLE VOLLEY', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '46px',
        color: '#bff0ff',
        fontStyle: 'bold',
      })
      .setOrigin(0.5);

    this.add
      .text(cx, GAME_HEIGHT * 0.27, 'Volley the light across the temple court. First to 11.', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '14px',
        color: '#6f8fc8',
      })
      .setOrigin(0.5);

    this.makeModeButton(cx, GAME_HEIGHT * 0.46, '1P  vs  AI', 'vs-ai', '#62d0ff');
    this.makeModeButton(cx, GAME_HEIGHT * 0.62, '2P  LOCAL', 'local-2p', '#ffd27f');

    this.add
      .text(cx, GAME_HEIGHT * 0.8, 'Left paddle: W / S      ·      Right paddle: ↑ / ↓', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '13px',
        color: '#54689a',
      })
      .setOrigin(0.5);

    this.add
      .text(cx, GAME_HEIGHT * 0.86, 'Hit the ball off-center to bend its angle (english).', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '12px',
        color: '#54689a',
      })
      .setOrigin(0.5);

    if (CRYPTO_BUILD) {
      this.add
        .text(cx, GAME_HEIGHT * 0.94, 'Crypto build: a vs-AI win settles to a signed reward voucher. Local 2P does not.', {
          fontFamily: 'system-ui, sans-serif',
          fontSize: '11px',
          color: '#3f5a8a',
        })
        .setOrigin(0.5);
    }
  }

  makeModeButton(x, y, label, mode, color) {
    const btn = this.add
      .text(x, y, label, {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '24px',
        color: '#05080f',
        backgroundColor: color,
        padding: { x: 28, y: 12 },
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    btn.on('pointerover', () => btn.setAlpha(0.85));
    btn.on('pointerout', () => btn.setAlpha(1));
    btn.on('pointerup', () => this.scene.start('Play', { mode }));
  }
}
