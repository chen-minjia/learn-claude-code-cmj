#!/usr/bin/env node
// Harness: the loop -- the model's first connection to the real world.
/**
 * s01_agent_loop.ts - The Agent Loop
 *
 * The entire secret of an AI coding agent in one pattern:
 *
 *     while stop_reason == "tool_use":
 *         response = LLM(messages, tools)
 *         execute tools
 *         append results
 *
 *     +----------+      +-------+      +---------+
 *     |   User   | ---> |  LLM  | ---> |  Tool   |
 *     |  prompt  |      |       |      | execute |
 *     +----------+      +---+---+      +----+----+
 *                           ^               |
 *                           |   tool_result |
 *                           +---------------+
 *                           (loop continues)
 *
 * This is the core loop: feed tool results back to the model
 * until the model decides to stop. Production agents layer
 * policy, hooks, and lifecycle controls on top.
 */

import * as os from "os";
import { execSync } from "child_process";
import * as readline from "readline";

// Anthropic SDK (Node): npm install @anthropic-ai/sdk
import Anthropic from "@anthropic-ai/sdk";
// dotenv equivalent for Node: npm install dotenv
import * as dotenv from "dotenv";

dotenv.config({ override: true });

if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

const client = new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL });
const MODEL = process.env.MODEL_ID as string;

const SYSTEM = `You are a coding agent at ${process.cwd()}. Use bash to solve tasks. Act, don't explain.`;

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
];

function run_bash(command: string): string {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => command.includes(d))) {
    return "Error: Dangerous command blocked";
  }
  try {
    const out = execSync(command, {
      cwd: process.cwd(),
      encoding: "utf-8",
      timeout: 120000,
    }).trim();
    return out ? out.slice(0, 50000) : "(no output)";
  } catch (e: any) {
    if (e && e.killed && e.signal === "SIGTERM") {
      return "Error: Timeout (120s)";
    }
    // Combine stdout + stderr on failure, mirroring Python's capture behavior.
    const out = ((e.stdout || "") + (e.stderr || "")).trim();
    if (out) return out.slice(0, 50000);
    return `Error: ${e.message ?? e}`;
  }
}

// -- The core pattern: a while loop that calls tools until the model stops --
async function agent_loop(messages: any[]): Promise<void> {
  while (true) {
    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages,
      tools: TOOLS as any,
      max_tokens: 8000,
    });
    // Append assistant turn
    messages.push({ role: "assistant", content: response.content });
    // If the model didn't call a tool, we're done
    if (response.stop_reason !== "tool_use") {
      return;
    }
    // Execute each tool call, collect results
    const results: any[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        console.log(`\x1b[33m$ ${(block.input as any)["command"]}\x1b[0m`);
        const output = run_bash((block.input as any)["command"]);
        console.log(output.slice(0, 200));
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: output,
        });
      }
    }
    messages.push({ role: "user", content: results });
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
      query = await ask("\x1b[36ms01 >> \x1b[0m");
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
