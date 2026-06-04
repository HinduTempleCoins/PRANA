import Phaser from 'phaser';
import { GAME_WIDTH, GAME_HEIGHT, CRYPTO_BUILD } from '../config.js';

// Menu: title, how-to, and play.
export default class MenuScene extends Phaser.Scene {
  constructor() {
    super('Menu');
  }

  create() {
    const cx = GAME_WIDTH / 2;
    this.add.image(GAME_WIDTH / 2, GAME_HEIGHT / 2, 'star_field').setDepth(0).setAlpha(0.8);

    this.add
      .text(cx, GAME_HEIGHT * 0.2, 'VOID SHARDS', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '52px',
        color: '#bff0ff',
        fontStyle: 'bold',
      })
      .setOrigin(0.5)
      .setDepth(1);

    this.add
      .text(cx, GAME_HEIGHT * 0.31, 'Drift the void. Shatter the shards. Three lives.', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '15px',
        color: '#6f8fc8',
      })
      .setOrigin(0.5)
      .setDepth(1);

    // a slowly spinning shard preview for flavor
    const preview = this.add.image(cx, GAME_HEIGHT * 0.5, 'shard_large').setDepth(1);
    this.tweens.add({ targets: preview, angle: 360, duration: 14000, repeat: -1 });
    const ship = this.add.image(cx + 90, GAME_HEIGHT * 0.5, 'ship_thrust').setDepth(2);
    this.tweens.add({
      targets: ship,
      x: cx - 90,
      duration: 2600,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.inOut',
    });

    const btn = this.add
      .text(cx, GAME_HEIGHT * 0.7, '▶  PLAY', {
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
      .text(
        cx,
        GAME_HEIGHT * 0.84,
        '← → rotate · ↑ / W thrust · Space fire · screen wraps at the edges',
        {
          fontFamily: 'system-ui, sans-serif',
          fontSize: '13px',
          color: '#54689a',
          align: 'center',
        },
      )
      .setOrigin(0.5)
      .setDepth(2);

    // In the crypto build, hint that runs settle to a reward voucher. Stripped in clean.
    if (CRYPTO_BUILD) {
      this.add
        .text(cx, GAME_HEIGHT * 0.92, 'Crypto build: scores settle to a signed reward voucher.', {
          fontFamily: 'system-ui, sans-serif',
          fontSize: '11px',
          color: '#3f5a8a',
        })
        .setOrigin(0.5)
        .setDepth(2);
    }
  }
}
