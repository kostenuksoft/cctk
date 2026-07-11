function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let started = false;
  for (const ch of line) {
    if (quote !== undefined) {
      if (ch === quote) {
        quote = undefined;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) {
    tokens.push(current);
  }
  return tokens;
}

export function parsePipeline(raw: string): string[] {
  const args: string[] = [];
  for (const rawLine of raw.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    args.push(...tokenize(line));
  }
  return args;
}

export function formatPipeline(args: readonly string[]): string {
  return args.map((arg) => (/\s/.test(arg) || arg === "" ? JSON.stringify(arg) : arg)).join(" ");
}
