#!/usr/bin/env node
/**
 * s14: MCP Tools - discover external tools and add them to the agent loop.
 *
 * Run:  node s14_mcp_plugin/code.ts (或经 ts-node / 编译后运行)
 * Need: npm install @anthropic-ai/sdk dotenv + .env with ANTHROPIC_API_KEY
 *
 *     connect_mcp("docs")
 *               |
 *               v
 *     +------------------+     tools/list     +------------------+
 *     | Agent Harness    | <----------------- | MCP server       |
 *     |                  |                    | docs             |
 *     | built-in tools   |     tools/call     |                  |
 *     | + MCP tools      | -----------------> | search           |
 *     +--------+---------+                    | get_version      |
 *              |                              +------------------+
 *              v
 *     +-----------------------------------------------+
 *     | bash | read | write | edit | glob | connect  |
 *     | mcp__docs__search | mcp__docs__get_version   |
 *     +-----------------------------------------------+
 */

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import * as glob from "glob";
import * as readlineSync from "readline-sync";
import Anthropic from "@anthropic-ai/sdk";
import * as dotenv from "dotenv";
// Node 无 Python readline.parse_and_bind 等价物，这里省略 TTY 绑定逻辑。

dotenv.config({ override: true });
if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

const WORKDIR: string = process.cwd();
const client = new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL });
const MODEL: string = process.env.MODEL_ID as string;

const BASE_SYSTEM =
  `You are a coding agent at ${WORKDIR}. Use built-in and connected MCP ` +
  "tools to solve tasks. Call connect_mcp before using a server.";

// 判断 child 是否在 parent 之下（等价于 Python 的 Path.is_relative_to）
function isRelativeTo(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function promptInput(prompt: string): string {
  return readlineSync.question(prompt);
}

// -- From s04: base tools --

function runBash(command: string): string {
  try {
    const output = execSync(command, {
      cwd: WORKDIR,
      timeout: 120000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    })
      .toString()
      .trim();
    return output ? output.slice(0, 50000) : "(no output)";
  } catch (error: any) {
    if (error.killed || error.signal === "SIGTERM") {
      return "Error: Timeout (120s)";
    }
    if (error.code && typeof error.status !== "number") {
      // OSError 类：无退出码
      return `Error: ${error.constructor?.name || "OSError"}: ${error}`;
    }
    let output = ((error.stdout || "") + (error.stderr || "")).toString().trim();
    output = output ? output.slice(0, 50000) : "(no output)";
    if (error.status) {
      return `Error: command exited with status ${error.status}\n${output}`;
    }
    return output;
  }
}

function runRead(pathArg: string, limit: number | null = null): string {
  try {
    let lines = fs
      .readFileSync(path.resolve(path.join(WORKDIR, pathArg)), "utf-8")
      .split("\n");
    if (limit && limit < lines.length) {
      lines = lines.slice(0, limit).concat([`... (${lines.length - limit} more lines)`]);
    }
    return lines.join("\n");
  } catch (exc) {
    return `Error: ${exc}`;
  }
}

function runWrite(pathArg: string, content: string): string {
  try {
    const target = path.resolve(path.join(WORKDIR, pathArg));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf-8");
    return `Wrote ${content.length} bytes to ${pathArg}`;
  } catch (exc) {
    return `Error: ${exc}`;
  }
}

function runEdit(pathArg: string, oldText: string, newText: string): string {
  try {
    const target = path.resolve(path.join(WORKDIR, pathArg));
    const content = fs.readFileSync(target, "utf-8");
    const count = content.split(oldText).length - 1; // 出现次数
    if (count !== 1) {
      return `Error: Expected 1 occurrence, found ${count}`;
    }
    fs.writeFileSync(target, content.replace(oldText, newText), "utf-8");
    return `Edited ${pathArg}`;
  } catch (exc) {
    return `Error: ${exc}`;
  }
}

function runGlob(pattern: string): string {
  try {
    const matches = glob
      .sync(pattern, { cwd: WORKDIR })
      .filter((match) => isRelativeTo(path.resolve(path.join(WORKDIR, match)), path.resolve(WORKDIR)));
    return matches.length ? matches.slice(0, 200).join("\n") : "(no matches)";
  } catch (exc) {
    return `Error: ${exc}`;
  }
}

const BASE_TOOLS = [
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
    description: "Write content to a file.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description: "Replace exact text once.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } },
      required: ["path", "old_text", "new_text"],
    },
  },
  {
    name: "glob",
    description: "Find files by glob pattern.",
    input_schema: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] },
  },
];

const BASE_HANDLERS: Record<string, (...args: any[]) => string> = {
  bash: (input: any) => runBash(input.command),
  read_file: (input: any) => runRead(input.path, input.limit ?? null),
  write_file: (input: any) => runWrite(input.path, input.content),
  edit_file: (input: any) => runEdit(input.path, input.old_text, input.new_text),
  glob: (input: any) => runGlob(input.pattern),
};

// -- New in s14: MCP discovery and dispatch --

/** Small in-process stand-in for MCP tools/list and tools/call. */
class MCPClient {
  name: string;
  tools: any[] = [];
  private _handlers: Record<string, (...args: any[]) => any> = {};

  constructor(name: string) {
    this.name = name;
  }

  register(toolDefs: any[], handlers: Record<string, (...args: any[]) => any>): void {
    const names = toolDefs.map((tool) => tool.name);
    if (names.some((name) => typeof name !== "string" || !name)) {
      throw new Error("Every MCP tool needs a non-empty name");
    }
    if (new Set(names).size !== names.length) {
      throw new Error(`Duplicate MCP tool name on server ${JSON.stringify(this.name)}`);
    }
    const missing = names.filter((name) => !(name in handlers));
    if (missing.length) {
      throw new Error(`Missing MCP handlers: ${missing.join(", ")}`);
    }
    this.tools = [...toolDefs];
    this._handlers = { ...handlers };
  }

  callTool(toolName: string, args: Record<string, any>): string {
    const handler = this._handlers[toolName];
    if (!handler) {
      return `MCP error: unknown tool '${toolName}'`;
    }
    try {
      return String(handler(args));
    } catch (exc: any) {
      return `MCP error: ${exc?.constructor?.name || "Error"}: ${exc}`;
    }
  }
}

const mcpClients: Record<string, MCPClient> = {};
let mcpToolPolicies: Record<string, string> = {};
const _DISALLOWED_CHARS = /[^a-zA-Z0-9_-]/g;

// Authorization comes from host configuration, never server descriptions.
const MCP_HOST_POLICY: Record<string, string> = {
  "docs\u0000search": "allow",
  "docs\u0000get_version": "allow",
  "deploy\u0000status": "allow",
  "deploy\u0000trigger": "confirm",
};

// 用 (server, tool) 组合查策略，模拟 Python 的元组键
function hostPolicy(server: string, tool: string): string | undefined {
  return MCP_HOST_POLICY[`${server}\u0000${tool}`];
}

/** Replace characters outside the model tool-name alphabet. */
function normalizeMcpName(name: string): string {
  const normalized = name.replace(_DISALLOWED_CHARS, "_");
  if (!normalized) {
    throw new Error("MCP names cannot normalize to an empty string");
  }
  return normalized;
}

function _mockServerDocs(): MCPClient {
  const server = new MCPClient("docs");
  server.register(
    [
      {
        name: "search",
        description: "Search the documentation.",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
        annotations: { readOnlyHint: true },
      },
      {
        name: "get_version",
        description: "Get the documentation API version.",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true },
      },
    ],
    {
      search: (args: any) => `[docs] Found 3 results for '${args.query}'`,
      get_version: () => "[docs] API v2.1.0",
    }
  );
  return server;
}

function _mockServerDeploy(): MCPClient {
  const server = new MCPClient("deploy");
  server.register(
    [
      {
        name: "trigger",
        description: "Trigger a deployment.",
        inputSchema: {
          type: "object",
          properties: { service: { type: "string" } },
          required: ["service"],
        },
        annotations: { destructiveHint: true },
      },
      {
        name: "status",
        description: "Check deployment status.",
        inputSchema: {
          type: "object",
          properties: { service: { type: "string" } },
          required: ["service"],
        },
        annotations: { readOnlyHint: true },
      },
    ],
    {
      trigger: (args: any) => `[deploy] Triggered: ${args.service}`,
      status: (args: any) => `[deploy] ${args.service}: running (v1.4.2)`,
    }
  );
  return server;
}

const MOCK_SERVERS: Record<string, () => MCPClient> = {
  docs: _mockServerDocs,
  deploy: _mockServerDeploy,
};

function connectMcp(name: string): string {
  if (name in mcpClients) {
    return `MCP server '${name}' already connected`;
  }
  const factory = MOCK_SERVERS[name];
  if (!factory) {
    return `Unknown server '${name}'. Available: ${Object.keys(MOCK_SERVERS).join(", ")}`;
  }
  const server = factory();
  mcpClients[name] = server;
  const names = server.tools.map((tool) => tool.name).join(", ");
  console.log(`  [mcp] connected: ${name} -> ${names}`);
  return `Connected to MCP server '${name}'. ` + `Discovered ${server.tools.length} tools: ${names}`;
}

function runConnectMcp(name: string): string {
  return connectMcp(name);
}

const CONNECT_TOOL = {
  name: "connect_mcp",
  description: "Connect to an MCP server and discover its tools.",
  input_schema: {
    type: "object",
    properties: { name: { type: "string", enum: ["docs", "deploy"] } },
    required: ["name"],
  },
};

const BUILTIN_TOOLS = [...BASE_TOOLS, CONNECT_TOOL];
const BUILTIN_HANDLERS: Record<string, (...args: any[]) => string> = {
  ...BASE_HANDLERS,
  connect_mcp: (input: any) => runConnectMcp(input.name),
};

/** Combine built-in tools with every connected server tool. */
function assembleToolPool(): [any[], Record<string, (...args: any[]) => any>] {
  const tools = [...BUILTIN_TOOLS];
  const handlers: Record<string, (...args: any[]) => any> = { ...BUILTIN_HANDLERS };
  const policies: Record<string, string> = {};
  const origins: Record<string, string> = {};
  for (const tool of tools) {
    origins[tool.name] = `built-in tool '${tool.name}'`;
  }

  for (const [serverName, server] of Object.entries(mcpClients)) {
    const safeServer = normalizeMcpName(serverName);
    for (const toolDef of server.tools) {
      const rawName = toolDef.name;
      const safeTool = normalizeMcpName(rawName);
      const prefixed = `mcp__${safeServer}__${safeTool}`;
      if (prefixed.length > 64) {
        throw new Error(`MCP tool name is longer than 64 characters: ${prefixed}`);
      }
      const origin = `MCP tool '${serverName}'/'${rawName}'`;
      if (prefixed in origins) {
        throw new Error(
          "MCP tool name collision after normalization: " +
            `'${prefixed}' maps both ${origins[prefixed]} and ${origin}`
        );
      }
      const schema = toolDef.inputSchema ?? {};
      if (typeof schema !== "object" || schema === null || (schema.type ?? "object") !== "object") {
        throw new Error(`Invalid input schema for ${origin}`);
      }
      origins[prefixed] = origin;
      tools.push({
        name: prefixed,
        description: toolDef.description ?? "",
        input_schema: schema,
      });
      // 闭包捕获 client 与 tool 名（对应 Python 的默认参数绑定）
      handlers[prefixed] = ((clientRef: MCPClient, toolRef: string) => (kwargs: Record<string, any>) =>
        clientRef.callTool(toolRef, kwargs))(server, rawName);
      policies[prefixed] = hostPolicy(serverName, rawName) ?? "confirm";
    }
  }

  mcpToolPolicies = policies;
  return [tools, handlers];
}

function assembleSystemPrompt(): string {
  if (Object.keys(mcpClients).length === 0) {
    return BASE_SYSTEM;
  }
  return BASE_SYSTEM + "\n\nConnected MCP servers: " + Object.keys(mcpClients).join(", ");
}

// -- From s04: hooks and permission checks --

const HOOKS: Record<string, ((...args: any[]) => any)[]> = {
  UserPromptSubmit: [],
  PreToolUse: [],
  PostToolUse: [],
  Stop: [],
};
const DENY_LIST = ["rm -rf /", "sudo", "shutdown", "reboot", "mkfs", "dd if="];
const DESTRUCTIVE = ["rm ", "> /etc/", "chmod 777"];

function registerHook(event: string, callback: (...args: any[]) => any): void {
  HOOKS[event].push(callback);
}

function triggerHooks(event: string, ...args: any[]): any {
  for (const callback of HOOKS[event]) {
    const result = callback(...args);
    if (result !== null && result !== undefined) {
      return result;
    }
  }
  return null;
}

function permissionHook(block: any): string | null {
  if (block.name === "bash") {
    const command = block.input.command ?? "";
    for (const pattern of DENY_LIST) {
      if (command.includes(pattern)) {
        return `Permission denied by deny list: ${pattern}`;
      }
    }
    if (DESTRUCTIVE.some((keyword) => command.includes(keyword))) {
      console.log(`\n[permission] ${block.name}(${JSON.stringify(block.input)})`);
      if (!["y", "yes"].includes(promptInput("Allow? [y/N] ").trim().toLowerCase())) {
        return "Permission denied by user";
      }
    }
  }

  if (["read_file", "write_file", "edit_file"].includes(block.name)) {
    const rawPath = block.input.path ?? "";
    if (!isRelativeTo(path.resolve(path.join(WORKDIR, rawPath)), path.resolve(WORKDIR))) {
      console.log(`\n[permission] ${block.name}(${JSON.stringify(block.input)})`);
      if (!["y", "yes"].includes(promptInput("Allow? [y/N] ").trim().toLowerCase())) {
        return "Permission denied by user";
      }
    }
  }

  if (block.name.startsWith("mcp__")) {
    const policy = mcpToolPolicies[block.name] ?? "confirm";
    if (policy !== "allow") {
      console.log(`\n[permission] External tool ${block.name}(${JSON.stringify(block.input)})`);
      if (!["y", "yes"].includes(promptInput("Allow? [y/N] ").trim().toLowerCase())) {
        return "Permission denied by user";
      }
    }
  }
  return null;
}

function logHook(block: any): null {
  const preview = String(JSON.stringify(Object.values(block.input).slice(0, 2))).slice(0, 60);
  console.log(`[hook] ${block.name}(${preview})`);
  return null;
}

function largeOutputHook(block: any, output: any): null {
  if (String(output).length > 100000) {
    console.log(`[hook] Large output from ${block.name}: ${String(output).length} chars`);
  }
  return null;
}

function contextHook(query: string): null {
  console.log(`[hook] UserPromptSubmit: working in ${WORKDIR}`);
  return null;
}

function summaryHook(messages: any[]): null {
  let toolCount = 0;
  for (const message of messages) {
    const content = Array.isArray(message.content) ? message.content : [];
    for (const block of content) {
      if (typeof block === "object" && block !== null && block.type === "tool_result") {
        toolCount += 1;
      }
    }
  }
  console.log(`[hook] Stop: session used ${toolCount} tool calls`);
  return null;
}

registerHook("UserPromptSubmit", contextHook);
registerHook("PreToolUse", permissionHook);
registerHook("PreToolUse", logHook);
registerHook("PostToolUse", largeOutputHook);
registerHook("Stop", summaryHook);

function executeTool(block: any, handlers: Record<string, (...args: any[]) => any>): string {
  const blocked = triggerHooks("PreToolUse", block);
  if (blocked) {
    return String(blocked);
  }
  const handler = handlers[block.name];
  if (!handler) {
    return `Unknown tool: ${block.name}`;
  }
  let output: string;
  try {
    output = String(handler(block.input));
  } catch (exc: any) {
    output = `Error: ${exc?.constructor?.name || "Error"}: ${exc}`;
  }
  triggerHooks("PostToolUse", block, output);
  return output;
}

// -- Agent loop with a dynamic tool pool --

async function agentLoop(messages: any[]): Promise<void> {
  while (true) {
    let response: any;
    let handlers: Record<string, (...args: any[]) => any>;
    try {
      const [tools, assembledHandlers] = assembleToolPool();
      handlers = assembledHandlers;
      response = await client.messages.create({
        model: MODEL,
        system: assembleSystemPrompt(),
        messages,
        tools: tools as any,
        max_tokens: 8000,
      });
    } catch (exc: any) {
      messages.push({
        role: "assistant",
        content: [
          {
            type: "text",
            text: `[Error] ${exc?.constructor?.name || "Error"}: ${exc}`,
          },
        ],
      });
      triggerHooks("Stop", messages);
      return;
    }

    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") {
      triggerHooks("Stop", messages);
      return;
    }

    const results: any[] = [];
    for (const block of response.content) {
      if ((block as any).type !== "tool_use") {
        continue;
      }
      console.log(`> ${(block as any).name}`);
      const output = executeTool(block, handlers);
      console.log(output.slice(0, 300));
      results.push({
        type: "tool_result",
        tool_use_id: (block as any).id,
        content: output,
      });
    }
    messages.push({ role: "user", content: results });
  }
}

async function main(): Promise<void> {
  console.log("s14: MCP tools");
  console.log("Enter a question, press Enter to send. Type q to quit.\n");
  const history: any[] = [];

  while (true) {
    let query: string;
    try {
      query = promptInput("s14 >> ");
    } catch (e) {
      break;
    }
    if (["q", "exit", ""].includes(query.trim().toLowerCase())) {
      break;
    }
    triggerHooks("UserPromptSubmit", query);
    history.push({ role: "user", content: query });
    await agentLoop(history);
    for (const block of history[history.length - 1].content ?? []) {
      if ((block as any)?.type === "text" && typeof (block as any).text === "string" && !(typeof block === "object" && block.constructor === Object)) {
        console.log((block as any).text);
      } else if (typeof block === "object" && block !== null && block.type === "text") {
        console.log(block.text ?? "");
      }
    }
    console.log();
  }
}

if (require.main === module) {
  main();
}
