import fs from "node:fs";
const b: string = JSON.parse(fs.readFileSync("C:/Users/Pedp4WPBX5105GRF0322/.zcode/workspace/default/tmp/exp_ab_capture.json", "utf8")).body;
console.log("len:", b.length);
console.log("first 100:", b.slice(0, 100));
console.log("starts:", JSON.stringify(b.slice(0, 3)));
// where do top-level commas sit? find depth-1 commas by scan
let depth = 0, inStr = false, esc = false;
const depth1Commas: number[] = [];
for (let i = 0; i < Math.min(b.length, 2000); i++) {
  const c = b[i];
  if (inStr) {
    if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false;
  } else if (c === '"') inStr = true;
  else if (c === "[") depth++;
  else if (c === "]") depth--;
  else if (c === "," && depth === 1) depth1Commas.push(i);
}
console.log("depth-1 commas in first 2000 chars:", depth1Commas.slice(0, 5));
