import Phaser from 'phaser';
import { GAME_WIDTH, GAME_HEIGHT } from '../config.js';

export default class MenuScene extends Phaser.Scene {
  constructor() {
    super('Menu');
  }

  create() {
    const cx = GAME_WIDTH / 2;

    this.add
      .text(cx, GAME_HEIGHT * 0.3, 'PRANA TOWER DEFENSE', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '34px',
        color: '#cfe0ff',
        fontStyle: 'bold',
      })
      .setOrigin(0.5);

    this.add
      .text(cx, GAME_HEIGHT * 0.42, 'Defend the core. Place towers. Survive the waves.', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '15px',
        color: '#7f97c8',
      })
      .setOrigin(0.5);

    const btn = this.add
      .text(cx, GAME_HEIGHT * 0.62, '▶  PLAY', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '26px',
        color: '#0b1020',
        backgroundColor: '#62d0ff',
        padding: { x: 22, y: 12 },
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });

    btn.on('pointerover', () => btn.setStyle({ backgroundColor: '#9be4ff' }));
    btn.on('pointerout', () => btn.setStyle({ backgroundColor: '#62d0ff' }));
    btn.on('pointerup', () => this.scene.start('Play'));

    this.add
      .text(cx, GAME_HEIGHT * 0.86, 'Click a build cell to place the selected tower.', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '13px',
        color: '#54689a',
      })
      .setOrigin(0.5);
  }
}
