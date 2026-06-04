import Phaser from 'phaser';
import { GAME_WIDTH, GAME_HEIGHT, CRYPTO_BUILD, RULES } from '../config.js';

// Menu: title, how-to, and play.
export default class MenuScene extends Phaser.Scene {
  constructor() {
    super('Menu');
  }

  create() {
    const cx = GAME_WIDTH / 2;
    this.add.image(GAME_WIDTH / 2, GAME_HEIGHT / 2, 'star_field').setDepth(0).setAlpha(0.8);

    this.add
      .text(cx, GAME_HEIGHT * 0.18, 'SKY SENTINELS', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '46px',
        color: '#bff0ff',
        fontStyle: 'bold',
      })
      .setOrigin(0.5)
      .setDepth(1);

    this.add
      .text(cx, GAME_HEIGHT * 0.27, 'Hold the line. Thin their ranks before they land.', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '15px',
        color: '#6f8fc8',
      })
      .setOrigin(0.5)
      .setDepth(1);

    // a small preview row of the original sigils
    const previewY = GAME_HEIGHT * 0.42;
    for (let row = 0; row < RULES.grid.rows; row++) {
      const x = cx - ((RULES.grid.rows - 1) * 46) / 2 + row * 46;
      this.add.image(x, previewY, `sentinel_${row}`).setDepth(1);
    }

    const btn = this.add
      .text(cx, GAME_HEIGHT * 0.6, '▶  PLAY', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '26px',
        color: '#04060e',
        backgroundColor: '#62d0ff',
        padding: { x: 24, y: 12 },
      })
      .setOrigin(0.5)
      .setDepth(2)
      .setInteractive({ useHandCursor: true });
    btn.on('pointerover', () => btn.setStyle({ backgroundColor: '#9be4ff' }));
    btn.on('pointerout', () => btn.setStyle({ backgroundColor: '#62d0ff' }));
    btn.on('pointerup', () => this.scene.start('Play'));

    this.add
      .text(cx, GAME_HEIGHT * 0.72, '← → / A D move · Space fire · shelter behind the cover arcs', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '13px',
        color: '#54689a',
        align: 'center',
      })
      .setOrigin(0.5)
      .setDepth(2);

    // Trade-dress note (kept visible so the original-art intent is explicit).
    this.add
      .text(cx, GAME_HEIGHT * 0.8, 'Sentinels are original PRANA sigils — not classic arcade aliens.', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '11px',
        color: '#3f5a8a',
      })
      .setOrigin(0.5)
      .setDepth(2);

    // In the crypto build, hint that runs settle to a reward voucher. Stripped in clean.
    if (CRYPTO_BUILD) {
      this.add
        .text(cx, GAME_HEIGHT * 0.87, 'Crypto build: scores settle to a signed reward voucher.', {
          fontFamily: 'system-ui, sans-serif',
          fontSize: '11px',
          color: '#3f5a8a',
        })
        .setOrigin(0.5)
        .setDepth(2);
    }
  }
}
