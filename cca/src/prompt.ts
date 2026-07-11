import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { mute, MASK } from "./theme.ts";
import { stripEscapes } from "./input.ts";

const ENTER = new Set(["\r", "\n"]);
const CTRL_C = "\u0003";
const BACKSPACE = new Set(["\u007f", "\b"]);

async function readLine(label: string): Promise<string> {
  const rl = readline.createInterface({ input, output });
  try {
    return (await rl.question(label)).trim();
  } finally {
    rl.close();
  }
}

export function promptHidden(label: string): Promise<string> {
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    return readLine(label);
  }
  return new Promise<string>((resolve, reject) => {
    output.write(label);
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    let value = "";
    const finish = (settle: () => void): void => {
      input.setRawMode(false);
      input.pause();
      input.removeListener("data", onData);
      output.write("\n");
      settle();
    };
    const onData = (chunk: string): void => {
      for (const char of stripEscapes(chunk)) {
        if (ENTER.has(char)) {
          finish(() => {
            resolve(value.trim());
          });
          return;
        }
        if (char === CTRL_C) {
          finish(() => {
            reject(new Error("cancelled"));
          });
          return;
        }
        if (BACKSPACE.has(char)) {
          if (value.length > 0) {
            value = value.slice(0, -1);
            output.write("\b \b");
          }
        } else if (char >= " ") {
          value += char;
          output.write(mute(MASK));
        }
      }
    };
    input.on("data", onData);
  });
}
