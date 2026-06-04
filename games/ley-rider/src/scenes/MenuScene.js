import Phaser from 'phaser';
import { GAME_WIDTH, GAME_HEIGHT } from '../config.js';

export default class MenuScene extends Phaser.Scene {
  constructor() {
    super('Menu');
  }

  create() {
    const cx = GAME_WIDTH / 2;

    this.add
      .text(cx, 120, 'PRANA LEY RIDER', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '40px',
        color: '#cfe0ff',
        fontStyle: 'bold',
      })
      .setOrigin(0.5);

    this.add
      .text(cx, 168, 'draw a track · ride the line', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '16px',
        color: '#6f86b8',
      })
      .setOrigin(0.5);

    const help = [
      'DRAW MODE',
      '  drag — lay track       [B] toggle boost line (accelerates)',
      '  [E] eraser             [S] place start flag   [F] place finish flag',
      '  space / right-drag — pan the canvas',
      '',
      'RIDE MODE',
      '  [Enter] — ride / stop          camera follows the sled',
      '  reach the finish flag for a best time; fall off = run over',
      '',
      '  [Ctrl+S] save   [Ctrl+L] load   [Ctrl+E] export   [Ctrl+I] import',
    ];
    this.add
      .text(cx, 250, help.join('\n'), {
        fontFamily: 'monospace',
        fontSize: '14px',
        color: '#9fb4dd',
        align: 'left',
        lineSpacing: 4,
      })
      .setOrigin(0.5, 0);

    const btn = this.add
      .text(cx, GAME_HEIGHT - 90, '▶  START', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '26px',
        color: '#070b16',
        backgroundColor: '#6fd3ff',
        padding: { x: 22, y: 10 },
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });

    btn.on('pointerover', () => btn.setStyle({ backgroundColor: '#9fe2ff' }));
    btn.on('pointerout', () => btn.setStyle({ backgroundColor: '#6fd3ff' }));
    btn.on('pointerup', () => this.scene.start('Track'));

    this.input.keyboard.once('keydown-ENTER', () => this.scene.start('Track'));
  }
}
