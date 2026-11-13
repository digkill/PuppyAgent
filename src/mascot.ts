import type { Language } from './types.ts';

// Native TypeScript port of the user's puppy_agent.py. No Python or image package at runtime.
type Point = [number, number];
type RGB = readonly [number, number, number];
const palette = {
  ink: [34, 43, 62], ear: [191, 113, 62], ear_hi: [230, 156, 93], ear_shadow: [155, 79, 46],
  face: [255, 238, 207], face_hi: [255, 248, 227], patch: [207, 132, 75], muzzle: [255, 250, 233],
  eye: [29, 38, 56], white: [255, 255, 255], nose: [55, 55, 70], blush: [245, 166, 145],
  tongue: [244, 113, 139], tongue_hi: [255, 172, 180],
} as const satisfies Record<string, RGB>;
type Color = keyof typeof palette;
const width = 68, height = 50;
const reset = '\x1b[0m';
const fg = (rgb: RGB) => `\x1b[38;2;${rgb.join(';')}m`;
const bg = (rgb: RGB) => `\x1b[48;2;${rgb.join(';')}m`;

export function renderMascot(options: { language: Language; columns?: number; color?: boolean }): string {
  if (options.color === false || (options.columns ?? 80) < width) {
    const subtitle = options.language === 'ru' ? 'твой верный ИИ-помощник' : 'your loyal AI coding companion';
    return String.raw` / \__` + `\n( oᴥo )  Puppy Agent\n /   \\   ${subtitle}\n`;
  }
  const pixels: (Color | null)[][] = Array.from({ length: height }, () => Array<Color | null>(width).fill(null));
  const ellipse = (cx: number, cy: number, rx: number, ry: number, color: Color) => {
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) pixels[y][x] = color;
    }
  };
  const polygon = (points: Point[], color: Color) => {
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      let inside = false, j = points.length - 1;
      for (let i = 0; i < points.length; i++) {
        const [xi, yi] = points[i], [xj, yj] = points[j];
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
        j = i;
      }
      if (inside) pixels[y][x] = color;
    }
  };
  const dot = (x: number, y: number, color: Color) => { if (x >= 0 && x < width && y >= 0 && y < height) pixels[y][x] = color; };
  const flip = (points: Point[]): Point[] => points.map(([x, y]) => [width - 1 - x, y]);
  const outer: Point[] = [[22, 10], [17, 6], [11, 5], [6, 8], [3, 15], [2, 24], [4, 33], [8, 37], [13, 36], [18, 31], [23, 18]];
  const inner: Point[] = [[20, 12], [16, 9], [12, 8], [8, 11], [6, 17], [5, 24], [7, 31], [10, 33], [14, 31], [19, 24]];
  const highlight: Point[] = [[10, 12], [8, 18], [8, 26], [10, 30], [14, 28], [15, 19]];
  const shadow: Point[] = [[5, 27], [7, 34], [11, 35], [15, 32], [12, 31], [8, 31]];
  polygon(outer, 'ink'); polygon(inner, 'ear'); polygon(highlight, 'ear_hi'); polygon(shadow, 'ear_shadow');
  polygon(flip(outer), 'ink'); polygon(flip(inner), 'ear'); polygon(flip(highlight), 'ear_hi'); polygon(flip(shadow), 'ear_shadow');
  ellipse(33.5, 24, 22, 21, 'ink'); ellipse(33.5, 23, 20, 19, 'face');
  ellipse(29, 15, 11, 9, 'face_hi'); ellipse(44.5, 21, 10, 11, 'patch');
  polygon([[27, 6], [30, 1], [34, 6], [38, 2], [39, 9], [33, 11]], 'ink');
  polygon([[29, 6], [31, 3], [34, 8], [37, 4], [37, 10], [32, 10]], 'face');
  ellipse(25, 22, 3.6, 4.2, 'ink'); ellipse(44, 22, 3.6, 4.2, 'ink');
  ellipse(26, 20.6, 1.2, 1.5, 'white'); ellipse(45, 20.6, 1.2, 1.5, 'white');
  ellipse(33.5, 33, 12.5, 9, 'ink'); ellipse(33.5, 32, 11.5, 8, 'muzzle');
  ellipse(29, 31, 4.2, 2.6, 'face_hi'); ellipse(38, 31, 4.2, 2.6, 'face_hi');
  polygon([[29, 29], [38, 29], [36, 33], [34, 35], [32, 34]], 'nose');
  ellipse(31, 30, 1.5, 0.8, 'white');
  for (let x = 26; x < 42; x++) dot(x, Math.trunc(34 + 0.048 * (x - 33.5) ** 2), 'ink');
  for (let y = 34; y < 39; y++) dot(34, y, 'ink');
  ellipse(34, 38, 4.3, 3.6, 'ink'); ellipse(34, 38, 3.4, 2.6, 'tongue'); ellipse(33, 37, 1.5, 0.8, 'tongue_hi');
  ellipse(19, 29, 2.4, 1.5, 'blush'); ellipse(49, 29, 2.4, 1.5, 'blush');
  const lines: string[] = [];
  for (let y = 0; y < height; y += 2) {
    let line = '';
    for (let x = 0; x < width; x++) {
      const top = pixels[y][x], bottom = pixels[y + 1][x];
      line += top === null && bottom === null ? ' '
        : top === null ? fg(palette[bottom!]) + '▄' + reset
        : bottom === null ? fg(palette[top]) + '▀' + reset
        : fg(palette[top]) + bg(palette[bottom]) + '▀' + reset;
    }
    lines.push(line.trimEnd());
  }
  const centered = (text: string, color: RGB, bold = false) => ' '.repeat(Math.max(0, Math.floor((width - text.length) / 2))) + fg(color) + (bold ? '\x1b[1m' : '') + text + reset;
  lines.push(centered('P U P P Y   A G E N T', [35, 195, 241], true));
  lines.push(centered(options.language === 'ru' ? 'твой верный ИИ-помощник в коде' : 'your loyal AI coding companion', [153, 163, 181]));
  lines.push(centered(options.language === 'ru' ? '● готов к работе  ·  гав!' : '● ready to code  ·  woof!', [81, 208, 163]));
  return lines.join('\n') + '\n';
}
