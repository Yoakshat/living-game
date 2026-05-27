import Phaser from 'phaser';
import WorldScene from './scenes/WorldScene.js';

const config = {
  type: Phaser.AUTO,
  parent: 'game',
  backgroundColor: '#2d402a',
  pixelArt: false,
  // RESIZE scale mode: the canvas always fills the viewport and the camera
  // shows more/less of the world as the window changes — no black bars, no
  // squashing. The camera stays centered on the player, so the player remains
  // visible after any resize.
  scale: {
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: window.innerWidth,
    height: window.innerHeight,
  },
  physics: {
    default: 'arcade',
    arcade: {
      gravity: { x: 0, y: 0 },
      debug: false,
    },
  },
  scene: [WorldScene],
};

const game = new Phaser.Game(config);

// Keep the canvas focused so WASD is captured immediately on load. Clicking the
// canvas also re-focuses it.
window.addEventListener('load', () => {
  const canvas = game.canvas;
  if (canvas) {
    canvas.setAttribute('tabindex', '0');
    canvas.focus();
    canvas.addEventListener('click', () => canvas.focus());
  }
});
