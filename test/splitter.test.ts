import { FrameSplitter, mergeChunks } from "../src/parse.js";
import fs from "node:fs";

const body = JSON.parse(fs.readFileSync("C:/Users/Pedp4WPBX5105GRF0322/.zcode/workspace/default/tmp/exp_ab_capture.json", "utf8")).body;
const sp = new FrameSplitter();
let all: any[] = [];
for (let i = 0; i < body.length; i += 37) {
  for (const fr of sp.push(body.slice(i, i + 37))) all.push(...fr);
}
for (const fr of sp.push("")) all.push(...fr);
const m = mergeChunks(all);
console.log("chunks:", all.length, "| text len:", m.text.length, "| thinking len:", m.thinking.length);
console.log("text head:", JSON.stringify(m.text.slice(0, 80)));
