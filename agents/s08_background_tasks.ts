#!/usr/bin/env node
// Harness: background execution -- the model thinks while the harness waits.
/**
 * s08_background_tasks.ts - Background Tasks
 *
 * Run commands in background threads. A notification queue is drained
 * before each LLM call to deliver results.
 *
 *     Main thread                Background thread
 *     +-----------------+        +-----------------+
 *     | agent loop      |        | task executes   |
 *     | ...             |        | ...             |
 *     | [LLM call] <---+------- | enqueue(result) |
 *     |  ^drain queue   |        +-----------------+
 *     +-----------------+
 *
 *     Timeline:
 *     Agent ----[spawn A]----[spawn B]----[other work]----
 *                  |              |
 *                  v              v
 *               [A runs]      [B runs]        (parallel)
 *                  |              |
 *                  +-- notification queue --> [results injected]
 *
 * Key insight: "Fire and forget -- the agent doesn't block while the command runs."
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

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use background_run for long-running commands.`;

interface BgTask {
  status: string;
  result: string | null;
  command: string;
}

interface BgNotification {
  task_id: string;
  status: string;
  command: string;
  result: string;
}

// -- BackgroundManager: threaded execution + notification queue --
// NOTE: Node has no true threads; we simulate the Python thread model with
// async execution. The notification queue is a plain array.
class BackgroundManager {
  tasks: Record<string, BgTask> = {}; // task_id -> {status, result, command}
  private _notificationQueue: BgNotification[] = []; // completed task results

  run(command: string): string {
    // Start a background execution, return task_id immediately.
    const taskId = randomUUID().slice(0, 8);
    this.tasks[taskId] = { status: "running", result: null, command };
    // Fire and forget: schedule the execution without awaiting it.
    setImmediate(() => this._execute(taskId, command));
    return `Background task ${taskId} started: ${command.slice(0, 80)}`;
  }

  private _execute(taskId: string, command: string): void {
    // Background target: run subprocess, capture output, push to queue.
    let output: string;
    let status: string;
    try {
      const raw = execSync(command, {
        shell: "/bin/sh",
        cwd: WORKDIR,
        encoding: "utf-8",
        timeout: 300000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      output = raw.trim().slice(0, 50000);
      status = "completed";
    } catch (e: any) {
      if (e.killed) {
        output = "Error: Timeout (300s)";
        status = "timeout";
      } else {
        const combined = ((e.stdout || "") + (e.stderr || "")).trim();
        output = combined ? combined.slice(0, 50000) : `Error: ${e.message}`;
        status = combined ? "completed" : "error";
      }
    }
    this.tasks[taskId].status = status;
    this.tasks[taskId].result = output || "(no output)";
    this._notificationQueue.push({
      task_id: taskId,
      status,
      command: command.slice(0, 80),
      result: (output || "(no output)").slice(0, 500),
    });
  }

  check(taskId: string | null = null): string {
    // Check status of one task or list all.
    if (taskId) {
      const t = this.tasks[taskId];
      if (!t) {
        return `Error: Unknown task ${taskId}`;
      }
      return `[${t.status}] ${t.command.slice(0, 60)}\n${t.result || "(running)"}`;
    }
    const lines: string[] = [];
    for (const [tid, t] of Object.entries(this.tasks)) {
      lines.push(`${tid}: [${t.status}] ${t.command.slice(0, 60)}`);
    }
    return lines.length ? lines.join("\n") : "No background tasks.";
  }

  drainNotifications(): BgNotification[] {
    // Return and clear all pending completion notifications.
    const notifs = [...this._notificationQueue];
    this._notificationQueue.length = 0;
    return notifs;
  }
}

const BG = new BackgroundManager();

// -- Tool implementations --
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
  background_run: (kw) => BG.run(kw.command),
  check_background: (kw) => BG.check(kw.task_id),
};

const TOOLS: any[] = [
  {
    name: "bash",
    description: "Run a shell command (blocking).",
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
    name: "background_run",
    description: "Run command in background thread. Returns task_id immediately.",
    input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  },
  {
    name: "check_background",
    description: "Check background task status. Omit task_id to list all.",
    input_schema: { type: "object", properties: { task_id: { type: "string" } } },
  },
];

async function agentLoop(messages: any[]): Promise<void> {
  while (true) {
    // Drain background notifications and inject as system message before LLM call
    const notifs = BG.drainNotifications();
    if (notifs.length && messages.length) {
      const notifText = notifs
        .map((n) => `[bg:${n.task_id}] ${n.status}: ${n.result}`)
        .join("\n");
      messages.push({
        role: "user",
        content: `<background-results>\n${notifText}\n</background-results>`,
      });
    }
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
        results.push({ type: "tool_result", tool_use_id: block.id, content: String(output) });
      }
    }
    messages.push({ role: "user", content: results });
  }
}

async function main(): Promise<void> {
  const readline = await import("readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const history: any[] = [];
  while (true) {
    let query: string;
    try {
      query = await rl.question("\x1b[36ms08 >> \x1b[0m");
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
