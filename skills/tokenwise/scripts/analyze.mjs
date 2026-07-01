#!/usr/bin/env node
// tokenwise — analyze Claude Code session transcripts for what burned tokens & dollars.
//
// Usage:
//   node analyze.mjs                      # this project's latest session (+ subagents)
//   node analyze.mjs <transcript.jsonl>   # a specific session transcript
//   node analyze.mjs <session-dir>        # a dir of .jsonl files (recurses subagents/)
//   node analyze.mjs --trend [project-dir]# cost across ALL sessions in a project
//   node analyze.mjs --json [target]      # machine-readable output (for CI cost gates)
//
// Zero dependencies. Node 18+. Read-only: it only reads transcript files.
// The heavy parsing runs locally and prints a COMPACT report — the whole point.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const CHARS_PER_TOKEN = 4; // rough estimate; transcripts don't store per-tool-result token counts
const approxTok = (s) => Math.ceil((typeof s === "string" ? s.length : 0) / CHARS_PER_TOKEN);
const fmt = (n) => n.toLocaleString("en-US");
const k = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n));
const usd = (n) => (n >= 0.01 || n === 0 ? "$" + n.toFixed(2) : "$" + n.toFixed(4));

// Base $/1M-token rates (Anthropic public pricing, as of 2026-07; edit if they change).
// Cache multipliers: write-5m = 1.25x input, write-1h = 2x input, read = 0.1x input.
function rate(model) {
  const m = (model || "").toLowerCase();
  if (m.includes("fable") || m.includes("mythos")) return { in: 10, out: 50 };
  if (m.includes("opus")) return { in: 5, out: 25 };
  if (m.includes("sonnet")) return { in: 3, out: 15 };
  if (m.includes("haiku")) return { in: 1, out: 5 };
  return { in: 5, out: 25 }; // unknown → assume Opus-tier so we never under-report
}
// b = {inp, cc5m, cc1h, cr, out} in tokens; exact $ (usage fields are exact, not estimated)
function costOf(b, model) {
  const r = rate(model);
  return (b.inp * r.in + b.cc5m * r.in * 1.25 + b.cc1h * r.in * 2 + b.cr * r.in * 0.1 + b.out * r.out) / 1e6;
}
const gradeOf = (hit) => (hit >= 90 ? "A" : hit >= 75 ? "B" : hit >= 50 ? "C" : hit >= 25 ? "D" : "F");

// ---------- arg parsing ----------
const argv = process.argv.slice(2);
const JSON_OUT = argv.includes("--json");
const TREND = argv.includes("--trend");
const target = argv.find((a) => !a.startsWith("--"));

// ---------- locate transcripts ----------
function projectDirFromCwd() {
  return path.join(os.homedir(), ".claude", "projects", process.cwd().replace(/\//g, "-"));
}
function newestJsonlIn(dir) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"))
    .map((p) => ({ p: path.join(dir, p), m: fs.statSync(path.join(dir, p)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  return files.length ? files[0].p : null;
}
function subagentsOf(projectDir, mainFile) {
  const dir = path.join(projectDir, path.basename(mainFile, ".jsonl"), "subagents");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => ({ file: path.join(dir, f), kind: "subagent" }));
}
function resolveTargets(arg) {
  if (arg) {
    const st = fs.existsSync(arg) ? fs.statSync(arg) : null;
    if (!st) { console.error(`tokenwise: not found: ${arg}`); process.exit(1); }
    if (st.isFile()) return [{ file: arg, kind: "main" }];
    const out = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const fp = path.join(d, e.name);
        if (e.isDirectory()) walk(fp);
        else if (e.name.endsWith(".jsonl")) out.push({ file: fp, kind: fp.includes(`${path.sep}subagents${path.sep}`) ? "subagent" : "main" });
      }
    })(arg);
    return out;
  }
  const projectDir = projectDirFromCwd();
  const main = newestJsonlIn(projectDir);
  if (!main) { console.error(`tokenwise: no transcript for this project (looked in ${projectDir}). Pass a .jsonl path.`); process.exit(1); }
  return [{ file: main, kind: "main" }, ...subagentsOf(projectDir, main)];
}
function resolveSessions(arg) {
  const dir = arg && fs.statSync(arg).isDirectory() ? arg : projectDirFromCwd();
  if (!fs.existsSync(dir)) { console.error(`tokenwise: project dir not found: ${dir}`); process.exit(1); }
  const sessions = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    const main = path.join(dir, f);
    sessions.push({ id: path.basename(f, ".jsonl"), files: [{ file: main, kind: "main" }, ...subagentsOf(dir, main)] });
  }
  return { dir, sessions };
}

// ---------- extract a human label for a tool call ----------
function targetOf(b) {
  const i = b.input || {};
  switch (b.name) {
    case "Read": case "Edit": case "Write": case "NotebookEdit":
      return i.file_path ? path.basename(i.file_path) : b.name;
    case "Bash": return (i.command || i.description || "").slice(0, 48).replace(/\s+/g, " ");
    case "Grep": return `grep ${(i.pattern || "").slice(0, 32)}`;
    case "Glob": return `glob ${(i.pattern || "").slice(0, 32)}`;
    case "Agent": case "Task": return `agent: ${(i.description || "").slice(0, 40)}`;
    case "WebFetch": return `fetch ${(i.url || "").slice(0, 40)}`;
    default: return b.name;
  }
}
const textOf = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => (typeof x === "string" ? x : x?.text || "")).join("") : "");

// ---------- analyze one file ----------
function analyzeFile(file) {
  let lines = [];
  try { lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean); } catch { return null; }
  let turns = 0, out = 0, inp = 0, cc = 0, cr = 0, firstTs = "", lastTs = "";
  const models = new Set();
  const byModel = new Map();
  const toolUses = new Map();
  const toolCalls = new Map();
  const readCounts = new Map();
  const results = [];
  for (const line of lines) {
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.timestamp) { if (!firstTs) firstTs = o.timestamp; lastTs = o.timestamp; }
    const msg = o.message;
    if (o.type === "assistant" && msg) {
      turns++;
      const u = msg.usage || {};
      out += u.output_tokens || 0; inp += u.input_tokens || 0;
      cc += u.cache_creation_input_tokens || 0; cr += u.cache_read_input_tokens || 0;
      if (msg.model) models.add(msg.model);
      const model = msg.model || "unknown";
      const b = byModel.get(model) || { inp: 0, cc5m: 0, cc1h: 0, cr: 0, out: 0 };
      b.inp += u.input_tokens || 0; b.cr += u.cache_read_input_tokens || 0; b.out += u.output_tokens || 0;
      const ccb = u.cache_creation || {};
      const c5 = ccb.ephemeral_5m_input_tokens || 0, c1 = ccb.ephemeral_1h_input_tokens || 0;
      if (c5 || c1) { b.cc5m += c5; b.cc1h += c1; } else { b.cc5m += u.cache_creation_input_tokens || 0; }
      byModel.set(model, b);
      if (Array.isArray(msg.content)) for (const blk of msg.content) {
        if (!blk || !blk.type) continue;
        if (blk.type === "tool_use") {
          toolUses.set(blk.id, { name: blk.name, target: targetOf(blk), turn: turns });
          const t = toolCalls.get(blk.name) || { count: 0, resultTok: 0 }; t.count++; toolCalls.set(blk.name, t);
          if (blk.name === "Read" && blk.input?.file_path) readCounts.set(blk.input.file_path, (readCounts.get(blk.input.file_path) || 0) + 1);
        }
      }
    } else if (msg && Array.isArray(msg.content)) {
      for (const blk of msg.content) if (blk && blk.type === "tool_result") {
        const tu = toolUses.get(blk.tool_use_id) || {};
        const tok = approxTok(textOf(blk.content));
        results.push({ name: tu.name || "?", target: tu.target || "(result)", tok, turn: tu.turn || turns });
        const t = toolCalls.get(tu.name); if (t) t.resultTok += tok;
      }
    }
  }
  return { file, turns, out, inp, cc, cr, firstTs, lastTs, models: [...models], byModel, toolCalls, readCounts, results };
}

// ---------- aggregate a set of file-analyses into one report's worth of metrics ----------
function aggregate(list) {
  const A = list.map((t) => ({ ...t, a: analyzeFile(t.file) })).filter((x) => x.a);
  const turns = A.reduce((s, x) => s + x.a.turns, 0);
  const out = A.reduce((s, x) => s + x.a.out, 0);
  const inp = A.reduce((s, x) => s + x.a.inp, 0);
  const cc = A.reduce((s, x) => s + x.a.cc, 0);
  const cr = A.reduce((s, x) => s + x.a.cr, 0);
  const processed = out + inp + cc + cr;
  const cacheHit = cr + cc + inp > 0 ? Math.round((cr / (cr + cc + inp)) * 100) : 0;
  const mainOut = A.filter((x) => x.kind === "main").reduce((s, x) => s + x.a.out, 0);
  const subOut = A.filter((x) => x.kind === "subagent").reduce((s, x) => s + x.a.out, 0);

  const modelBuckets = new Map();
  for (const x of A) for (const [model, b] of x.a.byModel) {
    const cur = modelBuckets.get(model) || { inp: 0, cc5m: 0, cc1h: 0, cr: 0, out: 0 };
    for (const key of ["inp", "cc5m", "cc1h", "cr", "out"]) cur[key] += b[key];
    modelBuckets.set(model, cur);
  }
  let cost = 0; const costRows = [];
  for (const [model, b] of modelBuckets) { const c = costOf(b, model); cost += c; costRows.push([model, c]); }
  costRows.sort((a, b) => b[1] - a[1]);
  const domModel = costRows.length ? costRows[0][0] : "claude-opus-4-8";

  const allResults = A.flatMap((x) => x.a.results.map((r) => ({ ...r, kind: x.kind, N: x.a.turns, footprint: r.tok * Math.max(0, x.a.turns - r.turn) })));
  const redundant = new Map();
  for (const x of A) for (const [f, c] of x.a.readCounts) if (c >= 2) redundant.set(f, (redundant.get(f) || 0) + c);
  const tools = new Map();
  for (const x of A) for (const [n, t] of x.a.toolCalls) { const cur = tools.get(n) || { count: 0, resultTok: 0 }; cur.count += t.count; cur.resultTok += t.resultTok; tools.set(n, cur); }

  const firstTs = A.map((x) => x.a.firstTs).filter(Boolean).sort()[0] || "";
  const lastTs = A.map((x) => x.a.lastTs).filter(Boolean).sort().slice(-1)[0] || "";
  const models = [...new Set(A.flatMap((x) => x.a.models))];
  return { A, turns, out, inp, cc, cr, processed, cacheHit, grade: gradeOf(cacheHit), mainOut, subOut, cost, costRows, domModel, allResults, redundant, tools, firstTs, lastTs, models };
}

// ================= TREND MODE =================
if (TREND) {
  const { dir, sessions } = resolveSessions(target);
  const rows = sessions.map((s) => { const g = aggregate(s.files); return { id: s.id, cost: g.cost, turns: g.turns, out: g.out, grade: g.grade, cacheHit: g.cacheHit, lastTs: g.lastTs }; })
    .filter((r) => r.turns > 0);
  const total = rows.reduce((s, r) => s + r.cost, 0);
  if (JSON_OUT) { console.log(JSON.stringify({ project_dir: dir, sessions: rows, total_cost_usd: +total.toFixed(4), currency: "USD", note: "token rates as of 2026-07; edit analyze.mjs to change" }, null, 2)); process.exit(0); }
  rows.sort((a, b) => (a.lastTs < b.lastTs ? 1 : -1));
  const L = [];
  L.push(`TOKENWISE TREND  —  ${rows.length} sessions in ${dir}`);
  L.push(`Total across all sessions: ${usd(total)}   (token rates as of 2026-07)`);
  L.push("");
  L.push("date        cost      turns  grade  session");
  for (const r of rows.slice(0, 40)) {
    const date = (r.lastTs || "").slice(0, 10) || "?".padEnd(10);
    L.push(`${date}  ${usd(r.cost).padStart(8)}  ${String(r.turns).padStart(5)}  ${r.grade.padStart(5)}  ${r.id.slice(0, 8)}`);
  }
  if (rows.length > 40) L.push(`… and ${rows.length - 40} more sessions`);
  L.push("");
  const top = [...rows].sort((a, b) => b.cost - a.cost)[0];
  if (top) L.push(`Most expensive session: ${usd(top.cost)} (${top.turns} turns, grade ${top.grade}) — ${top.id.slice(0, 8)}`);
  console.log(L.join("\n"));
  process.exit(0);
}

// ================= SINGLE-REPORT MODE =================
const g = aggregate(resolveTargets(target));
if (!g.A.length) { console.error("tokenwise: nothing to analyze."); process.exit(1); }

const readRate = rate(g.domModel).in * 0.1; // $/MTok when a block is re-read from cache
const bySize = [...g.allResults].sort((a, b) => b.tok - a.tok).slice(0, 8);
const byFootprint = [...g.allResults].sort((a, b) => b.footprint - a.footprint).slice(0, 6);

// quantified savings
const opps = [];
const readFootprint = g.allResults.filter((r) => r.name === "Read").reduce((s, r) => s + r.footprint, 0);
const spanSave = (readFootprint * readRate / 1e6) * 0.9;
if (spanSave > 0.01) opps.push(`Read spans, not whole files: ~${usd(spanSave)} reclaimable. Big early Reads re-bill as cache-reads every later turn; offset/limit or grep-then-read the relevant lines.`);
let downgradeSave = 0;
for (const x of g.A) if (x.kind === "subagent") for (const [model, b] of x.a.byModel) {
  const m = model.toLowerCase();
  if (m.includes("opus") || m.includes("fable")) { const s = costOf(b, model) - costOf(b, "claude-sonnet-4-6"); if (s > 0) downgradeSave += s; }
}
if (downgradeSave > 0.01) opps.push(`Cheaper model for subagents: ~${usd(downgradeSave)} if the premium-model subagent work ran on Sonnet. Reserve Opus/Fable for reasoning that needs it.`);
if (g.redundant.size) opps.push(`Kill ${g.redundant.size} redundant re-read${g.redundant.size > 1 ? "s" : ""}: the file was already in context after the first Read.`);

if (JSON_OUT) {
  console.log(JSON.stringify({
    files: g.A.length, models: g.models,
    cost_usd: +g.cost.toFixed(4), cost_by_model: g.costRows.map(([m, c]) => ({ model: m, usd: +c.toFixed(4) })),
    cache_grade: g.grade, cache_read_share_pct: g.cacheHit,
    turns: g.turns, output_tokens: g.out, input_uncached: g.inp, cache_created: g.cc, cache_read: g.cr,
    main_output: g.mainOut, subagent_output: g.subOut,
    top_by_footprint: byFootprint.map((r) => ({ tool: r.name, target: r.target, tokens: r.tok, turn: r.turn, of: r.N, footprint_tok_turns: r.footprint })),
    redundant_reads: [...g.redundant].map(([f, c]) => ({ file: f, count: c })),
    savings_opportunities: opps,
    note: "token counts for tool-result sizes are chars/4 estimates; usage-field totals & cost are exact. rates as of 2026-07.",
  }, null, 2));
  process.exit(0);
}

const L = [];
L.push("TOKENWISE REPORT  (tool-result sizes are estimates: transcript chars ÷ 4; usage totals & cost are exact)");
L.push(`Files analyzed: ${g.A.length}  (main: ${g.A.filter((x) => x.kind === "main").length}, subagents: ${g.A.filter((x) => x.kind === "subagent").length})`);
L.push(`Models: ${g.models.join(", ") || "n/a"}`);
L.push("");
L.push("── TOTALS ──");
L.push(`Assistant turns: ${fmt(g.turns)}`);
L.push(`Output (generated) tokens: ${fmt(g.out)}`);
L.push(`Input — uncached: ${fmt(g.inp)} | cache-created: ${fmt(g.cc)} | cache-read: ${fmt(g.cr)}`);
L.push(`Total tokens processed (billed mix): ${fmt(g.processed)}   | cache-read share: ${g.cacheHit}%`);
if (g.subOut > 0) L.push(`Output split — main: ${fmt(g.mainOut)}  |  subagents: ${fmt(g.subOut)}  (${Math.round(g.subOut / (g.out || 1) * 100)}% went to subagents)`);
L.push("");
L.push("── COST (exact — from usage fields, at listed $/MTok rates) ──");
L.push(`Estimated session cost: ${usd(g.cost)}    |    cache-efficiency grade: ${g.grade} (${g.cacheHit}% served from cache)`);
if (g.costRows.length > 1) g.costRows.forEach(([m, c]) => L.push(`  • ${m}: ${usd(c)}`));
L.push("");
L.push("── BIGGEST TOOL RESULTS (by size) ── these sit in context and re-bill on every later turn");
bySize.forEach((r, i) => L.push(`${i + 1}. [${r.name}] ${r.target} — ~${k(r.tok)} tok @ turn ${r.turn}/${r.N}${r.kind === "subagent" ? " (subagent)" : ""}`));
L.push("");
L.push("── HIGHEST COMPOUNDING FOOTPRINT ── size × turns it stayed in context (the real cost driver)");
byFootprint.forEach((r, i) => L.push(`${i + 1}. [${r.name}] ${r.target} — ~${k(r.tok)} tok × ${Math.max(0, r.N - r.turn)} turns ≈ ${k(r.footprint)} tok-turns`));
L.push("");
if (g.redundant.size) {
  L.push("── REDUNDANT READS (same file read ≥2×) ──");
  [...g.redundant.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).forEach(([f, c]) => L.push(`• ${path.basename(f)} — ${c}× (${f})`));
  L.push("");
}
L.push("── TOOL BREAKDOWN (by result tokens pulled into context) ──");
[...g.tools.entries()].sort((a, b) => b[1].resultTok - a[1].resultTok).forEach(([n, t]) => L.push(`• ${n}: ${t.count} calls, ~${k(t.resultTok)} tok of results`));
L.push("");
if (byFootprint.length) {
  const top = byFootprint[0];
  const wasteUsd = (top.footprint * readRate) / 1e6;
  L.push("── BIGGEST WIN ──");
  L.push(`Reading [${top.name}] ${top.target} early cost ~${usd(wasteUsd)} in cache re-reads (~${k(top.footprint)} tok-turns).`);
  L.push(`Reading only the needed span (say ~10% of it) would reclaim most of that. Multiply across every long session.`);
  L.push("");
}
if (opps.length) {
  L.push("── SAVINGS OPPORTUNITIES (quantified) ──");
  opps.forEach((o, i) => L.push(`${i + 1}. ${o}`));
  L.push("");
}
L.push("── FILES ──");
g.A.forEach((x) => L.push(`• ${x.kind}: ${path.basename(x.file)} — ${x.a.turns} turns, out ${k(x.a.out)}`));
console.log(L.join("\n"));
