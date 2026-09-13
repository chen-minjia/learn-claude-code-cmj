#!/usr/bin/env node
// Harness: directory isolation -- parallel execution lanes that never collide.
/**
 * s12_worktree_task_isolation.ts - Worktree + Task Isolation
 *
 * Directory-level isolation for parallel task execution.
 * Tasks are the control plane and worktrees are the execution plane.
 *
 *     .tasks/task_12.json
 *       {
 *         "id": 12,
 *         "subject": "Implement auth refactor",
 *         "status": "in_progress",
 *         "worktree": "auth-refactor"
 *       }
 *
 *     .worktrees/index.json
 *       {
 *         "worktrees": [
 *           {
 *             "name": "auth-refactor",
 *             "path": ".../.worktrees/auth-refactor",
 *             "branch": "wt/auth-refactor",
 *             "task_id": 12,
 *             "status": "active"
 *           }
 *         ]
 *       }
 *
 * Key insight: "Isolate by directory, coordinate by task ID."
 */

import * as fs from "fs";
import * as path from "path";
import { execSync, spawnSync } from "child_process";
import Anthropic from "@anthropic-ai/sdk";
import * as dotenv from "dotenv";

dotenv.config({ override: true });

if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

const WORKDIR: string = process.cwd();
const client = new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL });
const MODEL: string = process.env.MODEL_ID as string;

function detectRepoRoot(cwd: string): string | null {
  // Return git repo root if cwd is inside a repo, else null.
  try {
    const r = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf-8",
      timeout: 10000,
    });
    if (r.status !== 0) {
      return null;
    }
    const root = r.stdout.trim();
    return fs.existsSync(root) ? root : null;
  } catch {
    return null;
  }
}

const REPO_ROOT: string = detectRepoRoot(WORKDIR) || WORKDIR;

const SYSTEM =
  `You are a coding agent at ${WORKDIR}. ` +
  "Use task + worktree tools for multi-task work. " +
  "For parallel or risky changes: create tasks, allocate worktree lanes, " +
  "run commands in those lanes, then choose keep/remove for closeout. " +
  "Use worktree_events when you need lifecycle visibility.";

// -- EventBus: append-only lifecycle events for observability --
class EventBus {
  path: string;

  constructor(eventLogPath: string) {
    this.path = eventLogPath;
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    if (!fs.existsSync(this.path)) {
      fs.writeFileSync(this.path, "");
    }
  }

  emit(
    event: string,
    task: Record<string, any> | null = null,
    worktree: Record<string, any> | null = null,
    error: string | null = null
  ): void {
    const payload: Record<string, any> = {
      event,
      ts: Date.now() / 1000,
      task: task || {},
      worktree: worktree || {},
    };
    if (error) {
      payload["error"] = error;
    }
    fs.appendFileSync(this.path, JSON.stringify(payload) + "\n", { encoding: "utf-8" });
  }

  listRecent(limit = 20): string {
    const n = Math.max(1, Math.min(parseInt(String(limit || 20), 10), 200));
    // Match Python's splitlines(): drop trailing empty segment.
    const allLines = fs.readFileSync(this.path, "utf-8").split("\n");
    if (allLines.length && allLines[allLines.length - 1] === "") {
      allLines.pop();
    }
    const recent = allLines.slice(-n);
    const items: Record<string, any>[] = [];
    for (const line of recent) {
      try {
        items.push(JSON.parse(line));
      } catch {
        items.push({ event: "parse_error", raw: line });
      }
    }
    return JSON.stringify(items, null, 2);
  }
}

// -- TaskManager: persistent task board with optional worktree binding --
class TaskManager {
  dir: string;
  private _next_id: number;

  constructor(tasksDir: string) {
    this.dir = tasksDir;
    fs.mkdirSync(this.dir, { recursive: true });
    this._next_id = this._maxId() + 1;
  }

  private _maxId(): number {
    const ids: number[] = [];
    for (const f of fs.readdirSync(this.dir).filter((f) => /^task_.*\.json$/.test(f))) {
      try {
        ids.push(parseInt(f.replace(/\.json$/, "").split("_")[1], 10));
      } catch {
        // ignore
      }
    }
    return ids.length ? Math.max(...ids) : 0;
  }

  private _path(taskId: number): string {
    return path.join(this.dir, `task_${taskId}.json`);
  }

  private _load(taskId: number): Record<string, any> {
    const p = this._path(taskId);
    if (!fs.existsSync(p)) {
      throw new Error(`Task ${taskId} not found`);
    }
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  }

  private _save(task: Record<string, any>): void {
    fs.writeFileSync(this._path(task["id"]), JSON.stringify(task, null, 2));
  }

  create(subject: string, description = ""): string {
    const task: Record<string, any> = {
      id: this._next_id,
      subject,
      description,
      status: "pending",
      owner: "",
      worktree: "",
      blockedBy: [],
      created_at: Date.now() / 1000,
      updated_at: Date.now() / 1000,
    };
    this._save(task);
    this._next_id += 1;
    return JSON.stringify(task, null, 2);
  }

  get(taskId: number): string {
    return JSON.stringify(this._load(taskId), null, 2);
  }

  exists(taskId: number): boolean {
    return fs.existsSync(this._path(taskId));
  }

  update(taskId: number, status: string | null = null, owner: string | null = null): string {
    const task = this._load(taskId);
    if (status) {
      if (!["pending", "in_progress", "completed"].includes(status)) {
        throw new Error(`Invalid status: ${status}`);
      }
      task["status"] = status;
    }
    if (owner !== null) {
      task["owner"] = owner;
    }
    task["updated_at"] = Date.now() / 1000;
    this._save(task);
    return JSON.stringify(task, null, 2);
  }

  bindWorktree(taskId: number, worktree: string, owner = ""): string {
    const task = this._load(taskId);
    task["worktree"] = worktree;
    if (owner) {
      task["owner"] = owner;
    }
    if (task["status"] === "pending") {
      task["status"] = "in_progress";
    }
    task["updated_at"] = Date.now() / 1000;
    this._save(task);
    return JSON.stringify(task, null, 2);
  }

  unbindWorktree(taskId: number): string {
    const task = this._load(taskId);
    task["worktree"] = "";
    task["updated_at"] = Date.now() / 1000;
    this._save(task);
    return JSON.stringify(task, null, 2);
  }

  listAll(): string {
    const tasks: Record<string, any>[] = [];
    for (const f of fs.readdirSync(this.dir).filter((f) => /^task_.*\.json$/.test(f)).sort()) {
      tasks.push(JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf-8")));
    }
    if (!tasks.length) {
      return "No tasks.";
    }
    const lines: string[] = [];
    for (const t of tasks) {
      const marker =
        ({ pending: "[ ]", in_progress: "[>]", completed: "[x]" } as Record<string, string>)[
          t["status"]
        ] || "[?]";
      const owner = t["owner"] ? ` owner=${t["owner"]}` : "";
      const wt = t["worktree"] ? ` wt=${t["worktree"]}` : "";
      lines.push(`${marker} #${t["id"]}: ${t["subject"]}${owner}${wt}`);
    }
    return lines.join("\n");
  }
}

const TASKS = new TaskManager(path.join(REPO_ROOT, ".tasks"));
const EVENTS = new EventBus(path.join(REPO_ROOT, ".worktrees", "events.jsonl"));

// -- WorktreeManager: create/list/run/remove git worktrees + lifecycle index --
class WorktreeManager {
  repoRoot: string;
  tasks: TaskManager;
  events: EventBus;
  dir: string;
  indexPath: string;
  gitAvailable: boolean;

  constructor(repoRoot: string, tasks: TaskManager, events: EventBus) {
    this.repoRoot = repoRoot;
    this.tasks = tasks;
    this.events = events;
    this.dir = path.join(repoRoot, ".worktrees");
    fs.mkdirSync(this.dir, { recursive: true });
    this.indexPath = path.join(this.dir, "index.json");
    if (!fs.existsSync(this.indexPath)) {
      fs.writeFileSync(this.indexPath, JSON.stringify({ worktrees: [] }, null, 2));
    }
    this.gitAvailable = this._isGitRepo();
  }

  private _isGitRepo(): boolean {
    try {
      const r = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd: this.repoRoot,
        encoding: "utf-8",
        timeout: 10000,
      });
      return r.status === 0;
    } catch {
      return false;
    }
  }

  private _runGit(args: string[]): string {
    if (!this.gitAvailable) {
      throw new Error("Not in a git repository. worktree tools require git.");
    }
    const r = spawnSync("git", args, {
      cwd: this.repoRoot,
      encoding: "utf-8",
      timeout: 120000,
    });
    if (r.status !== 0) {
      const msg = ((r.stdout || "") + (r.stderr || "")).trim();
      throw new Error(msg || `git ${args.join(" ")} failed`);
    }
    return ((r.stdout || "") + (r.stderr || "")).trim() || "(no output)";
  }

  private _loadIndex(): Record<string, any> {
    return JSON.parse(fs.readFileSync(this.indexPath, "utf-8"));
  }

  private _saveIndex(data: Record<string, any>): void {
    fs.writeFileSync(this.indexPath, JSON.stringify(data, null, 2));
  }

  private _find(name: string): Record<string, any> | null {
    const idx = this._loadIndex();
    for (const wt of idx["worktrees"] || []) {
      if (wt["name"] === name) {
        return wt;
      }
    }
    return null;
  }

  private _validateName(name: string): void {
    if (!/^[A-Za-z0-9._-]{1,40}$/.test(name || "")) {
      throw new Error("Invalid worktree name. Use 1-40 chars: letters, numbers, ., _, -");
    }
  }

  create(name: string, taskId: number | null = null, baseRef = "HEAD"): string {
    this._validateName(name);
    if (this._find(name)) {
      throw new Error(`Worktree '${name}' already exists in index`);
    }
    if (taskId !== null && taskId !== undefined && !this.tasks.exists(taskId)) {
      throw new Error(`Task ${taskId} not found`);
    }

    const wtPath = path.join(this.dir, name);
    const branch = `wt/${name}`;
    this.events.emit(
      "worktree.create.before",
      taskId !== null && taskId !== undefined ? { id: taskId } : {},
      { name, base_ref: baseRef }
    );
    try {
      this._runGit(["worktree", "add", "-b", branch, wtPath, baseRef]);

      const entry: Record<string, any> = {
        name,
        path: wtPath,
        branch,
        task_id: taskId,
        status: "active",
        created_at: Date.now() / 1000,
      };

      const idx = this._loadIndex();
      idx["worktrees"].push(entry);
      this._saveIndex(idx);

      if (taskId !== null && taskId !== undefined) {
        this.tasks.bindWorktree(taskId, name);
      }

      this.events.emit(
        "worktree.create.after",
        taskId !== null && taskId !== undefined ? { id: taskId } : {},
        { name, path: wtPath, branch, status: "active" }
      );
      return JSON.stringify(entry, null, 2);
    } catch (e: any) {
      this.events.emit(
        "worktree.create.failed",
        taskId !== null && taskId !== undefined ? { id: taskId } : {},
        { name, base_ref: baseRef },
        String(e.message)
      );
      throw e;
    }
  }

  listAll(): string {
    const idx = this._loadIndex();
    const wts = idx["worktrees"] || [];
    if (!wts.length) {
      return "No worktrees in index.";
    }
    const lines: string[] = [];
    for (const wt of wts) {
      const suffix = wt["task_id"] ? ` task=${wt["task_id"]}` : "";
      lines.push(
        `[${wt["status"] || "unknown"}] ${wt["name"]} -> ` +
          `${wt["path"]} (${wt["branch"] || "-"})${suffix}`
      );
    }
    return lines.join("\n");
  }

  status(name: string): string {
    const wt = this._find(name);
    if (!wt) {
      return `Error: Unknown worktree '${name}'`;
    }
    const wtPath = wt["path"];
    if (!fs.existsSync(wtPath)) {
      return `Error: Worktree path missing: ${wtPath}`;
    }
    const r = spawnSync("git", ["status", "--short", "--branch"], {
      cwd: wtPath,
      encoding: "utf-8",
      timeout: 60000,
    });
    const text = ((r.stdout || "") + (r.stderr || "")).trim();
    return text || "Clean worktree";
  }

  run(name: string, command: string): string {
    const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
    if (dangerous.some((d) => command.includes(d))) {
      return "Error: Dangerous command blocked";
    }

    const wt = this._find(name);
    if (!wt) {
      return `Error: Unknown worktree '${name}'`;
    }
    const wtPath = wt["path"];
    if (!fs.existsSync(wtPath)) {
      return `Error: Worktree path missing: ${wtPath}`;
    }

    try {
      const out = execSync(command, {
        shell: "/bin/sh",
        cwd: wtPath,
        encoding: "utf-8",
        timeout: 300000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const trimmed = out.trim();
      return trimmed ? trimmed.slice(0, 50000) : "(no output)";
    } catch (e: any) {
      if (e.killed) {
        return "Error: Timeout (300s)";
      }
      const out = ((e.stdout || "") + (e.stderr || "")).trim();
      return out ? out.slice(0, 50000) : "(no output)";
    }
  }

  remove(name: string, force = false, completeTask = false): string {
    const wt = this._find(name);
    if (!wt) {
      return `Error: Unknown worktree '${name}'`;
    }

    this.events.emit(
      "worktree.remove.before",
      wt["task_id"] !== null && wt["task_id"] !== undefined ? { id: wt["task_id"] } : {},
      { name, path: wt["path"] }
    );
    try {
      const args = ["worktree", "remove"];
      if (force) {
        args.push("--force");
      }
      args.push(wt["path"]);
      this._runGit(args);

      if (completeTask && wt["task_id"] !== null && wt["task_id"] !== undefined) {
        const taskId = wt["task_id"];
        const before = JSON.parse(this.tasks.get(taskId));
        this.tasks.update(taskId, "completed");
        this.tasks.unbindWorktree(taskId);
        this.events.emit(
          "task.completed",
          { id: taskId, subject: before["subject"] || "", status: "completed" },
          { name }
        );
      }

      const idx = this._loadIndex();
      for (const item of idx["worktrees"] || []) {
        if (item["name"] === name) {
          item["status"] = "removed";
          item["removed_at"] = Date.now() / 1000;
        }
      }
      this._saveIndex(idx);

      this.events.emit(
        "worktree.remove.after",
        wt["task_id"] !== null && wt["task_id"] !== undefined ? { id: wt["task_id"] } : {},
        { name, path: wt["path"], status: "removed" }
      );
      return `Removed worktree '${name}'`;
    } catch (e: any) {
      this.events.emit(
        "worktree.remove.failed",
        wt["task_id"] !== null && wt["task_id"] !== undefined ? { id: wt["task_id"] } : {},
        { name, path: wt["path"] },
        String(e.message)
      );
      throw e;
    }
  }

  keep(name: string): string {
    const wt = this._find(name);
    if (!wt) {
      return `Error: Unknown worktree '${name}'`;
    }

    const idx = this._loadIndex();
    let kept: Record<string, any> | null = null;
    for (const item of idx["worktrees"] || []) {
      if (item["name"] === name) {
        item["status"] = "kept";
        item["kept_at"] = Date.now() / 1000;
        kept = item;
      }
    }
    this._saveIndex(idx);

    this.events.emit(
      "worktree.keep",
      wt["task_id"] !== null && wt["task_id"] !== undefined ? { id: wt["task_id"] } : {},
      { name, path: wt["path"], status: "kept" }
    );
    return kept ? JSON.stringify(kept, null, 2) : `Error: Unknown worktree '${name}'`;
  }
}

const WORKTREES = new WorktreeManager(REPO_ROOT, TASKS, EVENTS);

// -- Base tools (kept minimal, same style as previous sessions) --
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
    return `Wrote ${content.length} bytes`;
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

const TOOL_HANDLERS: Record<string, (kw: any) => string> = {
  bash: (kw) => runBash(kw.command),
  read_file: (kw) => runRead(kw.path, kw.limit),
  write_file: (kw) => runWrite(kw.path, kw.content),
  edit_file: (kw) => runEdit(kw.path, kw.old_text, kw.new_text),
  task_create: (kw) => TASKS.create(kw.subject, kw.description || ""),
  task_list: () => TASKS.listAll(),
  task_get: (kw) => TASKS.get(kw.task_id),
  task_update: (kw) => TASKS.update(kw.task_id, kw.status, kw.owner),
  task_bind_worktree: (kw) => TASKS.bindWorktree(kw.task_id, kw.worktree, kw.owner || ""),
  worktree_create: (kw) => WORKTREES.create(kw.name, kw.task_id, kw.base_ref || "HEAD"),
  worktree_list: () => WORKTREES.listAll(),
  worktree_status: (kw) => WORKTREES.status(kw.name),
  worktree_run: (kw) => WORKTREES.run(kw.name, kw.command),
  worktree_keep: (kw) => WORKTREES.keep(kw.name),
  worktree_remove: (kw) => WORKTREES.remove(kw.name, kw.force || false, kw.complete_task || false),
  worktree_events: (kw) => EVENTS.listRecent(kw.limit || 20),
};

const TOOLS: any[] = [
  {
    name: "bash",
    description: "Run a shell command in the current workspace (blocking).",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "Read file contents.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        limit: { type: "integer" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to file.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
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
    name: "task_create",
    description: "Create a new task on the shared task board.",
    input_schema: {
      type: "object",
      properties: {
        subject: { type: "string" },
        description: { type: "string" },
      },
      required: ["subject"],
    },
  },
  {
    name: "task_list",
    description: "List all tasks with status, owner, and worktree binding.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "task_get",
    description: "Get task details by ID.",
    input_schema: {
      type: "object",
      properties: { task_id: { type: "integer" } },
      required: ["task_id"],
    },
  },
  {
    name: "task_update",
    description: "Update task status or owner.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "integer" },
        status: {
          type: "string",
          enum: ["pending", "in_progress", "completed"],
        },
        owner: { type: "string" },
      },
      required: ["task_id"],
    },
  },
  {
    name: "task_bind_worktree",
    description: "Bind a task to a worktree name.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "integer" },
        worktree: { type: "string" },
        owner: { type: "string" },
      },
      required: ["task_id", "worktree"],
    },
  },
  {
    name: "worktree_create",
    description: "Create a git worktree and optionally bind it to a task.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        task_id: { type: "integer" },
        base_ref: { type: "string" },
      },
      required: ["name"],
    },
  },
  {
    name: "worktree_list",
    description: "List worktrees tracked in .worktrees/index.json.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "worktree_status",
    description: "Show git status for one worktree.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "worktree_run",
    description: "Run a shell command in a named worktree directory.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        command: { type: "string" },
      },
      required: ["name", "command"],
    },
  },
  {
    name: "worktree_remove",
    description: "Remove a worktree and optionally mark its bound task completed.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        force: { type: "boolean" },
        complete_task: { type: "boolean" },
      },
      required: ["name"],
    },
  },
  {
    name: "worktree_keep",
    description: "Mark a worktree as kept in lifecycle state without removing it.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "worktree_events",
    description: "List recent worktree/task lifecycle events from .worktrees/events.jsonl.",
    input_schema: {
      type: "object",
      properties: { limit: { type: "integer" } },
    },
  },
];

async function agentLoop(messages: any[]): Promise<void> {
  while (true) {
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

    const results: any[] = [];
    for (const block of response.content as any[]) {
      if (block.type === "tool_use") {
        const handler = TOOL_HANDLERS[block.name];
        let output: string;
        try {
          output = handler ? handler(block.input) : `Unknown tool: ${block.name}`;
        } catch (e: any) {
          output = `Error: ${e.message}`;
        }
        console.log(`> ${block.name}:`);
        console.log(String(output).slice(0, 200));
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: String(output),
        });
      }
    }
    messages.push({ role: "user", content: results });
  }
}

async function main(): Promise<void> {
  console.log(`Repo root for s12: ${REPO_ROOT}`);
  if (!WORKTREES.gitAvailable) {
    console.log("Note: Not in a git repo. worktree_* tools will return errors.");
  }

  const readline = await import("readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const history: any[] = [];
  while (true) {
    let query: string;
    try {
      query = await rl.question("\x1b[36ms12 >> \x1b[0m");
    } catch {
      break;
    }
    if (["q", "exit", ""].includes(query.trim().toLowerCase())) {
      break;
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
