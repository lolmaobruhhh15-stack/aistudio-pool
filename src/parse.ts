/**
 * AI Studio GenerateContent response parser.
 * Wire format (see ../ai-studio-re/PROTOCOL.md): top-level array of frames.
 * frame = [ contentGroup, null, usage, null..., cursor ]
 * contentGroup holds [payloadArray, "model"] pairs. payload = [null, "text", ...]
 * with a trailing literal 1 for thinking chunks; payload.length===11 with
 * payload[10] = [name, typeEncodedArgs] for function calls.
 */
export interface ParsedChunk {
  kind: "thinking" | "text" | "usage" | "meta";
  text?: string;
  usage?: { promptTokens?: number; totalTokens?: number };
  cursor?: string;
  title?: string;
}

export function parseGenerateContent(body: string): ParsedChunk[] {
  let top: any;
  try { top = JSON.parse(body); } catch { return []; }
  if (!Array.isArray(top)) top = [top];
  const out: ParsedChunk[] = [];
  for (const frame of top) {
    if (!Array.isArray(frame)) continue;
    // collect every [payload, "model"] pair anywhere in frame[0]
    const pairs: any[][] = [];
    collectModelPairs(frame, pairs);
    for (const pair of pairs) {
      let payload: any = pair[0];
      // unwrap single-element array wrappers: [ [ [payloadParts] ] ] -> payloadParts
      while (Array.isArray(payload) && payload.length === 1 && Array.isArray(payload[0])) payload = payload[0];
      if (!Array.isArray(payload)) continue;
      const text = payload.find((el: any) => typeof el === "string");
      if (typeof text !== "string") continue;
      if (payload.length === 2) out.push({ kind: "text", text });
      else if (payload.length === 11 && payload[1] === null && Array.isArray(payload[10])) {
        // function call frame — text slot may be absent; handled by caller via fc field
        out.push({ kind: "text", text: `\n[function call: ${payload[10][0]}]` });
      } else {
        const isThinking = payload[payload.length - 1] === 1;
        out.push({ kind: isThinking ? "thinking" : "text", text });
      }
    }
    if (Array.isArray(frame[2])) {
      const u = frame[2];
      out.push({ kind: "usage", usage: { promptTokens: num(u[0]), totalTokens: num(u[2]) ?? num(u[1]) } });
    }
    if (typeof frame[8] === "string" && frame[8].startsWith("v1_")) out.push({ kind: "meta", cursor: frame[8] });
  }
  return out;
}

function num(v: any): number | undefined { return typeof v === "number" ? v : undefined; }

/** Parse ONE top-level frame (streaming path). */
export function parseFrame(frame: any): ParsedChunk[] {
  const out: ParsedChunk[] = [];
  if (!Array.isArray(frame)) return out;
  const pairs: any[][] = [];
  collectModelPairs(frame, pairs);
  for (const pair of pairs) {
    let payload: any = pair[0];
    while (Array.isArray(payload) && payload.length === 1 && Array.isArray(payload[0])) payload = payload[0];
    if (!Array.isArray(payload)) continue;
    const text = payload.find((el: any) => typeof el === "string");
    if (typeof text !== "string") continue;
    if (payload.length === 2) out.push({ kind: "text", text });
    else if (payload.length === 11 && payload[1] === null && Array.isArray(payload[10])) {
      out.push({ kind: "text", text: `\n[function call: ${payload[10][0]}]` });
    } else {
      const isThinking = payload[payload.length - 1] === 1;
      out.push({ kind: isThinking ? "thinking" : "text", text });
    }
  }
  if (Array.isArray(frame[2])) {
    const u = frame[2];
    out.push({ kind: "usage", usage: { promptTokens: num(u[0]), totalTokens: num(u[2]) ?? num(u[1]) } });
  }
  if (typeof frame[8] === "string" && frame[8].startsWith("v1_")) out.push({ kind: "meta", cursor: frame[8] });
  return out;
}

/**
 * Incremental splitter for the streamed GenerateContent body (one growing top-level
 * JSON array of frames). Feed chunks in; complete frames come out as they close.
 */
export class FrameSplitter {
  private buf = "";
  private depth = 0;
  private inStr = false;
  private esc = false;
  private elemStart = -1;
  private pos = 0;

  push(chunk: string): ParsedChunk[][] {
    this.buf += chunk;
    const out: ParsedChunk[][] = [];
    let i = this.pos;
    while (i < this.buf.length) {
      const c = this.buf[i];
      if (this.inStr) {
        if (this.esc) this.esc = false;
        else if (c === "\\") this.esc = true;
        else if (c === '"') this.inStr = false;
      } else if (c === '"') {
        this.inStr = true;
      } else if (c === "[") {
        this.depth++;
        if (this.depth === 2 && this.elemStart < 0) this.elemStart = i;
      } else if (c === "]") {
        this.depth--;
        if (this.depth === 1 && this.elemStart >= 0) {
          const piece = this.buf.slice(this.elemStart, i + 1);
          try { out.push(parseFrame(JSON.parse(piece))); } catch {}
          this.buf = this.buf.slice(i + 1);
          this.elemStart = -1;
          this.pos = 0;
          i = -1;
        } else if (this.depth === 0) {
          this.buf = "";
          this.pos = 0;
          this.inStr = false;
          this.esc = false;
          this.elemStart = -1;
          return out;
        }
      }
      i++;
    }
    this.pos = this.buf.length;
    return out;
  }
}

function collectModelPairs(node: any, out: any[][], depth = 0) {
  if (depth > 6 || !Array.isArray(node)) return;
  if (node.length === 2 && node[1] === "model" && Array.isArray(node[0])) {
    out.push(node);
    return; // payloads are leaves; don't recurse into them
  }
  for (const child of node) collectModelPairs(child, out, depth + 1);
}

/** Merge consecutive same-kind chunks into {thinking, text}. */
export function mergeChunks(chunks: ParsedChunk[]) {
  const acc = { thinking: "", text: "" };
  for (const c of chunks) {
    if (c.kind === "thinking") acc.thinking += c.text ?? "";
    else if (c.kind === "text") acc.text += c.text ?? "";
  }
  return acc;
}
