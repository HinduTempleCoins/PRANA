import Phaser from 'phaser';
import { GAME_WIDTH, GAME_HEIGHT, CRYPTO_BUILD } from '../config.js';

// Menu: title, one-line how-to, and start (tap / space / click).
export default class MenuScene extends Phaser.Scene {
  constructor() {
    super('Menu');
  }

  create() {
    const cx = GAME_WIDTH / 2;

    this.add
      .text(cx, GAME_HEIGHT * 0.22, 'IBIS FLIGHT', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '46px',
        color: '#bff0ff',
        fontStyle: 'bold',
      })
      .setOrigin(0.5);

    this.add.image(cx, GAME_HEIGHT * 0.36, 'ibis').setScale(1.6);

    this.add
      .text(cx, GAME_HEIGHT * 0.48, 'Tap to flap. Thread the temple pillars.', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '15px',
        color: '#6f8fc8',
      })
      .setOrigin(0.5);

    const btn = this.add
      .text(cx, GAME_HEIGHT * 0.62, '▶  FLY', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '26px',
        color: '#05080f',
        backgroundColor: '#62d0ff',
        padding: { x: 26, y: 12 },
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    btn.on('pointerover', () => btn.setStyle({ backgroundColor: '#9be4ff' }));
    btn.on('pointerout', () => btn.setStyle({ backgroundColor: '#62d0ff' }));

    const start = () => this.scene.start('Play');
    btn.on('pointerup', start);
    this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE).on('down', start);

    this.add
      .text(cx, GAME_HEIGHT * 0.74, 'Space / click / tap to flap · gravity does the rest', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '12px',
        color: '#54689a',
      })
      .setOrigin(0.5);

    if (CRYPTO_BUILD) {
      this.add
        .text(cx, GAME_HEIGHT * 0.82, 'Crypto build: your run settles to a signed reward voucher.', {
          fontFamily: 'system-ui, sans-serif',
          fontSize: '11px',
          color: '#3f5a8a',
        })
        .setOrigin(0.5);
    }
  }
}
