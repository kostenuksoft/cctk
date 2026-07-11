const CLAY = 173;
const EMBER = 209;
const CREAM = 230;
const SAND = 223;
const MUTE = 245;
const SAGE = 108;

export const SPARKLE = "✳";
export const MASK = "•";

const MASCOT = [" ▐▛███▜▌", "▝▜█████▛▘", "  ▘▘ ▝▝"] as const;

function paint(code: number, text: string): string {
  return `\x1b[38;5;${code}m${text}\x1b[39m`;
}

export const clay = (text: string): string => paint(CLAY, text);
export const ember = (text: string): string => paint(EMBER, text);
export const cream = (text: string): string => paint(CREAM, text);
export const sand = (text: string): string => paint(SAND, text);
export const mute = (text: string): string => paint(MUTE, text);
export const sage = (text: string): string => paint(SAGE, text);
export const bold = (text: string): string => `\x1b[1m${text}\x1b[22m`;

const ACCOUNT_COLORS = [173, 209, 108, 110, 141, 180, 114, 216, 175, 79] as const;

function accountHash(text: string): number {
  let hash = 0;
  for (const char of text) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return hash;
}

export function colorFor(name: string): number {
  return ACCOUNT_COLORS[accountHash(name) % ACCOUNT_COLORS.length] ?? CLAY;
}

export type Rgb = readonly [number, number, number];

export const GLYPHS: readonly string[] = ["●", "◆", "■", "▲", "▼", "★", "♦", "◉", "⬢", "✦"];

export const PALETTE: readonly Rgb[] = [
  [231, 111, 100],
  [234, 158, 94],
  [231, 199, 106],
  [150, 206, 122],
  [104, 201, 178],
  [110, 178, 235],
  [150, 150, 236],
  [193, 138, 232],
  [236, 138, 200],
  [201, 201, 206],
];

function accountSpec(name: string, rgb: Rgb | undefined): string {
  return rgb === undefined ? `38;5;${colorFor(name)}` : `38;2;${rgb[0]};${rgb[1]};${rgb[2]}`;
}

export function accent(name: string, rgb: Rgb | undefined, text: string): string {
  return `\x1b[${accountSpec(name, rgb)}m${text}\x1b[39m`;
}

export function swatch(name: string, rgb: Rgb | undefined, glyph?: string): string {
  const cell = glyph === undefined || glyph === "" ? "██" : [...glyph].length >= 2 ? glyph : `${glyph} `;
  return `\x1b[${accountSpec(name, rgb)}m${cell}\x1b[39m`;
}

export function banner(): string {
  const width = Math.max(...MASCOT.map((line) => line.length));
  const captions = [bold(cream("cca")), sand("account switcher"), mute("© kostenuksoft")];
  return MASCOT.map((line, index) => {
    const caption = captions[index] ?? "";
    return `${clay(line.padEnd(width))}${caption === "" ? "" : `  ${caption}`}`;
  }).join("\n");
}
