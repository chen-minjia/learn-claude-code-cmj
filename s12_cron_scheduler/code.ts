#!/usr/bin/env node
/**
 * s12_cron_scheduler.ts - Cron Scheduler
 *
 *     +--------------------------+   09:00   +-----------------------+
 *     | 0 9 * * *               | --------> | [Scheduled] run tests |
 *     | prompt: "run tests"      |           +-----------+-----------+
 *     +--------------------------+                       |
 *           scheduled_jobs                    cron_queue | agent idle
 *                                                         v
 *                                                 +-------------+
 *                                                 | Agent Loop  |
 *                                                 +-------------+
 */

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import * as crypto from "crypto";
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
const DURABLE_PATH: string = path.join(WORKDIR, ".scheduled_tasks.json");
const client = new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL });
const MODEL: string = process.env.MODEL_ID as string;

const SYSTEM =
  `You are a coding agent at ${WORKDIR}. Use tools to solve tasks. ` +
  "Use schedule_cron for work that should start at a future local time.";

// 判断 child 是否在 parent 之下（等价于 Python 的 Path.is_relative_to）
function isRelativeTo(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function promptInput(prompt: string): string {
  return readlineSync.question(prompt);
}

// -- From s04: tool implementations --

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
    const output = ((error.stdout || "") + (error.stderr || "")).toString().trim();
    const returncode = error.status;
    if (returncode !== 0 && returncode !== null && returncode !== undefined) {
      return `Error: command exited with status ${returncode}\n${output}`;
    }
    return output ? output.slice(0, 50000) : "(no output)";
  }
}

function runRead(pathArg: string, limit: number | null = null): string {
  try {
    const filePath = path.resolve(path.join(WORKDIR, pathArg));
    let lines = fs.readFileSync(filePath, "utf-8").split("\n");
    if (limit && limit < lines.length) {
      lines = lines.slice(0, limit).concat([`... (${lines.length - limit} more lines)`]);
    }
    return lines.join("\n");
  } catch (error) {
    return `Error: ${error}`;
  }
}

function runWrite(pathArg: string, content: string): string {
  try {
    const filePath = path.resolve(path.join(WORKDIR, pathArg));
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
    return `Wrote ${content.length} bytes to ${pathArg}`;
  } catch (error) {
    return `Error: ${error}`;
  }
}

function runEdit(pathArg: string, oldText: string, newText: string): string {
  try {
    const filePath = path.resolve(path.join(WORKDIR, pathArg));
    const text = fs.readFileSync(filePath, "utf-8");
    if (!text.includes(oldText)) {
      return `Error: text not found in ${pathArg}`;
    }
    fs.writeFileSync(filePath, text.replace(oldText, newText)); // 只替换第一处
    return `Edited ${pathArg}`;
  } catch (error) {
    return `Error: ${error}`;
  }
}

function runGlob(pattern: string): string {
  try {
    const matches = glob
      .sync(pattern, { cwd: WORKDIR })
      .filter((match) => isRelativeTo(path.resolve(path.join(WORKDIR, match)), WORKDIR));
    return matches.length ? matches.join("\n") : "(no matches)";
  } catch (error) {
    return `Error: ${error}`;
  }
}

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
    description: "Write content to a file.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description: "Replace exact text in a file once.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } },
      required: ["path", "old_text", "new_text"],
    },
  },
  {
    name: "glob",
    description: "Find files matching a glob pattern.",
    input_schema: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] },
  },
];

const TOOL_HANDLERS: Record<string, (...args: any[]) => string> = {
  bash: (input: any) => runBash(input.command),
  read_file: (input: any) => runRead(input.path, input.limit ?? null),
  write_file: (input: any) => runWrite(input.path, input.content),
  edit_file: (input: any) => runEdit(input.path, input.old_text, input.new_text),
  glob: (input: any) => runGlob(input.pattern),
};

// -- From s04: hooks and permission checks --

const HOOKS: Record<string, ((...args: any[]) => any)[]> = {
  UserPromptSubmit: [],
  PreToolUse: [],
  PostToolUse: [],
  Stop: [],
};

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

const DENY_LIST = ["rm -rf /", "sudo", "shutdown", "reboot", "mkfs", "dd if="];
const DESTRUCTIVE = ["rm ", "> /etc/", "chmod 777"];

// Node 单线程无“主线程 vs 子线程”区分；这里用一个标志表示是否处于计划任务轮次。
let inScheduledTurn = false;

function requestPermission(block: any, reason: string): string | null {
  if (inScheduledTurn) {
    return "Permission denied: scheduled turns cannot request interactive approval";
  }

  console.log(`\n\x1b[33m[permission] ${reason}\x1b[0m`);
  console.log(`   Tool: ${block.name}(${JSON.stringify(block.input)})`);
  const choice = promptInput("   Allow? [y/N] ").trim().toLowerCase();
  if (!["y", "yes"].includes(choice)) {
    return "Permission denied by user";
  }
  return null;
}

function permissionHook(block: any): string | null {
  if (block.name === "bash") {
    const command = block.input.command ?? "";
    for (const pattern of DENY_LIST) {
      if (command.includes(pattern)) {
        console.log(`\n\x1b[31m[blocked] '${pattern}'\x1b[0m`);
        return "Permission denied by deny list";
      }
    }
    if (DESTRUCTIVE.some((keyword) => command.includes(keyword))) {
      return requestPermission(block, "Potentially destructive command");
    }
  }

  if (["read_file", "write_file", "edit_file"].includes(block.name)) {
    const p = block.input.path ?? "";
    if (!isRelativeTo(path.resolve(path.join(WORKDIR, p)), WORKDIR)) {
      return requestPermission(block, "Access outside workspace");
    }
  }
  return null;
}

function logHook(block: any): null {
  const preview = String(JSON.stringify(Object.values(block.input).slice(0, 2))).slice(0, 60);
  console.log(`\x1b[90m[HOOK] ${block.name}(${preview})\x1b[0m`);
  return null;
}

function largeOutputHook(block: any, output: any): null {
  if (String(output).length > 100000) {
    console.log(
      `\x1b[33m[HOOK] Large output from ${block.name}: ${String(output).length} chars\x1b[0m`
    );
  }
  return null;
}

function contextInjectHook(query: string): null {
  console.log(`\x1b[90m[HOOK] UserPromptSubmit: working in ${WORKDIR}\x1b[0m`);
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
  console.log(`\x1b[90m[HOOK] Stop: session used ${toolCount} tool calls\x1b[0m`);
  return null;
}

registerHook("UserPromptSubmit", contextInjectHook);
registerHook("PreToolUse", permissionHook);
registerHook("PreToolUse", logHook);
registerHook("PostToolUse", largeOutputHook);
registerHook("Stop", summaryHook);

// -- New in s12: cron jobs --

// @dataclass CronJob
interface CronJob {
  id: string;
  cron: string;
  prompt: string;
  recurring: boolean;
  durable: boolean;
  pending_delivery: boolean;
  last_fired: string | null;
}

function makeCronJob(
  fields: Partial<CronJob> & { id: string; cron: string; prompt: string; recurring: boolean; durable: boolean }
): CronJob {
  return {
    pending_delivery: false,
    last_fired: null,
    ...fields,
  };
}

const scheduledJobs: Record<string, CronJob> = {};
const cronQueue: CronJob[] = [];
// Node 单线程无需真实锁；cron_lock 仅为对照保留概念。

function _cronFieldMatches(field: string, value: number): boolean {
  if (field === "*") {
    return true;
  }
  if (field.startsWith("*/")) {
    return value % parseInt(field.slice(2), 10) === 0;
  }
  if (field.includes(",")) {
    return field.split(",").some((part) => _cronFieldMatches(part.trim(), value));
  }
  if (field.includes("-")) {
    const [start, end] = splitOnce(field, "-");
    return parseInt(start, 10) <= value && value <= parseInt(end, 10);
  }
  return value === parseInt(field, 10);
}

// 模拟 Python str.split(sep, 1)：最多切一次
function splitOnce(text: string, sep: string): [string, string] {
  const idx = text.indexOf(sep);
  if (idx === -1) {
    return [text, ""];
  }
  return [text.slice(0, idx), text.slice(idx + sep.length)];
}

function cronMatches(cronExpr: string, moment: Date): boolean {
  const fields = cronExpr.trim().split(/\s+/);
  if (fields.length !== 5) {
    return false;
  }

  const [minute, hour, day, month, weekday] = fields;
  // Python: moment.weekday() 周一=0；cron_weekday = (weekday()+1)%7 使周日=0
  const pyWeekday = (moment.getDay() + 6) % 7; // JS getDay 周日=0 -> Python 周一=0
  const cronWeekday = (pyWeekday + 1) % 7;
  if (
    !(
      _cronFieldMatches(minute, moment.getMinutes()) &&
      _cronFieldMatches(hour, moment.getHours()) &&
      _cronFieldMatches(month, moment.getMonth() + 1)
    )
  ) {
    return false;
  }

  const dayMatches = _cronFieldMatches(day, moment.getDate());
  const weekdayMatches = _cronFieldMatches(weekday, cronWeekday);
  if (day === "*" && weekday === "*") {
    return true;
  }
  if (day === "*") {
    return weekdayMatches;
  }
  if (weekday === "*") {
    return dayMatches;
  }
  return dayMatches || weekdayMatches;
}

function isDigit(s: string): boolean {
  return s.length > 0 && /^[0-9]+$/.test(s);
}

function _validateCronField(field: string, minimum: number, maximum: number): string | null {
  if (field === "*") {
    return null;
  }
  if (field.startsWith("*/")) {
    const step = field.slice(2);
    if (!isDigit(step) || parseInt(step, 10) <= 0) {
      return `Invalid step: ${field}`;
    }
    return null;
  }
  if (field.includes(",")) {
    for (const part of field.split(",")) {
      const error = _validateCronField(part.trim(), minimum, maximum);
      if (error) {
        return error;
      }
    }
    return null;
  }
  if (field.includes("-")) {
    const [start, end] = splitOnce(field, "-");
    if (!isDigit(start) || !isDigit(end)) {
      return `Invalid range: ${field}`;
    }
    const startValue = parseInt(start, 10);
    const endValue = parseInt(end, 10);
    if (startValue > endValue) {
      return `Range start is greater than end: ${field}`;
    }
    if (startValue < minimum || endValue > maximum) {
      return `Range ${field} is outside [${minimum}-${maximum}]`;
    }
    return null;
  }
  if (!isDigit(field)) {
    return `Invalid field: ${field}`;
  }
  const value = parseInt(field, 10);
  if (value < minimum || value > maximum) {
    return `Value ${value} is outside [${minimum}-${maximum}]`;
  }
  return null;
}

function validateCron(cronExpr: string): string | null {
  const fields = cronExpr.trim().split(/\s+/);
  if (fields.length !== 5) {
    return `Expected 5 fields, got ${fields.length}`;
  }

  const fieldRules: [string, number, number][] = [
    ["minute", 0, 59],
    ["hour", 0, 23],
    ["day-of-month", 1, 31],
    ["month", 1, 12],
    ["day-of-week", 0, 6],
  ];
  for (let i = 0; i < fields.length; i++) {
    const [name, minimum, maximum] = fieldRules[i];
    const error = _validateCronField(fields[i], minimum, maximum);
    if (error) {
      return `${name}: ${error}`;
    }
  }
  return null;
}

function saveDurableJobs(): void {
  const payload = Object.values(scheduledJobs).filter((job) => job.durable);
  const temporary = `${DURABLE_PATH}.${process.pid}.0.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(payload, null, 2));
    fs.renameSync(temporary, DURABLE_PATH); // 对应 os.replace（原子替换）
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch (e) {
      // missing_ok=True
    }
  }
}

function loadDurableJobs(): void {
  if (!fs.existsSync(DURABLE_PATH)) {
    return;
  }
  let payload: any;
  try {
    payload = JSON.parse(fs.readFileSync(DURABLE_PATH, "utf-8"));
    if (!Array.isArray(payload)) {
      throw new Error("expected a JSON list");
    }
  } catch (error) {
    console.log(`  [cron] could not load ${path.basename(DURABLE_PATH)}: ${error}`);
    return;
  }

  let loaded = 0;
  for (const item of payload) {
    let job: CronJob;
    try {
      job = makeCronJob(item);
      const error = validateCron(job.cron);
      if (error) {
        throw new Error(error);
      }
      if (!job.id.startsWith("cron_")) {
        throw new Error("invalid job ID");
      }
      if (!job.prompt.trim()) {
        throw new Error("prompt cannot be empty");
      }
    } catch (error) {
      console.log(`  [cron] skipped invalid saved job: ${error}`);
      continue;
    }
    scheduledJobs[job.id] = job;
    if (job.pending_delivery) {
      cronQueue.push(job);
    }
    loaded += 1;
  }
  if (loaded) {
    console.log(`  [cron] loaded ${loaded} durable job(s)`);
  }
}

function newCronId(): string {
  for (let i = 0; i < 100; i++) {
    const jobId = `cron_${crypto.randomBytes(4).toString("hex")}`;
    if (!(jobId in scheduledJobs)) {
      return jobId;
    }
  }
  throw new Error("Could not allocate a cron job ID");
}

function scheduleJob(cron: string, prompt: string, recurring = true, durable = true): CronJob | string {
  const error = validateCron(cron);
  if (error) {
    return error;
  }
  if (!prompt.trim()) {
    return "Prompt cannot be empty";
  }

  const job = makeCronJob({
    id: newCronId(),
    cron,
    prompt,
    recurring,
    durable,
  });
  scheduledJobs[job.id] = job;
  try {
    if (durable) {
      saveDurableJobs();
    }
  } catch (e) {
    delete scheduledJobs[job.id];
    throw e;
  }
  console.log(`  [cron] scheduled ${job.id}: ${cron} -> ${prompt.slice(0, 60)}`);
  return job;
}

function cancelJob(jobId: string): string {
  const job = scheduledJobs[jobId];
  if (job === undefined) {
    return `Job ${jobId} not found`;
  }

  const previousQueue = [...cronQueue];
  delete scheduledJobs[jobId];
  const filtered = cronQueue.filter((queued) => queued.id !== jobId);
  cronQueue.length = 0;
  cronQueue.push(...filtered);
  try {
    if (job.durable) {
      saveDurableJobs();
    }
  } catch (e) {
    scheduledJobs[jobId] = job;
    cronQueue.length = 0;
    cronQueue.push(...previousQueue);
    throw e;
  }
  console.log(`  [cron] cancelled ${jobId}`);
  return `Cancelled ${jobId}`;
}

function _enqueueDueJob(job: CronJob, minuteMarker: string | null = null): void {
  const oldPending = job.pending_delivery;
  const oldLastFired = job.last_fired;
  job.pending_delivery = true;
  if (minuteMarker !== null) {
    job.last_fired = minuteMarker;
  }
  try {
    if (job.durable) {
      saveDurableJobs();
    }
  } catch (e) {
    job.pending_delivery = oldPending;
    job.last_fired = oldLastFired;
    throw e;
  }
  cronQueue.push(job);
}

// 格式化为 "%Y-%m-%d %H:%M"
function formatMinuteMarker(moment: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${moment.getFullYear()}-${pad(moment.getMonth() + 1)}-${pad(moment.getDate())} ` +
    `${pad(moment.getHours())}:${pad(moment.getMinutes())}`
  );
}

function pollDueJobs(moment: Date): void {
  const minuteMarker = formatMinuteMarker(moment);
  for (const job of Object.values(scheduledJobs)) {
    try {
      if (job.pending_delivery || job.last_fired === minuteMarker) {
        continue;
      }
      if (cronMatches(job.cron, moment)) {
        _enqueueDueJob(job, minuteMarker);
        console.log(`  [cron] due ${job.id}: ${job.prompt.slice(0, 60)}`);
      }
    } catch (error) {
      console.log(`  [cron] could not enqueue ${job.id}: ${error}`);
    }
  }
}

function consumeCronQueue(): CronJob[] {
  const jobs = [...cronQueue];
  cronQueue.length = 0;
  return jobs;
}

function acknowledgeCronJobs(jobs: CronJob[]): void {
  const changed: [CronJob, boolean][] = [];
  const removed: CronJob[] = [];
  for (const delivered of jobs) {
    const current = scheduledJobs[delivered.id];
    if (current === undefined) {
      continue;
    }
    changed.push([current, current.pending_delivery]);
    if (current.recurring) {
      current.pending_delivery = false;
    } else {
      removed.push(current);
      delete scheduledJobs[current.id];
    }
  }

  try {
    if (changed.some(([job]) => job.durable)) {
      saveDurableJobs();
    }
  } catch (e) {
    for (const job of removed) {
      scheduledJobs[job.id] = job;
    }
    for (const [job, pending] of changed) {
      job.pending_delivery = pending;
    }
    const queuedIds = new Set(cronQueue.map((job) => job.id));
    for (const [job] of changed) {
      if (!queuedIds.has(job.id)) {
        cronQueue.push(job);
      }
    }
    throw e;
  }
}

function restoreCronJobs(jobs: CronJob[]): void {
  const queuedIds = new Set(cronQueue.map((job) => job.id));
  for (const delivered of jobs) {
    const current = scheduledJobs[delivered.id];
    if (current === undefined) {
      continue;
    }
    current.pending_delivery = true;
    if (!queuedIds.has(current.id)) {
      cronQueue.push(current);
      queuedIds.add(current.id);
    }
  }
}

function hasCronQueue(): boolean {
  return cronQueue.length > 0;
}

function runScheduleCron(cron: string, prompt: string, recurring = true, durable = true): string {
  const result = scheduleJob(cron, prompt, recurring, durable);
  if (typeof result === "string") {
    return `Error: ${result}`;
  }
  return `Scheduled ${result.id}: ${cron} -> ${prompt}`;
}

function runListCrons(): string {
  const jobs = Object.values(scheduledJobs);
  if (!jobs.length) {
    return "No cron jobs.";
  }

  const lines: string[] = [];
  for (const job of jobs) {
    const frequency = job.recurring ? "recurring" : "one-shot";
    const storage = job.durable ? "durable" : "session";
    lines.push(`${job.id}: ${job.cron} -> ${job.prompt.slice(0, 60)} [${frequency}, ${storage}]`);
  }
  return lines.join("\n");
}

function runCancelCron(jobId: string): string {
  return cancelJob(jobId);
}

TOOLS.push(
  {
    name: "schedule_cron",
    description: "Schedule a prompt with a 5-field cron expression.",
    input_schema: {
      type: "object",
      properties: {
        cron: { type: "string" },
        prompt: { type: "string" },
        recurring: { type: "boolean" },
        durable: { type: "boolean" },
      },
      required: ["cron", "prompt"],
    },
  },
  {
    name: "list_crons",
    description: "List scheduled cron jobs.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "cancel_cron",
    description: "Cancel a cron job by ID.",
    input_schema: { type: "object", properties: { job_id: { type: "string" } }, required: ["job_id"] },
  }
);

Object.assign(TOOL_HANDLERS, {
  schedule_cron: (input: any) =>
    runScheduleCron(input.cron, input.prompt, input.recurring ?? true, input.durable ?? true),
  list_crons: () => runListCrons(),
  cancel_cron: (input: any) => runCancelCron(input.job_id),
});

function executeTool(block: any): string {
  const blocked = triggerHooks("PreToolUse", block);
  if (blocked !== null && blocked !== undefined) {
    return String(blocked);
  }

  const handler = TOOL_HANDLERS[block.name];
  let output: string;
  try {
    output = handler ? handler(block.input) : `Unknown: ${block.name}`;
  } catch (error) {
    output = `Error: ${error}`;
  }
  triggerHooks("PostToolUse", block, output);
  return String(output);
}

// -- Scheduler and agent loop --

// Node 无线程 Event，用简单的布尔标志与定时器模拟运行时。
let runtimeStop = false;
const runtimeTimers: NodeJS.Timeout[] = [];
let runtimeStarted = false;
// agent_lock / runtime_lock：Node 单线程无需真实锁，用布尔标志表示占用。
let agentBusy = false;
const sessionHistory: any[] = [];

function cronSchedulerLoop(): void {
  // 对应 Python 每 1 秒轮询一次到期任务
  const timer = setInterval(() => {
    if (runtimeStop) {
      clearInterval(timer);
      return;
    }
    pollDueJobs(new Date());
  }, 1000);
  runtimeTimers.push(timer);
}

async function agentLoop(messages: any[], context: Record<string, any> | null = null): Promise<Record<string, any> | null> {
  const fired = consumeCronQueue();
  const scheduledStart = messages.length;
  for (const job of fired) {
    messages.push({ role: "user", content: `[Scheduled] ${job.prompt}` });
    console.log(`  [cron] delivered ${job.id}: ${job.prompt.slice(0, 60)}`);
  }

  let waitingForAck: CronJob[] = [...fired];
  while (true) {
    let response: any;
    try {
      response = await client.messages.create({
        model: MODEL,
        system: SYSTEM,
        messages,
        tools: TOOLS as any,
        max_tokens: 8000,
      });
    } catch (error: any) {
      if (waitingForAck.length) {
        messages.splice(scheduledStart);
        restoreCronJobs(waitingForAck);
      }
      console.log(`  [error] ${error?.constructor?.name || "Error"}: ${error}`);
      return context;
    }

    messages.push({ role: "assistant", content: response.content });
    if (waitingForAck.length) {
      try {
        acknowledgeCronJobs(waitingForAck);
      } catch (error) {
        console.log(`  [cron] acknowledgement failed: ${error}`);
      }
      waitingForAck = [];
    }

    if (response.stop_reason !== "tool_use") {
      const force = triggerHooks("Stop", messages);
      if (force) {
        messages.push({ role: "user", content: force });
        continue;
      }
      return context;
    }

    const results: any[] = [];
    for (const block of response.content) {
      if ((block as any).type !== "tool_use") {
        continue;
      }
      const output = executeTool(block);
      results.push({
        type: "tool_result",
        tool_use_id: (block as any).id,
        content: output,
      });
    }
    messages.push({ role: "user", content: results });
  }
}

function printLatestAssistantText(messages: any[]): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "assistant") {
      continue;
    }
    const content = message.content ?? "";
    if (typeof content === "string") {
      console.log(content);
    } else {
      for (const block of content) {
        if ((block as any)?.type === "text" && !(block instanceof Object && block.constructor === Object)) {
          console.log((block as any).text);
        } else if (typeof block === "object" && block !== null && block.type === "text") {
          console.log(block.text ?? "");
        }
      }
    }
    return;
  }
}

async function runAgentTurnLocked(userQuery: string | null = null): Promise<void> {
  if (userQuery !== null) {
    triggerHooks("UserPromptSubmit", userQuery);
    sessionHistory.push({ role: "user", content: userQuery });
  }
  await agentLoop(sessionHistory);
  printLatestAssistantText(sessionHistory);
  console.log();
}

function queueProcessorLoop(): void {
  // 对应 Python 每 0.2 秒检查一次待处理的 cron 队列
  const timer = setInterval(async () => {
    if (runtimeStop) {
      clearInterval(timer);
      return;
    }
    if (!hasCronQueue() || agentBusy) {
      return;
    }
    agentBusy = true;
    try {
      if (hasCronQueue()) {
        // 计划任务轮次：不能交互式请求授权
        inScheduledTurn = true;
        try {
          await runAgentTurnLocked();
        } finally {
          inScheduledTurn = false;
        }
      }
    } finally {
      agentBusy = false;
    }
  }, 200);
  runtimeTimers.push(timer);
}

function startRuntimeThreads(): void {
  if (runtimeStarted) {
    return;
  }
  loadDurableJobs();
  runtimeStop = false;
  cronSchedulerLoop();
  queueProcessorLoop();
  runtimeStarted = true;
}

function stopRuntimeThreads(): void {
  if (!runtimeStarted) {
    return;
  }
  runtimeStop = true;
  for (const timer of runtimeTimers) {
    clearInterval(timer);
  }
  runtimeTimers.length = 0;
  runtimeStarted = false;
}

async function main(): Promise<void> {
  console.log("s12: Cron Scheduler - run prompts on a local schedule");
  console.log("Enter a question, press Enter to send. Type q to quit.\n");
  startRuntimeThreads();
  try {
    while (true) {
      let query: string;
      try {
        query = promptInput("\x1b[36ms12 >> \x1b[0m");
      } catch (e) {
        break;
      }
      if (["q", "exit", ""].includes(query.trim().toLowerCase())) {
        break;
      }
      // 对应 with agent_lock: 独占 agent 执行
      agentBusy = true;
      try {
        await runAgentTurnLocked(query);
      } finally {
        agentBusy = false;
      }
    }
  } finally {
    stopRuntimeThreads();
  }
}

if (require.main === module) {
  main();
}
