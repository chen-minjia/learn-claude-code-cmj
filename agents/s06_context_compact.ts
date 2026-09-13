#!/usr/bin/env node
// Harness: compression -- clean memory for infinite sessions.
/**
 * s06_context_compact.ts - Compact
 *
 * Three-layer compression pipeline so the agent can work forever:
 *
 *     Every turn:
 *     +------------------+
 *     | Tool call result |
 *     +------------------+
 *             |
 *             v
 *     [Layer 1: micro_compact]        (silent, every turn)
 *       Replace non-read_file tool_result content older than last 3
 *       with "[Previous: used {tool_name}]"
 *             |
 *             v
 *     [Check: tokens > 50000?]
 *        |               |
 *        no              yes
 *        |               |
 *        v               v
 *     continue    [Layer 2: auto_compact]
 *                   Save full transcript to .transcripts/
 *                   Ask LLM to summarize conversation.
 *                   Replace all messages with [summary].
 *                         |
 *                         v
 *                 [Layer 3: compact tool]
 *                   Model calls compact -> immediate summarization.
 *                   Same as auto, triggered manually.
 *
 * Key insight: "The agent can forget strategically and keep working forever."
 */

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import * as readline from "readline";

import Anthropic from "@anthropic-ai/sdk";
import * as dotenv from "dotenv";

dotenv.config({ override: true });

if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

const WORKDIR = process.cwd();
const client = new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL });
const MODEL = process.env.MODEL_ID as string;

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks.`;

const THRESHOLD = 50000;
const TRANSCRIPT_DIR = path.join(WORKDIR, ".transcripts");
const KEEP_RECENT = 3;
const PRESERVE_RESULT_TOOLS = new Set(["read_file"]);

/** Rough token count: ~4 chars per token. */
function estimate_tokens(messages: any[]): number {
  return Math.floor(JSON.stringify(messages).length / 4);
}

// -- Layer 1: micro_compact - replace old tool results with placeholders --
function micro_compact(messages: any[]): any[] {
  // Collect [msg_index, part_index, tool_result_dict] for all tool_result entries
  const tool_results: [number, number, any][] = [];
  messages.forEach((msg, msg_idx) => {
    if (msg["role"] === "user" && Array.isArray(msg["content"])) {
      msg["content"].forEach((part: any, part_idx: number) => {
        if (
          part &&
          typeof part === "object" &&
          part["type"] === "tool_result"
        ) {
          tool_results.push([msg_idx, part_idx, part]);
        }
      });
    }
  });
  if (tool_results.length <= KEEP_RECENT) {
    return messages;
  }
  // Find tool_name for each result by matching tool_use_id in prior assistant messages
  const tool_name_map: Record<string, string> = {};
  for (const msg of messages) {
    if (msg["role"] === "assistant") {
      const content = msg["content"] ?? [];
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block && "type" in block && block.type === "tool_use") {
            tool_name_map[block.id] = block.name;
          }
        }
      }
    }
  }
  // Clear old results (keep last KEEP_RECENT). Preserve read_file outputs because
  // they are reference material; compacting them forces the agent to re-read files.
  const to_clear = tool_results.slice(0, tool_results.length - KEEP_RECENT);
  for (const [, , result] of to_clear) {
    if (typeof result["content"] !== "string" || result["content"].length <= 100) {
      continue;
    }
    const tool_id = result["tool_use_id"] ?? "";
    const tool_name = tool_name_map[tool_id] ?? "unknown";
    if (PRESERVE_RESULT_TOOLS.has(tool_name)) {
      continue;
    }
    result["content"] = `[Previous: used ${tool_name}]`;
  }
  return messages;
}

// -- Layer 2: auto_compact - save transcript, summarize, replace messages --
async function auto_compact(messages: any[], focus: string = ""): Promise<any[]> {
  // Save full transcript to disk
  fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  const transcript_path = path.join(
    TRANSCRIPT_DIR,
    `transcript_${Math.floor(Date.now() / 1000)}.jsonl`
  );
  const stream = messages
    .map((msg) => JSON.stringify(msg))
    .join("\n");
  fs.writeFileSync(transcript_path, stream + (messages.length ? "\n" : ""));
  console.log(`[transcript saved: ${transcript_path}]`);
  // Ask LLM to summarize
  const conversation_text = JSON.stringify(messages).slice(-80000);
  let focus_instruction = "";
  if (focus) {
    focus_instruction = ` Pay special attention to preserving details about: ${focus}.`;
  }
  const response = await client.messages.create({
    model: MODEL,
    messages: [
      {
        role: "user",
        content:
          "Summarize this conversation for continuity. Include: " +
          "1) What was accomplished, 2) Current state, 3) Key decisions made. " +
          "Be concise but preserve critical details." +
          `${focus_instruction}\n\n` +
          conversation_text,
      },
    ],
    max_tokens: 2000,
  });
  let summary =
    response.content.find((block: any) => "text" in block)?.["text"] ?? "";
  if (!summary) {
    summary = "No summary generated.";
  }
  // Replace all messages with compressed summary
  return [
    {
      role: "user",
      content: `[Conversation compressed. Transcript: ${transcript_path}]\n\n${summary}`,
    },
  ];
}

// -- Tool implementations --
function safe_path(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  if (resolved !== WORKDIR && !resolved.startsWith(WORKDIR + path.sep)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}

function run_bash(command: string): string {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => command.includes(d))) {
    return "Error: Dangerous command blocked";
  }
  try {
    const out = execSync(command, {
      cwd: WORKDIR,
      encoding: "utf-8",
      timeout: 120000,
    }).trim();
    return out ? out.slice(0, 50000) : "(no output)";
  } catch (e: any) {
    if (e && e.killed && e.signal === "SIGTERM") {
      return "Error: Timeout (120s)";
    }
    const out = ((e.stdout || "") + (e.stderr || "")).trim();
    return out ? out.slice(0, 50000) : "(no output)";
  }
}

function run_read(pathArg: string, limit: number | null = null): string {
  try {
    let lines = fs.readFileSync(safe_path(pathArg), "utf-8").split("\n");
    if (limit && limit < lines.length) {
      lines = lines.slice(0, limit).concat([`... (${lines.length - limit} more)`]);
    }
    return lines.join("\n").slice(0, 50000);
  } catch (e: any) {
    return `Error: ${e.message ?? e}`;
  }
}

function run_write(pathArg: string, content: string): string {
  try {
    const fp = safe_path(pathArg);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content);
    return `Wrote ${content.length} bytes`;
  } catch (e: any) {
    return `Error: ${e.message ?? e}`;
  }
}

function run_edit(pathArg: string, old_text: string, new_text: string): string {
  try {
    const fp = safe_path(pathArg);
    const content = fs.readFileSync(fp, "utf-8");
    if (!content.includes(old_text)) {
      return `Error: Text not found in ${pathArg}`;
    }
    fs.writeFileSync(fp, content.replace(old_text, new_text));
    return `Edited ${pathArg}`;
  } catch (e: any) {
    return `Error: ${e.message ?? e}`;
  }
}

const TOOL_HANDLERS: Record<string, (kw: any) => string> = {
  bash: (kw) => run_bash(kw["command"]),
  read_file: (kw) => run_read(kw["path"], kw["limit"]),
  write_file: (kw) => run_write(kw["path"], kw["content"]),
  edit_file: (kw) => run_edit(kw["path"], kw["old_text"], kw["new_text"]),
  compact: (_kw) => "Manual compression requested.",
};

const TOOLS = [
  {
    name: "bash",
    description: "Run a shell command.",
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
    name: "compact",
    description: "Trigger manual conversation compression.",
    input_schema: {
      type: "object",
      properties: {
        focus: { type: "string", description: "What to preserve in the summary" },
      },
    },
  },
];

async function agent_loop(messages: any[]): Promise<void> {
  while (true) {
    // Layer 1: micro_compact before each LLM call
    micro_compact(messages);
    // Layer 2: auto_compact if token estimate exceeds threshold
    if (estimate_tokens(messages) > THRESHOLD) {
      console.log("[auto_compact triggered]");
      messages.splice(0, messages.length, ...(await auto_compact(messages)));
    }
    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages,
      tools: TOOLS as any,
      max_tokens: 8000,
    });
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") {
      return;
    }
    const results: any[] = [];
    let manual_compact = false;
    let compact_focus = "";
    for (const block of response.content) {
      if (block.type === "tool_use") {
        let output: string;
        if (block.name === "compact") {
          manual_compact = true;
          compact_focus = (block.input as any)["focus"] ?? "";
          output = "Compressing...";
        } else {
          const handler = TOOL_HANDLERS[block.name];
          try {
            output = handler
              ? handler(block.input)
              : `Unknown tool: ${block.name}`;
          } catch (e: any) {
            output = `Error: ${e.message ?? e}`;
          }
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
    // Layer 3: manual compact triggered by the compact tool
    if (manual_compact) {
      console.log("[manual compact]");
      messages.splice(
        0,
        messages.length,
        ...(await auto_compact(messages, compact_focus))
      );
      return;
    }
  }
}

async function main(): Promise<void> {
  const history: any[] = [];
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const ask = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));
  while (true) {
    let query: string;
    try {
      query = await ask("\x1b[36ms06 >> \x1b[0m");
    } catch {
      break;
    }
    if (["q", "exit", ""].includes(query.trim().toLowerCase())) {
      break;
    }
    history.push({ role: "user", content: query });
    await agent_loop(history);
    const responseContent = history[history.length - 1]["content"];
    if (Array.isArray(responseContent)) {
      for (const block of responseContent) {
        if ("text" in block) {
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
