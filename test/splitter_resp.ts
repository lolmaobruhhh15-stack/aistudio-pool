import fs from "node:fs";
import { FrameSplitter, mergeChunks } from "../src/parse.js";

// grab a real GenerateContent response body from today's bodies capture
const bodies = fs.readFileSync("C:/Users/Pedp4WPBX5105GRF0322/.zcode/workspace/default/tmp/capture_ais_bodies.json", "utf8")
  .trim().split("\n").map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const resp = bodies.find((b: any) => b.url.includes("GenerateContent") && b.len > 1000);
if (!resp) { console.log("NO RESPONSE BODY FOUND"); process.exit(1); }
console.log("resp len:", resp.len);

const sp = new FrameSplitter();
let all: any[] = [];
for (let i = 0; i < resp.body.length; i += 53) {
  for (const fr of sp.push(resp.body.slice(i, i + 53))) all.push(...fr);
}
for (const fr of sp.push("")) all.push(...fr);
const m = mergeChunks(all);
console.log("chunks:", all.length, "| text:", m.text.length, "| thinking:", m.thinking.length);
console.log("text head:", JSON.stringify(m.text.slice(0, 70)));
