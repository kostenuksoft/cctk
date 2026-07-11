const ESC = String.fromCharCode(27);
const DEL = String.fromCharCode(127);
const CSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, "g");
const SS3 = new RegExp(`${ESC}O.`, "g");

export function stripEscapes(chunk: string): string {
  return chunk.replace(CSI, "").replace(SS3, "").split(ESC).join("");
}

export function sanitizeTyped(chunk: string): string {
  let text = "";
  for (const char of stripEscapes(chunk)) {
    if (char >= " " && char !== DEL) {
      text += char;
    }
  }
  return text;
}
