#!/usr/bin/env node
// Harness: protocols -- structured handshakes between models.
/**
 * s10_team_protocols.ts - Team Protocols
 *
 * Shutdown protocol and plan approval protocol, both using the same
 * request_id correlation pattern. Builds on s09's team messaging.
 *
 *     Shutdown FSM: pending -> approved | rejected
 *
 *     Lead                              Teammate
 *     +---------------------+          +---------------------+
 *     | shutdown_request     |          |                     |
 *     | {                    | -------> | receives request    |
 *     |   request_id: abc    |          | decides: approve?   |
 *     | }                    |          |                     |
 *     +---------------------+          +---------------------+
 *                                              |
 *     +---------------------+          +-------v-------------+
 *     | shutdown_response    | <------- | shutdown_response   |
 *     | {                    |          | {                   |
 *     |   request_id: abc    |          |   request_id: abc   |
 *     |   approve: true      |          |   approve: true     |
 *     | }                    |          | }                   |
 *     +---------------------+          +---------------------+
 *             |
 *             v
 *     status -> "shutdown", thread stops
 *
 *     Plan approval FSM: pending -> approved | rejected
 *
 *     Teammate                          Lead
 *     +---------------------+          +---------------------+
 *     | plan_approval        |          |                     |
 *     | submit: {plan:"..."}| -------> | reviews plan text   |
 *     +---------------------+          | approve/reject?     |
 *                                      +---------------------+
 *                                              |
 *     +---------------------+          +-------v-------------+
 *     | plan_approval_resp   | <------- | plan_approval       |
 *     | {approve: true}      |          | review: {req_id,    |
 *     +---------------------+          |   approve: true}     |
 *                                      +---------------------+
 *
 *     Trackers: {request_id: {"target|from": name, "status": "pending|..."}}
 *
 * Key insight: "Same request_id correlation pattern, two domains."
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

const SYSTEM = `You are a team lead at ${WORKDIR}. Manage teammates with shutdown and plan approval protocols.`;

const VALID_MSG_TYPES = new Set([
  "message",
  "broadcast",
  "shutdown_request",
  "shutdown_response",
  "plan_approval_response",
]);

// -- Request trackers: correlate by request_id --
const shutdownRequests: Record<string, any> = {};
const planRequests: Record<string, any> = {};
// Note: Node's single-threaded event loop makes an explicit lock unnecessary;
// the Python _tracker_lock is preserved conceptually as a no-op here.

// -- MessageBus: JSONL inbox per teammate --
class MessageBus {
  dir: string;

  constructor(inboxDir: string) {
    this.dir = inboxDir;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  send(
    sender: string,
    to: string,
    content: string,
    msgType = "message",
    extra: Record<string, any> | null = null
  ): string {
    if (!VALID_MSG_TYPES.has(msgType)) {
      return `Error: Invalid type '${msgType}'. Valid: {${[...VALID_MSG_TYPES].join(", ")}}`;
    }
    const msg: Record<string, any> = {
      type: msgType,
      from: sender,
      content,
      timestamp: Date.now() / 1000,
    };
    if (extra) {
      Object.assign(msg, extra);
    }
    const inboxPath = path.join(this.dir, `${to}.jsonl`);
    fs.appendFileSync(inboxPath, JSON.stringify(msg) + "\n");
    return `Sent ${msgType} to ${to}`;
  }

  readInbox(name: string): Record<string, any>[] {
    const inboxPath = path.join(this.dir, `${name}.jsonl`);
    if (!fs.existsSync(inboxPath)) {
      return [];
    }
    const messages: Record<string, any>[] = [];
    for (const line of fs.readFileSync(inboxPath, "utf-8").trim().split("\n")) {
      if (line) {
        messages.push(JSON.parse(line));
      }
    }
    fs.writeFileSync(inboxPath, "");
    return messages;
  }

  broadcast(sender: string, content: string, teammates: string[]): string {
    let count = 0;
    for (const name of teammates) {
      if (name !== sender) {
        this.send(sender, name, content, "broadcast");
        count += 1;
      }
    }
    return `Broadcast to ${count} teammates`;
  }
}

const BUS = new MessageBus(INBOX_DIR);

// -- TeammateManager with shutdown + plan approval --
class TeammateManager {
  dir: string;
  configPath: string;
  config: Record<string, any>;
  threads: Record<string, any> = {};

  constructor(teamDir: string) {
    this.dir = teamDir;
    fs.mkdirSync(this.dir, { recursive: true });
    this.configPath = path.join(this.dir, "config.json");
    this.config = this._loadConfig();
  }

  private _loadConfig(): Record<string, any> {
    if (fs.existsSync(this.configPath)) {
      return JSON.parse(fs.readFileSync(this.configPath, "utf-8"));
    }
    return { team_name: "default", members: [] };
  }

  private _saveConfig(): void {
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
  }

  private _findMember(name: string): Record<string, any> | null {
    for (const m of this.config["members"]) {
      if (m["name"] === name) {
        return m;
      }
    }
    return null;
  }

  spawn(name: string, role: string, prompt: string): string {
    let member = this._findMember(name);
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
    this._saveConfig();
    this.threads[name] = this._teammateLoop(name, role, prompt);
    return `Spawned '${name}' (role: ${role})`;
  }

  private async _teammateLoop(name: string, role: string, prompt: string): Promise<void> {
    const sysPrompt =
      `You are '${name}', role: ${role}, at ${WORKDIR}. ` +
      `Submit plans via plan_approval before major work. ` +
      `Respond to shutdown_request with shutdown_response.`;
    const messages: any[] = [{ role: "user", content: prompt }];
    const tools = this._teammateTools();
    let shouldExit = false;
    for (let i = 0; i < 50; i++) {
      const inbox = BUS.readInbox(name);
      for (const msg of inbox) {
        messages.push({ role: "user", content: JSON.stringify(msg) });
      }
      if (shouldExit) {
        break;
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
        break;
      }
      messages.push({ role: "assistant", content: response.content });
      if (response.stop_reason !== "tool_use") {
        break;
      }
      const results: any[] = [];
      for (const block of response.content) {
        if (block.type === "tool_use") {
          const output = this._exec(name, block.name, block.input);
          console.log(`  [${name}] ${block.name}: ${String(output).slice(0, 120)}`);
          results.push({ type: "tool_result", tool_use_id: block.id, content: String(output) });
          if (block.name === "shutdown_response" && block.input["approve"]) {
            shouldExit = true;
          }
        }
      }
      messages.push({ role: "user", content: results });
    }
    const member = this._findMember(name);
    if (member) {
      member["status"] = shouldExit ? "shutdown" : "idle";
      this._saveConfig();
    }
  }

  private _exec(sender: string, toolName: string, args: Record<string, any>): string {
    // these base tools are unchanged from s02
    if (toolName === "bash") {
      return _runBash(args["command"]);
    }
    if (toolName === "read_file") {
      return _runRead(args["path"]);
    }
    if (toolName === "write_file") {
      return _runWrite(args["path"], args["content"]);
    }
    if (toolName === "edit_file") {
      return _runEdit(args["path"], args["old_text"], args["new_text"]);
    }
    if (toolName === "send_message") {
      return BUS.send(sender, args["to"], args["content"], args["msg_type"] || "message");
    }
    if (toolName === "read_inbox") {
      return JSON.stringify(BUS.readInbox(sender), null, 2);
    }
    if (toolName === "shutdown_response") {
      const reqId = args["request_id"];
      const approve = args["approve"];
      if (reqId in shutdownRequests) {
        shutdownRequests[reqId]["status"] = approve ? "approved" : "rejected";
      }
      BUS.send(sender, "lead", args["reason"] || "", "shutdown_response", {
        request_id: reqId,
        approve,
      });
      return `Shutdown ${approve ? "approved" : "rejected"}`;
    }
    if (toolName === "plan_approval") {
      const planText = args["plan"] || "";
      const reqId = randomUUID().slice(0, 8);
      planRequests[reqId] = { from: sender, plan: planText, status: "pending" };
      BUS.send(sender, "lead", planText, "plan_approval_response", {
        request_id: reqId,
        plan: planText,
      });
      return `Plan submitted (request_id=${reqId}). Waiting for lead approval.`;
    }
    return `Unknown tool: ${toolName}`;
  }

  private _teammateTools(): any[] {
    // these base tools are unchanged from s02
    return [
      {
        name: "bash",
        description: "Run a shell command.",
        input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      },
      {
        name: "read_file",
        description: "Read file contents.",
        input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
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
        name: "send_message",
        description: "Send message to a teammate.",
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
        description: "Read and drain your inbox.",
        input_schema: { type: "object", properties: {} },
      },
      {
        name: "shutdown_response",
        description:
          "Respond to a shutdown request. Approve to shut down, reject to keep working.",
        input_schema: {
          type: "object",
          properties: {
            request_id: { type: "string" },
            approve: { type: "boolean" },
            reason: { type: "string" },
          },
          required: ["request_id", "approve"],
        },
      },
      {
        name: "plan_approval",
        description: "Submit a plan for lead approval. Provide plan text.",
        input_schema: {
          type: "object",
          properties: { plan: { type: "string" } },
          required: ["plan"],
        },
      },
    ];
  }

  listAll(): string {
    if (!this.config["members"].length) {
      return "No teammates.";
    }
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

const TEAM = new TeammateManager(TEAM_DIR);

// -- Base tool implementations (these base tools are unchanged from s02) --
function _safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  if (!(resolved === WORKDIR || resolved.startsWith(WORKDIR + path.sep))) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}

function _runBash(command: string): string {
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

function _runRead(p: string, limit: number | null = null): string {
  try {
    let lines = fs.readFileSync(_safePath(p), "utf-8").split("\n");
    if (limit && limit < lines.length) {
      lines = [...lines.slice(0, limit), `... (${lines.length - limit} more)`];
    }
    return lines.join("\n").slice(0, 50000);
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

function _runWrite(p: string, content: string): string {
  try {
    const fp = _safePath(p);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content);
    return `Wrote ${content.length} bytes`;
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

function _runEdit(p: string, oldText: string, newText: string): string {
  try {
    const fp = _safePath(p);
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

// -- Lead-specific protocol handlers --
function handleShutdownRequest(teammate: string): string {
  const reqId = randomUUID().slice(0, 8);
  shutdownRequests[reqId] = { target: teammate, status: "pending" };
  BUS.send("lead", teammate, "Please shut down gracefully.", "shutdown_request", {
    request_id: reqId,
  });
  return `Shutdown request ${reqId} sent to '${teammate}' (status: pending)`;
}

function handlePlanReview(requestId: string, approve: boolean, feedback = ""): string {
  const req = planRequests[requestId];
  if (!req) {
    return `Error: Unknown plan request_id '${requestId}'`;
  }
  req["status"] = approve ? "approved" : "rejected";
  BUS.send("lead", req["from"], feedback, "plan_approval_response", {
    request_id: requestId,
    approve,
    feedback,
  });
  return `Plan ${req["status"]} for '${req["from"]}'`;
}

function _checkShutdownStatus(requestId: string): string {
  return JSON.stringify(shutdownRequests[requestId] || { error: "not found" });
}

// -- Lead tool dispatch (12 tools) --
const TOOL_HANDLERS: Record<string, (kw: any) => string> = {
  bash: (kw) => _runBash(kw.command),
  read_file: (kw) => _runRead(kw.path, kw.limit),
  write_file: (kw) => _runWrite(kw.path, kw.content),
  edit_file: (kw) => _runEdit(kw.path, kw.old_text, kw.new_text),
  spawn_teammate: (kw) => TEAM.spawn(kw.name, kw.role, kw.prompt),
  list_teammates: () => TEAM.listAll(),
  send_message: (kw) => BUS.send("lead", kw.to, kw.content, kw.msg_type || "message"),
  read_inbox: () => JSON.stringify(BUS.readInbox("lead"), null, 2),
  broadcast: (kw) => BUS.broadcast("lead", kw.content, TEAM.memberNames()),
  shutdown_request: (kw) => handleShutdownRequest(kw.teammate),
  shutdown_response: (kw) => _checkShutdownStatus(kw.request_id || ""),
  plan_approval: (kw) => handlePlanReview(kw.request_id, kw.approve, kw.feedback || ""),
};

// these base tools are unchanged from s02
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
    name: "spawn_teammate",
    description: "Spawn a persistent teammate.",
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
    description: "Send a message to all teammates.",
    input_schema: { type: "object", properties: { content: { type: "string" } }, required: ["content"] },
  },
  {
    name: "shutdown_request",
    description: "Request a teammate to shut down gracefully. Returns a request_id for tracking.",
    input_schema: { type: "object", properties: { teammate: { type: "string" } }, required: ["teammate"] },
  },
  {
    name: "shutdown_response",
    description: "Check the status of a shutdown request by request_id.",
    input_schema: {
      type: "object",
      properties: { request_id: { type: "string" } },
      required: ["request_id"],
    },
  },
  {
    name: "plan_approval",
    description: "Approve or reject a teammate's plan. Provide request_id + approve + optional feedback.",
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
];

async function agentLoop(messages: any[]): Promise<void> {
  while (true) {
    const inbox = BUS.readInbox("lead");
    if (inbox.length) {
      messages.push({
        role: "user",
        content: `<inbox>${JSON.stringify(inbox, null, 2)}</inbox>`,
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
      query = await rl.question("\x1b[36ms10 >> \x1b[0m");
    } catch {
      break;
    }
    if (["q", "exit", ""].includes(query.trim().toLowerCase())) {
      break;
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
