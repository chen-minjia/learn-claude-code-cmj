#!/usr/bin/env node
// Harness: all mechanisms combined -- the complete cockpit for the model.
/**
 * s_full.ts - Full Reference Agent
 *
 * Capstone implementation combining every mechanism from s01-s11.
 * Session s12 (task-aware worktree isolation) is taught separately.
 * NOT a teaching session -- this is the "put it all together" reference.
 *
 *     +------------------------------------------------------------------+
 *     |                        FULL AGENT                                 |
 *     |                                                                   |
 *     |  System prompt (s05 skills, task-first + optional todo nag)      |
 *     |                                                                   |
 *     |  Before each LLM call:                                            |
 *     |  +--------------------+  +------------------+  +--------------+  |
 *     |  | Microcompact (s06) |  | Drain bg (s08)   |  | Check inbox  |  |
 *     |  | Auto-compact (s06) |  | notifications    |  | (s09)        |  |
 *     |  +--------------------+  +------------------+  +--------------+  |
 *     |                                                                   |
 *     |  Tool dispatch (s02 pattern):                                     |
 *     |  +--------+----------+----------+---------+-----------+          |
 *     |  | bash   | read     | write    | edit    | TodoWrite |          |
 *     |  | task   | load_sk  | compress | bg_run  | bg_check  |          |
 *     |  | t_crt  | t_get    | t_upd    | t_list  | spawn_tm  |          |
 *     |  | list_tm| send_msg | rd_inbox | bcast   | shutdown  |          |
 *     |  | plan   | idle     | claim    |         |           |          |
 *     |  +--------+----------+----------+---------+-----------+          |
 *     |                                                                   |
 *     |  Subagent (s04):  spawn -> work -> return summary                 |
 *     |  Teammate (s09):  spawn -> work -> idle -> auto-claim (s11)      |
 *     |  Shutdown (s10):  request_id handshake                            |
 *     |  Plan gate (s10): submit -> approve/reject                        |
 *     +------------------------------------------------------------------+
 *
 *     REPL commands: /compact /tasks /team /inbox
 */

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { randomUUID } from "crypto";
import Anthropic from "@anthropic-ai/sdk";
import * as dotenv from "dotenv";

dotenv.config({ override: true });
if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

const WORKDIR: string = process.cwd();
const client = new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL });
const MODEL: string = process.env.MODEL_ID as string;

const TEAM_DIR: string = path.join(WORKDIR, ".team");
const INBOX_DIR: string = path.join(TEAM_DIR, "inbox");
const TASKS_DIR: string = path.join(WORKDIR, ".tasks");
const SKILLS_DIR: string = path.join(WORKDIR, "skills");
const TRANSCRIPT_DIR: string = path.join(WORKDIR, ".transcripts");
const TOKEN_THRESHOLD = 100000;
const POLL_INTERVAL = 5;
const IDLE_TIMEOUT = 60;

const VALID_MSG_TYPES = new Set([
  "message",
  "broadcast",
  "shutdown_request",
  "shutdown_response",
  "plan_approval_response",
]);

// Small helper to mimic Python's time.sleep in async contexts.
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// === SECTION: base_tools ===
function safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  if (!(resolved === WORKDIR || resolved.startsWith(WORKDIR + path.sep))) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}

function runBash(command: string): string {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => command.includes(d))) {
    return "Error: Dangerous command blocked";
  }
  try {
    const out = execSync(command, {
      shell: "/bin/sh",
      cwd: WORKDIR,
      encoding: "utf-8",
      timeout: 120000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const trimmed = out.trim();
    return trimmed ? trimmed.slice(0, 50000) : "(no output)";
  } catch (e: any) {
    if (e.killed) {
      return "Error: Timeout (120s)";
    }
    const out = ((e.stdout || "") + (e.stderr || "")).trim();
    return out ? out.slice(0, 50000) : "(no output)";
  }
}

function runRead(p: string, limit: number | null = null): string {
  try {
    let lines = fs.readFileSync(safePath(p), "utf-8").split("\n");
    if (limit && limit < lines.length) {
      lines = [...lines.slice(0, limit), `... (${lines.length - limit} more)`];
    }
    return lines.join("\n").slice(0, 50000);
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

function runWrite(p: string, content: string): string {
  try {
    const fp = safePath(p);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content);
    return `Wrote ${content.length} bytes to ${p}`;
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

function runEdit(p: string, oldText: string, newText: string): string {
  try {
    const fp = safePath(p);
    const c = fs.readFileSync(fp, "utf-8");
    if (!c.includes(oldText)) {
      return `Error: Text not found in ${p}`;
    }
    fs.writeFileSync(fp, c.replace(oldText, newText));
    return `Edited ${p}`;
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

// === SECTION: todos (s03) ===
class TodoManager {
  items: Record<string, any>[] = [];

  update(items: Record<string, any>[]): string {
    const validated: Record<string, any>[] = [];
    let ip = 0;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const content = String(item["content"] || "").trim();
      const status = String(item["status"] || "pending").toLowerCase();
      const af = String(item["activeForm"] || "").trim();
      if (!content) throw new Error(`Item ${i}: content required`);
      if (!["pending", "in_progress", "completed"].includes(status)) {
        throw new Error(`Item ${i}: invalid status '${status}'`);
      }
      if (!af) throw new Error(`Item ${i}: activeForm required`);
      if (status === "in_progress") ip += 1;
      validated.push({ content, status, activeForm: af });
    }
    if (validated.length > 20) throw new Error("Max 20 todos");
    if (ip > 1) throw new Error("Only one in_progress allowed");
    this.items = validated;
    return this.render();
  }

  render(): string {
    if (!this.items.length) return "No todos.";
    const lines: string[] = [];
    for (const item of this.items) {
      const m =
        ({ completed: "[x]", in_progress: "[>]", pending: "[ ]" } as Record<string, string>)[
          item["status"]
        ] || "[?]";
      const suffix = item["status"] === "in_progress" ? ` <- ${item["activeForm"]}` : "";
      lines.push(`${m} ${item["content"]}${suffix}`);
    }
    const done = this.items.filter((t) => t["status"] === "completed").length;
    lines.push(`\n(${done}/${this.items.length} completed)`);
    return lines.join("\n");
  }

  hasOpenItems(): boolean {
    return this.items.some((item) => item["status"] !== "completed");
  }
}

// === SECTION: subagent (s04) ===
async function runSubagent(prompt: string, agentType = "Explore"): Promise<string> {
  const subTools: any[] = [
    {
      name: "bash",
      description: "Run command.",
      input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
    {
      name: "read_file",
      description: "Read file.",
      input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  ];
  if (agentType !== "Explore") {
    subTools.push(
      {
        name: "write_file",
        description: "Write file.",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string" } },
          required: ["path", "content"],
        },
      },
      {
        name: "edit_file",
        description: "Edit file.",
        input_schema: {
          type: "object",
          properties: {
            path: { type: "string" },
            old_text: { type: "string" },
            new_text: { type: "string" },
          },
          required: ["path", "old_text", "new_text"],
        },
      }
    );
  }
  const subHandlers: Record<string, (kw: any) => string> = {
    bash: (kw) => runBash(kw.command),
    read_file: (kw) => runRead(kw.path),
    write_file: (kw) => runWrite(kw.path, kw.content),
    edit_file: (kw) => runEdit(kw.path, kw.old_text, kw.new_text),
  };
  const subMsgs: any[] = [{ role: "user", content: prompt }];
  let resp: any = null;
  for (let i = 0; i < 30; i++) {
    resp = await client.messages.create({
      model: MODEL,
      messages: subMsgs,
      tools: subTools,
      max_tokens: 8000,
    });
    subMsgs.push({ role: "assistant", content: resp.content });
    if (resp.stop_reason !== "tool_use") {
      break;
    }
    const results: any[] = [];
    for (const b of resp.content) {
      if (b.type === "tool_use") {
        const h = subHandlers[b.name] || (() => "Unknown tool");
        results.push({
          type: "tool_result",
          tool_use_id: b.id,
          content: String(h(b.input)).slice(0, 50000),
        });
      }
    }
    subMsgs.push({ role: "user", content: results });
  }
  if (resp) {
    return (
      resp.content
        .filter((b: any) => b.text !== undefined)
        .map((b: any) => b.text)
        .join("") || "(no summary)"
    );
  }
  return "(subagent failed)";
}

// === SECTION: skills (s05) ===
class SkillLoader {
  skills: Record<string, { meta: Record<string, string>; body: string }> = {};

  constructor(skillsDir: string) {
    if (fs.existsSync(skillsDir)) {
      for (const f of findSkillFiles(skillsDir).sort()) {
        const text = fs.readFileSync(f, "utf-8");
        const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)/);
        const meta: Record<string, string> = {};
        let body = text;
        if (match) {
          for (const line of match[1].trim().split("\n")) {
            if (line.includes(":")) {
              const idx = line.indexOf(":");
              const k = line.slice(0, idx);
              const v = line.slice(idx + 1);
              meta[k.trim()] = v.trim();
            }
          }
          body = match[2].trim();
        }
        const name = meta["name"] || path.basename(path.dirname(f));
        this.skills[name] = { meta, body };
      }
    }
  }

  descriptions(): string {
    if (!Object.keys(this.skills).length) return "(no skills)";
    return Object.entries(this.skills)
      .map(([n, s]) => `  - ${n}: ${s.meta["description"] || "-"}`)
      .join("\n");
  }

  load(name: string): string {
    const s = this.skills[name];
    if (!s) {
      return `Error: Unknown skill '${name}'. Available: ${Object.keys(this.skills).join(", ")}`;
    }
    return `<skill name="${name}">\n${s.body}\n</skill>`;
  }
}

// Helper: recursively find all SKILL.md files (equivalent to Path.rglob).
function findSkillFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findSkillFiles(full));
    } else if (entry.name === "SKILL.md") {
      results.push(full);
    }
  }
  return results;
}

// === SECTION: compression (s06) ===
function estimateTokens(messages: any[]): number {
  return Math.floor(JSON.stringify(messages).length / 4);
}

function microcompact(messages: any[]): void {
  const indices: Record<string, any>[] = [];
  for (const msg of messages) {
    if (msg["role"] === "user" && Array.isArray(msg["content"])) {
      for (const part of msg["content"]) {
        if (part && typeof part === "object" && part["type"] === "tool_result") {
          indices.push(part);
        }
      }
    }
  }
  if (indices.length <= 3) {
    return;
  }
  for (const part of indices.slice(0, -3)) {
    if (typeof part["content"] === "string" && part["content"].length > 100) {
      part["content"] = "[cleared]";
    }
  }
}

async function autoCompact(messages: any[]): Promise<any[]> {
  fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  const p = path.join(TRANSCRIPT_DIR, `transcript_${Math.floor(Date.now() / 1000)}.jsonl`);
  const fd = fs.openSync(p, "w");
  for (const msg of messages) {
    fs.writeSync(fd, JSON.stringify(msg) + "\n");
  }
  fs.closeSync(fd);
  const convText = JSON.stringify(messages).slice(-80000);
  const resp = await client.messages.create({
    model: MODEL,
    messages: [{ role: "user", content: `Summarize for continuity:\n${convText}` }],
    max_tokens: 2000,
  });
  const summary = (resp.content[0] as any).text;
  return [{ role: "user", content: `[Compressed. Transcript: ${p}]\n${summary}` }];
}

// === SECTION: file_tasks (s07) ===
class TaskManager {
  constructor() {
    fs.mkdirSync(TASKS_DIR, { recursive: true });
  }

  private _nextId(): number {
    const ids = fs
      .readdirSync(TASKS_DIR)
      .filter((f) => /^task_.*\.json$/.test(f))
      .map((f) => parseInt(f.replace(/\.json$/, "").split("_")[1], 10));
    return (ids.length ? Math.max(...ids) : 0) + 1;
  }

  private _load(tid: number): Record<string, any> {
    const p = path.join(TASKS_DIR, `task_${tid}.json`);
    if (!fs.existsSync(p)) throw new Error(`Task ${tid} not found`);
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  }

  private _save(task: Record<string, any>): void {
    fs.writeFileSync(path.join(TASKS_DIR, `task_${task["id"]}.json`), JSON.stringify(task, null, 2));
  }

  create(subject: string, description = ""): string {
    const task: Record<string, any> = {
      id: this._nextId(),
      subject,
      description,
      status: "pending",
      owner: null,
      blockedBy: [],
    };
    this._save(task);
    return JSON.stringify(task, null, 2);
  }

  get(tid: number): string {
    return JSON.stringify(this._load(tid), null, 2);
  }

  update(
    tid: number,
    status: string | null = null,
    addBlockedBy: number[] | null = null,
    removeBlockedBy: number[] | null = null
  ): string {
    const task = this._load(tid);
    if (status) {
      task["status"] = status;
      if (status === "completed") {
        for (const f of fs.readdirSync(TASKS_DIR).filter((f) => /^task_.*\.json$/.test(f))) {
          const t = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, f), "utf-8"));
          if ((t["blockedBy"] || []).includes(tid)) {
            t["blockedBy"] = t["blockedBy"].filter((x: number) => x !== tid);
            this._save(t);
          }
        }
      }
      if (status === "deleted") {
        const p = path.join(TASKS_DIR, `task_${tid}.json`);
        if (fs.existsSync(p)) fs.unlinkSync(p);
        return `Task ${tid} deleted`;
      }
    }
    if (addBlockedBy) {
      task["blockedBy"] = Array.from(new Set([...task["blockedBy"], ...addBlockedBy]));
    }
    if (removeBlockedBy) {
      task["blockedBy"] = task["blockedBy"].filter((x: number) => !removeBlockedBy.includes(x));
    }
    this._save(task);
    return JSON.stringify(task, null, 2);
  }

  listAll(): string {
    const tasks = fs
      .readdirSync(TASKS_DIR)
      .filter((f) => /^task_.*\.json$/.test(f))
      .sort()
      .map((f) => JSON.parse(fs.readFileSync(path.join(TASKS_DIR, f), "utf-8")));
    if (!tasks.length) return "No tasks.";
    const lines: string[] = [];
    for (const t of tasks) {
      const m =
        ({ pending: "[ ]", in_progress: "[>]", completed: "[x]" } as Record<string, string>)[
          t["status"]
        ] || "[?]";
      const owner = t["owner"] ? ` @${t["owner"]}` : "";
      const blocked =
        t["blockedBy"] && t["blockedBy"].length ? ` (blocked by: [${t["blockedBy"].join(", ")}])` : "";
      lines.push(`${m} #${t["id"]}: ${t["subject"]}${owner}${blocked}`);
    }
    return lines.join("\n");
  }

  claim(tid: number, owner: string): string {
    const task = this._load(tid);
    task["owner"] = owner;
    task["status"] = "in_progress";
    this._save(task);
    return `Claimed task #${tid} for ${owner}`;
  }
}

// === SECTION: background (s08) ===
interface BgTaskFull {
  status: string;
  command: string;
  result: string | null;
}

class BackgroundManager {
  tasks: Record<string, BgTaskFull> = {};
  notifications: Record<string, any>[] = [];

  run(command: string, timeout = 120): string {
    const tid = randomUUID().slice(0, 8);
    this.tasks[tid] = { status: "running", command, result: null };
    // Fire and forget: schedule the execution (Node has no true threads).
    setImmediate(() => this._exec(tid, command, timeout));
    return `Background task ${tid} started: ${command.slice(0, 80)}`;
  }

  private _exec(tid: string, command: string, timeout: number): void {
    try {
      const raw = execSync(command, {
        shell: "/bin/sh",
        cwd: WORKDIR,
        encoding: "utf-8",
        timeout: timeout * 1000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const output = raw.trim().slice(0, 50000);
      Object.assign(this.tasks[tid], { status: "completed", result: output || "(no output)" });
    } catch (e: any) {
      const combined = ((e.stdout || "") + (e.stderr || "")).trim();
      if (combined) {
        Object.assign(this.tasks[tid], { status: "completed", result: combined.slice(0, 50000) });
      } else {
        Object.assign(this.tasks[tid], { status: "error", result: String(e.message) });
      }
    }
    this.notifications.push({
      task_id: tid,
      status: this.tasks[tid].status,
      result: (this.tasks[tid].result as string).slice(0, 500),
    });
  }

  check(tid: string | null = null): string {
    if (tid) {
      const t = this.tasks[tid];
      return t ? `[${t.status}] ${t.result || "(running)"}` : `Unknown: ${tid}`;
    }
    const lines = Object.entries(this.tasks).map(
      ([k, v]) => `${k}: [${v.status}] ${v.command.slice(0, 60)}`
    );
    return lines.length ? lines.join("\n") : "No bg tasks.";
  }

  drain(): Record<string, any>[] {
    const notifs: Record<string, any>[] = [];
    while (this.notifications.length) {
      notifs.push(this.notifications.shift() as Record<string, any>);
    }
    return notifs;
  }
}

// === SECTION: messaging (s09) ===
class MessageBus {
  constructor() {
    fs.mkdirSync(INBOX_DIR, { recursive: true });
  }

  send(
    sender: string,
    to: string,
    content: string,
    msgType = "message",
    extra: Record<string, any> | null = null
  ): string {
    const msg: Record<string, any> = {
      type: msgType,
      from: sender,
      content,
      timestamp: Date.now() / 1000,
    };
    if (extra) Object.assign(msg, extra);
    fs.appendFileSync(path.join(INBOX_DIR, `${to}.jsonl`), JSON.stringify(msg) + "\n");
    return `Sent ${msgType} to ${to}`;
  }

  readInbox(name: string): Record<string, any>[] {
    const p = path.join(INBOX_DIR, `${name}.jsonl`);
    if (!fs.existsSync(p)) return [];
    const msgs = fs
      .readFileSync(p, "utf-8")
      .trim()
      .split("\n")
      .filter((l) => l)
      .map((l) => JSON.parse(l));
    fs.writeFileSync(p, "");
    return msgs;
  }

  broadcast(sender: string, content: string, names: string[]): string {
    let count = 0;
    for (const n of names) {
      if (n !== sender) {
        this.send(sender, n, content, "broadcast");
        count += 1;
      }
    }
    return `Broadcast to ${count} teammates`;
  }
}

// === SECTION: shutdown + plan tracking (s10) ===
const shutdownRequests: Record<string, any> = {};
const planRequests: Record<string, any> = {};

// === SECTION: team (s09/s11) ===
class TeammateManager {
  bus: MessageBus;
  taskMgr: TaskManager;
  configPath: string;
  config: Record<string, any>;
  threads: Record<string, any> = {};

  constructor(bus: MessageBus, taskMgr: TaskManager) {
    fs.mkdirSync(TEAM_DIR, { recursive: true });
    this.bus = bus;
    this.taskMgr = taskMgr;
    this.configPath = path.join(TEAM_DIR, "config.json");
    this.config = this._load();
  }

  private _load(): Record<string, any> {
    if (fs.existsSync(this.configPath)) {
      return JSON.parse(fs.readFileSync(this.configPath, "utf-8"));
    }
    return { team_name: "default", members: [] };
  }

  private _save(): void {
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
  }

  private _find(name: string): Record<string, any> | null {
    for (const m of this.config["members"]) {
      if (m["name"] === name) return m;
    }
    return null;
  }

  spawn(name: string, role: string, prompt: string): string {
    let member = this._find(name);
    if (member) {
      if (!["idle", "shutdown"].includes(member["status"])) {
        return `Error: '${name}' is currently ${member["status"]}`;
      }
      member["status"] = "working";
      member["role"] = role;
    } else {
      member = { name, role, status: "working" };
      this.config["members"].push(member);
    }
    this._save();
    this.threads[name] = this._loop(name, role, prompt);
    return `Spawned '${name}' (role: ${role})`;
  }

  private _setStatus(name: string, status: string): void {
    const member = this._find(name);
    if (member) {
      member["status"] = status;
      this._save();
    }
  }

  private async _loop(name: string, role: string, prompt: string): Promise<void> {
    const teamName = this.config["team_name"];
    const sysPrompt =
      `You are '${name}', role: ${role}, team: ${teamName}, at ${WORKDIR}. ` +
      `Use idle when done with current work. You may auto-claim tasks.`;
    const messages: any[] = [{ role: "user", content: prompt }];
    const tools: any[] = [
      {
        name: "bash",
        description: "Run command.",
        input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      },
      {
        name: "read_file",
        description: "Read file.",
        input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
      {
        name: "write_file",
        description: "Write file.",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string" } },
          required: ["path", "content"],
        },
      },
      {
        name: "edit_file",
        description: "Edit file.",
        input_schema: {
          type: "object",
          properties: {
            path: { type: "string" },
            old_text: { type: "string" },
            new_text: { type: "string" },
          },
          required: ["path", "old_text", "new_text"],
        },
      },
      {
        name: "send_message",
        description: "Send message.",
        input_schema: {
          type: "object",
          properties: { to: { type: "string" }, content: { type: "string" } },
          required: ["to", "content"],
        },
      },
      {
        name: "idle",
        description: "Signal no more work.",
        input_schema: { type: "object", properties: {} },
      },
      {
        name: "claim_task",
        description: "Claim task by ID.",
        input_schema: {
          type: "object",
          properties: { task_id: { type: "integer" } },
          required: ["task_id"],
        },
      },
    ];
    while (true) {
      // -- WORK PHASE --
      for (let i = 0; i < 50; i++) {
        const inbox = this.bus.readInbox(name);
        for (const msg of inbox) {
          if (msg["type"] === "shutdown_request") {
            this._setStatus(name, "shutdown");
            return;
          }
          messages.push({ role: "user", content: JSON.stringify(msg) });
        }
        let response: any;
        try {
          response = await client.messages.create({
            model: MODEL,
            system: sysPrompt,
            messages,
            tools,
            max_tokens: 8000,
          });
        } catch {
          this._setStatus(name, "shutdown");
          return;
        }
        messages.push({ role: "assistant", content: response.content });
        if (response.stop_reason !== "tool_use") {
          break;
        }
        const results: any[] = [];
        let idleRequested = false;
        for (const block of response.content) {
          if (block.type === "tool_use") {
            let output: string;
            if (block.name === "idle") {
              idleRequested = true;
              output = "Entering idle phase.";
            } else if (block.name === "claim_task") {
              output = this.taskMgr.claim(block.input["task_id"], name);
            } else if (block.name === "send_message") {
              output = this.bus.send(name, block.input["to"], block.input["content"]);
            } else {
              const dispatch: Record<string, (kw: any) => string> = {
                bash: (kw) => runBash(kw.command),
                read_file: (kw) => runRead(kw.path),
                write_file: (kw) => runWrite(kw.path, kw.content),
                edit_file: (kw) => runEdit(kw.path, kw.old_text, kw.new_text),
              };
              output = (dispatch[block.name] || (() => "Unknown"))(block.input);
            }
            console.log(`  [${name}] ${block.name}: ${String(output).slice(0, 120)}`);
            results.push({ type: "tool_result", tool_use_id: block.id, content: String(output) });
          }
        }
        messages.push({ role: "user", content: results });
        if (idleRequested) {
          break;
        }
      }
      // -- IDLE PHASE: poll for messages and unclaimed tasks --
      this._setStatus(name, "idle");
      let resume = false;
      const polls = Math.floor(IDLE_TIMEOUT / Math.max(POLL_INTERVAL, 1));
      for (let i = 0; i < polls; i++) {
        await sleep(POLL_INTERVAL * 1000);
        const inbox = this.bus.readInbox(name);
        if (inbox.length) {
          for (const msg of inbox) {
            if (msg["type"] === "shutdown_request") {
              this._setStatus(name, "shutdown");
              return;
            }
            messages.push({ role: "user", content: JSON.stringify(msg) });
          }
          resume = true;
          break;
        }
        const unclaimed: Record<string, any>[] = [];
        for (const f of fs.readdirSync(TASKS_DIR).filter((f) => /^task_.*\.json$/.test(f)).sort()) {
          const t = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, f), "utf-8"));
          if (
            t["status"] === "pending" &&
            !t["owner"] &&
            !(t["blockedBy"] && t["blockedBy"].length)
          ) {
            unclaimed.push(t);
          }
        }
        if (unclaimed.length) {
          const task = unclaimed[0];
          this.taskMgr.claim(task["id"], name);
          // Identity re-injection for compressed contexts
          if (messages.length <= 3) {
            messages.splice(0, 0, {
              role: "user",
              content: `<identity>You are '${name}', role: ${role}, team: ${teamName}.</identity>`,
            });
            messages.splice(1, 0, { role: "assistant", content: `I am ${name}. Continuing.` });
          }
          messages.push({
            role: "user",
            content: `<auto-claimed>Task #${task["id"]}: ${task["subject"]}\n${
              task["description"] || ""
            }</auto-claimed>`,
          });
          messages.push({
            role: "assistant",
            content: `Claimed task #${task["id"]}. Working on it.`,
          });
          resume = true;
          break;
        }
      }
      if (!resume) {
        this._setStatus(name, "shutdown");
        return;
      }
      this._setStatus(name, "working");
    }
  }

  listAll(): string {
    if (!this.config["members"].length) return "No teammates.";
    const lines = [`Team: ${this.config["team_name"]}`];
    for (const m of this.config["members"]) {
      lines.push(`  ${m["name"]} (${m["role"]}): ${m["status"]}`);
    }
    return lines.join("\n");
  }

  memberNames(): string[] {
    return this.config["members"].map((m: Record<string, any>) => m["name"]);
  }
}

// === SECTION: global_instances ===
const TODO = new TodoManager();
const SKILLS = new SkillLoader(SKILLS_DIR);
const TASK_MGR = new TaskManager();
const BG = new BackgroundManager();
const BUS = new MessageBus();
const TEAM = new TeammateManager(BUS, TASK_MGR);

// === SECTION: system_prompt ===
const SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks.
Prefer task_create/task_update/task_list for multi-step work. Use TodoWrite for short checklists.
Use task for subagent delegation. Use load_skill for specialized knowledge.
Skills: ${SKILLS.descriptions()}`;

// === SECTION: shutdown_protocol (s10) ===
function handleShutdownRequest(teammate: string): string {
  const reqId = randomUUID().slice(0, 8);
  shutdownRequests[reqId] = { target: teammate, status: "pending" };
  BUS.send("lead", teammate, "Please shut down.", "shutdown_request", { request_id: reqId });
  return `Shutdown request ${reqId} sent to '${teammate}'`;
}

// === SECTION: plan_approval (s10) ===
function handlePlanReview(requestId: string, approve: boolean, feedback = ""): string {
  const req = planRequests[requestId];
  if (!req) return `Error: Unknown plan request_id '${requestId}'`;
  req["status"] = approve ? "approved" : "rejected";
  BUS.send("lead", req["from"], feedback, "plan_approval_response", {
    request_id: requestId,
    approve,
    feedback,
  });
  return `Plan ${req["status"]} for '${req["from"]}'`;
}

// === SECTION: tool_dispatch (s02) ===
// Note: some handlers are async (task subagent); dispatch awaits them in the loop.
const TOOL_HANDLERS: Record<string, (kw: any) => string | Promise<string>> = {
  bash: (kw) => runBash(kw.command),
  read_file: (kw) => runRead(kw.path, kw.limit),
  write_file: (kw) => runWrite(kw.path, kw.content),
  edit_file: (kw) => runEdit(kw.path, kw.old_text, kw.new_text),
  TodoWrite: (kw) => TODO.update(kw.items),
  task: (kw) => runSubagent(kw.prompt, kw.agent_type || "Explore"),
  load_skill: (kw) => SKILLS.load(kw.name),
  compress: () => "Compressing...",
  background_run: (kw) => BG.run(kw.command, kw.timeout || 120),
  check_background: (kw) => BG.check(kw.task_id),
  task_create: (kw) => TASK_MGR.create(kw.subject, kw.description || ""),
  task_get: (kw) => TASK_MGR.get(kw.task_id),
  task_update: (kw) => TASK_MGR.update(kw.task_id, kw.status, kw.add_blocked_by, kw.remove_blocked_by),
  task_list: () => TASK_MGR.listAll(),
  spawn_teammate: (kw) => TEAM.spawn(kw.name, kw.role, kw.prompt),
  list_teammates: () => TEAM.listAll(),
  send_message: (kw) => BUS.send("lead", kw.to, kw.content, kw.msg_type || "message"),
  read_inbox: () => JSON.stringify(BUS.readInbox("lead"), null, 2),
  broadcast: (kw) => BUS.broadcast("lead", kw.content, TEAM.memberNames()),
  shutdown_request: (kw) => handleShutdownRequest(kw.teammate),
  plan_approval: (kw) => handlePlanReview(kw.request_id, kw.approve, kw.feedback || ""),
  idle: () => "Lead does not idle.",
  claim_task: (kw) => TASK_MGR.claim(kw.task_id, "lead"),
};

const TOOLS: any[] = [
  {
    name: "bash",
    description: "Run a shell command.",
    input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  },
  {
    name: "read_file",
    description: "Read file contents.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, limit: { type: "integer" } },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to file.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description: "Replace exact text in file.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_text: { type: "string" },
        new_text: { type: "string" },
      },
      required: ["path", "old_text", "new_text"],
    },
  },
  {
    name: "TodoWrite",
    description: "Update task tracking list.",
    input_schema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              content: { type: "string" },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
              activeForm: { type: "string" },
            },
            required: ["content", "status", "activeForm"],
          },
        },
      },
      required: ["items"],
    },
  },
  {
    name: "task",
    description: "Spawn a subagent for isolated exploration or work.",
    input_schema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        agent_type: { type: "string", enum: ["Explore", "general-purpose"] },
      },
      required: ["prompt"],
    },
  },
  {
    name: "load_skill",
    description: "Load specialized knowledge by name.",
    input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
  {
    name: "compress",
    description: "Manually compress conversation context.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "background_run",
    description: "Run command in background thread.",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" }, timeout: { type: "integer" } },
      required: ["command"],
    },
  },
  {
    name: "check_background",
    description: "Check background task status.",
    input_schema: { type: "object", properties: { task_id: { type: "string" } } },
  },
  {
    name: "task_create",
    description: "Create a persistent file task.",
    input_schema: {
      type: "object",
      properties: { subject: { type: "string" }, description: { type: "string" } },
      required: ["subject"],
    },
  },
  {
    name: "task_get",
    description: "Get task details by ID.",
    input_schema: { type: "object", properties: { task_id: { type: "integer" } }, required: ["task_id"] },
  },
  {
    name: "task_update",
    description: "Update task status or dependencies.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "integer" },
        status: { type: "string", enum: ["pending", "in_progress", "completed", "deleted"] },
        add_blocked_by: { type: "array", items: { type: "integer" } },
        remove_blocked_by: { type: "array", items: { type: "integer" } },
      },
      required: ["task_id"],
    },
  },
  {
    name: "task_list",
    description: "List all tasks.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "spawn_teammate",
    description: "Spawn a persistent autonomous teammate.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" }, role: { type: "string" }, prompt: { type: "string" } },
      required: ["name", "role", "prompt"],
    },
  },
  {
    name: "list_teammates",
    description: "List all teammates.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "send_message",
    description: "Send a message to a teammate.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string" },
        content: { type: "string" },
        msg_type: { type: "string", enum: [...VALID_MSG_TYPES] },
      },
      required: ["to", "content"],
    },
  },
  {
    name: "read_inbox",
    description: "Read and drain the lead's inbox.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "broadcast",
    description: "Send message to all teammates.",
    input_schema: { type: "object", properties: { content: { type: "string" } }, required: ["content"] },
  },
  {
    name: "shutdown_request",
    description: "Request a teammate to shut down.",
    input_schema: { type: "object", properties: { teammate: { type: "string" } }, required: ["teammate"] },
  },
  {
    name: "plan_approval",
    description: "Approve or reject a teammate's plan.",
    input_schema: {
      type: "object",
      properties: {
        request_id: { type: "string" },
        approve: { type: "boolean" },
        feedback: { type: "string" },
      },
      required: ["request_id", "approve"],
    },
  },
  {
    name: "idle",
    description: "Enter idle state.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "claim_task",
    description: "Claim a task from the board.",
    input_schema: { type: "object", properties: { task_id: { type: "integer" } }, required: ["task_id"] },
  },
];

// === SECTION: agent_loop ===
async function agentLoop(messages: any[]): Promise<void> {
  let roundsWithoutTodo = 0;
  while (true) {
    // s06: compression pipeline
    microcompact(messages);
    if (estimateTokens(messages) > TOKEN_THRESHOLD) {
      console.log("[auto-compact triggered]");
      const compacted = await autoCompact(messages);
      messages.splice(0, messages.length, ...compacted);
    }
    // s08: drain background notifications
    const notifs = BG.drain();
    if (notifs.length) {
      const txt = notifs.map((n) => `[bg:${n["task_id"]}] ${n["status"]}: ${n["result"]}`).join("\n");
      messages.push({ role: "user", content: `<background-results>\n${txt}\n</background-results>` });
    }
    // s10: check lead inbox
    const inbox = BUS.readInbox("lead");
    if (inbox.length) {
      messages.push({ role: "user", content: `<inbox>${JSON.stringify(inbox, null, 2)}</inbox>` });
    }
    // LLM call
    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages,
      tools: TOOLS,
      max_tokens: 8000,
    });
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") {
      return;
    }
    // Tool execution
    const results: any[] = [];
    let usedTodo = false;
    let manualCompress = false;
    for (const block of response.content as any[]) {
      if (block.type === "tool_use") {
        if (block.name === "compress") {
          manualCompress = true;
        }
        const handler = TOOL_HANDLERS[block.name];
        let output: string;
        try {
          output = handler ? await handler(block.input) : `Unknown tool: ${block.name}`;
        } catch (e: any) {
          output = `Error: ${e.message}`;
        }
        console.log(`> ${block.name}:`);
        console.log(String(output).slice(0, 200));
        results.push({ type: "tool_result", tool_use_id: block.id, content: String(output) });
        if (block.name === "TodoWrite") {
          usedTodo = true;
        }
      }
    }
    // s03: nag reminder (only when todo workflow is active)
    roundsWithoutTodo = usedTodo ? 0 : roundsWithoutTodo + 1;
    if (TODO.hasOpenItems() && roundsWithoutTodo >= 3) {
      results.push({ type: "text", text: "<reminder>Update your todos.</reminder>" });
    }
    messages.push({ role: "user", content: results });
    // s06: manual compress
    if (manualCompress) {
      console.log("[manual compact]");
      const compacted = await autoCompact(messages);
      messages.splice(0, messages.length, ...compacted);
      return;
    }
  }
}

// === SECTION: repl ===
async function main(): Promise<void> {
  const readline = await import("readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const history: any[] = [];
  while (true) {
    let query: string;
    try {
      query = await rl.question("\x1b[36ms_full >> \x1b[0m");
    } catch {
      break;
    }
    if (["q", "exit", ""].includes(query.trim().toLowerCase())) {
      break;
    }
    if (query.trim() === "/compact") {
      if (history.length) {
        console.log("[manual compact via /compact]");
        const compacted = await autoCompact(history);
        history.splice(0, history.length, ...compacted);
      }
      continue;
    }
    if (query.trim() === "/tasks") {
      console.log(TASK_MGR.listAll());
      continue;
    }
    if (query.trim() === "/team") {
      console.log(TEAM.listAll());
      continue;
    }
    if (query.trim() === "/inbox") {
      console.log(JSON.stringify(BUS.readInbox("lead"), null, 2));
      continue;
    }
    history.push({ role: "user", content: query });
    await agentLoop(history);
    const responseContent = history[history.length - 1]["content"];
    if (Array.isArray(responseContent)) {
      for (const block of responseContent) {
        if (block.text !== undefined) {
          console.log(block.text);
        }
      }
    }
    console.log();
  }
  rl.close();
}

if (require.main === module) {
  main();
}
