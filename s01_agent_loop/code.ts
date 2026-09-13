#!/usr/bin/env node
/**
 * s01_agent_loop.ts - The Agent Loop
 *
 * The entire secret of an AI coding agent in one pattern:
 *
 *     while (stop_reason === "tool_use") {
 *         response = LLM(messages, tools)
 *         execute tools
 *         append results
 *     }
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
 * until the model decides to stop. Later chapters add policy,
 * hooks, and lifecycle controls around it.
 *
 * Usage:
 *     npm install @anthropic-ai/sdk dotenv
 *     ANTHROPIC_API_KEY=... node s01_agent_loop/code.js
 */

import * as os from "os";
import { execSync } from "child_process";
import * as readline from "readline";

import Anthropic from "@anthropic-ai/sdk";
import * as dotenv from "dotenv";

dotenv.config({ override: true });

if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

const client = new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL });
const MODEL = process.env.MODEL_ID as string;

const SYSTEM = `You are a coding agent at ${process.cwd()}. Use bash to solve tasks. Act, don't explain.`;

// -- Tool definition: just bash --
const TOOLS: any[] = [
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

// -- Tool execution --
function runBash(command: string): string {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => command.includes(d))) {
    return "Error: Dangerous command blocked";
  }
  try {
    const out = execSync(command, {
      shell: "/bin/sh",
      cwd: process.cwd(),
      encoding: "utf-8",
      timeout: 120_000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return out ? out.slice(0, 50000) : "(no output)";
  } catch (e: any) {
    // execSync throws on non-zero exit; combine stdout + stderr like Python.
    if (e && (e.stdout !== undefined || e.stderr !== undefined)) {
      const out = ((e.stdout || "") + (e.stderr || "")).trim();
      if (e.signal === "SIGTERM" || e.code === "ETIMEDOUT") {
        return "Error: Timeout (120s)";
      }
      return out ? out.slice(0, 50000) : "(no output)";
    }
    return `Error: ${e}`;
  }
}

// -- The core pattern: a while loop that calls tools until the model stops --
async function agentLoop(messages: any[]): Promise<void> {
  while (true) {
    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages,
      tools: TOOLS,
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
    for (const block of response.content as any[]) {
      if (block.type === "tool_use") {
        console.log(`\x1b[33m$ ${block.input["command"]}\x1b[0m`);
        const output = runBash(block.input["command"]);
        console.log(output.slice(0, 200));
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: output,
        });
      }
    }

    // Feed tool results back, loop continues
    messages.push({ role: "user", content: results });
  }
}

// -- Entry point --
async function main(): Promise<void> {
  console.log("s01: Agent Loop");
  console.log("Enter a question, press Enter to send. Type q to quit.\n");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const ask = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));

  const history: any[] = [];
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
    await agentLoop(history);
    // Print the model's final text response
    const responseContent = history[history.length - 1]["content"];
    if (Array.isArray(responseContent)) {
      for (const block of responseContent) {
        if (block?.type === "text") {
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
