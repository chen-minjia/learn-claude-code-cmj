#!/usr/bin/env node
/*
 * s16: Workflow Runtime - run a saved orchestration through one tool call.
 *
 * Run:
 *   node s16_workflow_runtime/code.ts
 *   node s16_workflow_runtime/code.ts demo
 *   node s16_workflow_runtime/code.ts resume
 *
 *     +-------------+       +--------------------------------+
 *     | Agent loop  | ----> | Workflow(name, args, run_id)  |
 *     +-------------+       +---------------+----------------+
 *                                           |
 *                            +--------------+--------------+
 *                            | agent | parallel | pipeline  |
 *                            +--------------+--------------+
 *                                           |
 *                                    journal + result
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

// -- Runtime Guards --
const AGENT_CAP = 1000; // hard cap on agent() calls per run
const CONCURRENCY = 8; // parallelism cap (semaphore)
const STORE = path.join(__dirname, ".runtime"); // snapshots + journals live here
const MISS = Symbol("MISS"); // journal cache miss sentinel
const WORKFLOW_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RUN_ID_RE = /^wf_[A-Za-z0-9][A-Za-z0-9._-]{0,63}_[0-9a-f]{16}$/;

function _stableHash(s: string): bigint {
  // Process-stable hash (Python's hash() is salted per process, which would
  // break resume keys across `run` and `resume`).
  const digest = crypto.createHash("sha256").update(s).digest("hex");
  return BigInt("0x" + digest);
}

function createRunId(meta: Record<string, any>): string {
  return `wf_${meta["name"]}_${crypto.randomBytes(8).toString("hex")}`;
}

function reserveRunId(meta: Record<string, any>): string {
  // Reserve a fresh run identity before any journal can be truncated.
  fs.mkdirSync(STORE, { recursive: true });
  for (let i = 0; i < 32; i++) {
    const runId = validateRunId(createRunId(meta));
    const snapshotPath = path.join(STORE, `${runId}.json`);
    try {
      const fd = fs.openSync(snapshotPath, "wx", 0o600);
      fs.closeSync(fd);
      return runId;
    } catch (e: any) {
      if (e && e.code === "EEXIST") {
        continue;
      }
      throw e;
    }
  }
  throw new WorkflowInputError("could not allocate a unique workflow runId");
}

function createTaskId(runId: string): string {
  return `local_workflow_${runId}`;
}

function validateRunId(runId: any): string {
  if (typeof runId !== "string" || !RUN_ID_RE.test(runId)) {
    throw new WorkflowInputError("invalid workflow runId");
  }
  return runId;
}

// -- Errors --
class WorkflowInputError extends Error {
  // Bad workflow, metadata, or schema input.
  constructor(message: string) {
    super(message);
    this.name = "WorkflowInputError";
  }
}

// In Node the runtime is single-process/single-threaded for our purposes, so the
// cross-thread + cross-process file lock is modelled with an in-memory set plus a
// lock file created exclusively.
const _runLocks = new Set<string>();

async function withWorkflowRunLock<T>(
  runId: string,
  fn: () => Promise<T>,
): Promise<T> {
  // Hold one run across threads and host processes for its full lifecycle.
  if (_runLocks.has(runId)) {
    throw new WorkflowInputError(`workflow run ${runId} is already active`);
  }
  _runLocks.add(runId);

  let lockPath: string | null = null;
  let fd: number | null = null;
  try {
    fs.mkdirSync(STORE, { recursive: true });
    lockPath = path.join(STORE, `${runId}.lock`);
    try {
      // O_CREAT | O_EXCL emulates an exclusive advisory lock.
      fd = fs.openSync(lockPath, "wx");
    } catch (exc: any) {
      if (exc && exc.code === "EEXIST") {
        throw new WorkflowInputError(
          `workflow run ${runId} is already active`,
        );
      }
      throw exc;
    }
    return await fn();
  } finally {
    if (fd !== null) {
      fs.closeSync(fd);
    }
    if (lockPath !== null) {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        /* ignore */
      }
    }
    _runLocks.delete(runId);
  }
}

// -- Metadata Validation --
function validateMeta(meta: any): Record<string, any> {
  // Validate name, description, and optional phases before launch.
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
    throw new WorkflowInputError("meta must be an object literal");
  }
  if (!meta["name"] || !meta["description"]) {
    throw new WorkflowInputError("meta requires `name` and `description`");
  }
  if (typeof meta["name"] !== "string" || !WORKFLOW_NAME_RE.test(meta["name"])) {
    throw new WorkflowInputError(
      "meta.name must be a 1-64 character slug using letters, numbers, '.', '_', or '-'",
    );
  }
  if (typeof meta["description"] !== "string") {
    throw new WorkflowInputError("meta.description must be a string");
  }
  if ("phases" in meta) {
    if (
      !Array.isArray(meta["phases"]) ||
      !meta["phases"].every(
        (phase: any) => typeof phase === "string" && phase,
      )
    ) {
      throw new WorkflowInputError(
        "meta.phases must be a list of non-empty strings",
      );
    }
  }
  return meta;
}

function checkPermission(
  meta: Record<string, any>,
  settings: Record<string, any> | null = null,
): string {
  // Apply the s03 allow/deny gate before launching a workflow.
  settings = settings || {};
  if ((settings["deny"] || []).includes(meta["name"])) {
    throw new WorkflowInputError(
      `workflow '${meta["name"]}' denied by settings`,
    );
  }
  return "allow";
}

// -- Minimal JSON Schema --
class SimpleJsonSchema {
  // Tiny validator backing agent({schema}):
  // object/array/string/boolean/number + required keys.
  schema: Record<string, any>;

  constructor(schema: Record<string, any>) {
    this.schema = schema;
  }

  validate(
    value: any,
    schema: Record<string, any> | null = null,
  ): [boolean, string | null] {
    schema = schema === null ? this.schema : schema;
    if ("enum" in schema && !schema["enum"].includes(value)) {
      return [false, `expected one of ${JSON.stringify(schema["enum"])}`];
    }
    const t = schema["type"];
    if (t === "object") {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return [false, "expected object"];
      }
      for (const key of schema["required"] || []) {
        if (!(key in value)) {
          return [false, `missing required key '${key}'`];
        }
      }
      for (const [key, sub] of Object.entries(schema["properties"] || {})) {
        if (key in value) {
          const [ok, err] = this.validate(value[key], sub as Record<string, any>);
          if (!ok) {
            return [false, `${key}: ${err}`];
          }
        }
      }
      return [true, null];
    }
    if (t === "array") {
      if (!Array.isArray(value)) {
        return [false, "expected array"];
      }
      const items = schema["items"];
      if (items) {
        for (let i = 0; i < value.length; i++) {
          const [ok, err] = this.validate(value[i], items);
          if (!ok) {
            return [false, `[${i}]: ${err}`];
          }
        }
      }
      return [true, null];
    }
    if (t === "string") {
      return [
        typeof value === "string",
        typeof value === "string" ? null : "expected string",
      ];
    }
    if (t === "boolean") {
      return [
        typeof value === "boolean",
        typeof value === "boolean" ? null : "expected boolean",
      ];
    }
    if (t === "number" || t === "integer") {
      const ok = typeof value === "number" && !Number.isNaN(value);
      return [ok, ok ? null : "expected number"];
    }
    return [true, null];
  }
}

function _fillSchema(schema: Record<string, any>, seed: string): any {
  // Deterministic generic filler used for schemas the mock doesn't special-case.
  const t = schema["type"];
  if (t === "object") {
    const keys = schema["required"] || Object.keys(schema["properties"] || {});
    const result: Record<string, any> = {};
    for (const k of keys) {
      result[k] = _fillSchema(schema["properties"][k], `${seed}/${k}`);
    }
    return result;
  }
  if (t === "array") {
    return [_fillSchema(schema["items"], `${seed}/0`)];
  }
  if (t === "boolean") {
    return _stableHash(seed) % 4n !== 0n;
  }
  if (t === "number" || t === "integer") {
    return Number(_stableHash(seed) % 5n);
  }
  const parts = seed.split("/");
  return parts[parts.length - 1];
}

// -- Agent Runners --

interface RunnerOutput {
  value: any;
  tokens: number;
}

class MockAgentRunner {
  // Deterministic runner used by demo mode and unit tests.
  run(
    prompt: string,
    schema: Record<string, any> | null = null,
    label: string | null = null,
  ): RunnerOutput {
    if (schema === null) {
      const value = `[mock] ${(label || prompt).slice(0, 60)}`;
      return { value, tokens: MockAgentRunner._tokens(prompt, value) };
    }
    const props = schema["properties"] || {};
    let value: any;
    if ("findings" in props) {
      const n = 1 + Number(_stableHash(prompt) % 2n);
      const sev = ["high", "medium", "low"];
      const findings = [];
      for (let i = 0; i < n; i++) {
        findings.push({
          title: `${label || "audit"} #${i + 1}`,
          severity: sev[Number(_stableHash(prompt + String(i)) % 3n)],
        });
      }
      value = { findings };
    } else if ("isReal" in props) {
      const real = _stableHash(prompt) % 4n !== 0n;
      value = {
        isReal: real,
        reason: real ? "reproduced" : "could not reproduce",
      };
    } else {
      value = _fillSchema(schema, prompt);
    }
    return { value, tokens: MockAgentRunner._tokens(prompt, value) };
  }

  static _tokens(prompt: string, result: any): number {
    return (
      Math.floor(prompt.length / 4) +
      Math.floor(JSON.stringify(result).length / 4)
    );
  }
}

function _responseText(response: any): string {
  return (response?.content || [])
    .filter((block: any) => block?.type === "text")
    .map((block: any) => String(block?.text ?? ""))
    .join("\n")
    .trim();
}

function _parseRunnerJson(text: string): any {
  let stripped = text.trim();
  if (stripped.startsWith("```")) {
    let lines = stripped.split("\n");
    lines = lines.length ? lines.slice(1) : lines;
    if (lines.length && lines[lines.length - 1].trim() === "```") {
      lines = lines.slice(0, -1);
    }
    stripped = lines.join("\n").trim();
  }
  try {
    return JSON.parse(stripped);
  } catch {
    // Scan for the first parseable JSON object, mirroring raw_decode.
    for (let position = 0; position < stripped.length; position++) {
      if (stripped[position] !== "{") {
        continue;
      }
      const candidate = stripped.slice(position);
      // Try progressively shorter prefixes until one parses.
      for (let end = candidate.length; end > 0; end--) {
        try {
          return JSON.parse(candidate.slice(0, end));
        } catch {
          /* keep shrinking */
        }
      }
    }
    throw new WorkflowInputError("workflow agent returned invalid JSON");
  }
}

class AnthropicAgentRunner {
  // Run workflow agents through the same API client as the host.
  client: any;
  model: string;

  constructor(client: any, model: string) {
    this.client = client;
    this.model = model;
  }

  run(
    prompt: string,
    schema: Record<string, any> | null = null,
    label: string | null = null,
  ): RunnerOutput {
    let request = prompt;
    if (schema !== null) {
      request +=
        "\n\nReturn only one JSON object matching this schema:\n" +
        JSON.stringify(schema, Object.keys(schema).sort());
    }
    const response = this.client.messages.create({
      model: this.model,
      system:
        "You are a focused workflow agent. Complete only the supplied " +
        "step. Do not claim access to files or results not included in " +
        "the prompt.",
      messages: [{ role: "user", content: request }],
      max_tokens: 2000,
    });
    const text = _responseText(response);
    let value: any;
    if (schema === null) {
      value = text;
    } else {
      try {
        value = _parseRunnerJson(text);
      } catch (e) {
        if (e instanceof WorkflowInputError) {
          // Let ExecutionState's schema check trigger its single retry.
          value = text;
        } else {
          throw e;
        }
      }
    }
    const usage = response?.usage ?? null;
    const tokens =
      Number(usage?.input_tokens || 0) + Number(usage?.output_tokens || 0);
    return { value, tokens };
  }
}

let RUNNER_FACTORY: () => MockAgentRunner | AnthropicAgentRunner = () =>
  new MockAgentRunner();

// -- Journal --
class WorkflowJournal {
  // Append-only <runId>.journal.jsonl. On resume, agent() calls whose
  // semantic key is already present are replayed from cache instead of re-run.
  path: string;
  resume: boolean;
  cache: Record<string, any>;
  private _fd: number;

  constructor(runId: string, resume: boolean, store: string | null = null) {
    store = store === null ? STORE : store;
    fs.mkdirSync(store, { recursive: true });
    this.path = path.join(store, `${runId}.journal.jsonl`);
    this.resume = resume;
    this.cache = {};
    if (resume) {
      if (!fs.existsSync(this.path)) {
        throw new WorkflowInputError(`resume journal not found for ${runId}`);
      }
      const lines = fs.readFileSync(this.path, "utf-8").split("\n");
      let lineNumber = 0;
      for (const line of lines) {
        lineNumber += 1;
        if (line === "" && lineNumber === lines.length) {
          // trailing newline yields a final empty element in Node
          break;
        }
        let rec: any;
        try {
          rec = JSON.parse(line);
          if (
            typeof rec !== "object" ||
            rec === null ||
            typeof rec["key"] !== "string" ||
            !("value" in rec)
          ) {
            throw new Error("expected key/value record");
          }
        } catch (exc) {
          throw new WorkflowInputError(
            `invalid resume journal record at line ${lineNumber}`,
          );
        }
        this.cache[rec["key"]] = rec["value"];
      }
      this._fd = fs.openSync(this.path, "a");
    } else {
      this._fd = fs.openSync(this.path, "w"); // fresh run truncates
    }
  }

  key(kind: string, label: any, prompt: any, schema: any): string {
    // Deterministic semantic key, independent of concurrency order, so a
    // parallel/pipeline call gets the same key on resume.
    const basis = `${kind}|${label}|${prompt}|${JSON.stringify(schema)}`;
    const num = _stableHash(basis) % 10n ** 10n;
    return `${kind}-${num.toString().padStart(10, "0")}`;
  }

  cached(key: string): any {
    return key in this.cache ? this.cache[key] : MISS;
  }

  record(key: string, value: any): void {
    fs.writeSync(this._fd, JSON.stringify({ key, value }) + "\n");
    this.cache[key] = value;
  }

  close(): void {
    fs.closeSync(this._fd);
  }
}

// -- Token Budget --
class Budget {
  // budget.total / spent() / remaining(). Once spent reaches total, agent()
  // calls raise instead of silently overspending.
  total: number | null;
  private _spent: number;

  constructor(total: number | null = null) {
    this.total = total;
    this._spent = 0;
  }

  add(n: number): void {
    if (this.total !== null && this._spent + n > this.total) {
      throw new WorkflowInputError(
        `token budget exceeded (${this._spent + n} > ${this.total})`,
      );
    }
    this._spent += n;
  }

  spent(): number {
    return this._spent;
  }

  remaining(): number {
    return this.total === null
      ? Infinity
      : Math.max(0, this.total - this._spent);
  }
}

// -- Workflow Task Lifecycle --
class LocalWorkflowTask {
  // Hold workflow status, usage, and progress events.
  taskId: string;
  runId: string;
  meta: Record<string, any>;
  status: string;
  usage: { agents: number; tokens: number };
  progress: Array<Record<string, any>>;

  constructor(taskId: string, runId: string, meta: Record<string, any>) {
    this.taskId = taskId;
    this.runId = runId;
    this.meta = meta;
    this.status = "running";
    this.usage = { agents: 0, tokens: 0 };
    this.progress = [];
  }

  event(name: string, data: Record<string, any>): void {
    const line = Object.entries(data)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    console.log(`  event      ${name.padEnd(18)} ${line}`);
  }

  progressEvent(ptype: string, data: Record<string, any>): void {
    this.progress.push({ type: ptype, ...data });
    const line = Object.entries(data)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    console.log(`  progress   ${ptype.padEnd(16)} ${line}`);
  }
}

// -- Workflow Primitives --

// A tiny async semaphore modelling asyncio.Semaphore(CONCURRENCY).
class Semaphore {
  private permits: number;
  private waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter();
    } else {
      this.permits += 1;
    }
  }
}

class ExecutionLimits {
  // Shared run-wide limits, including nested workflows.
  agents: number;
  semaphore: Semaphore;

  constructor() {
    this.agents = 0;
    this.semaphore = new Semaphore(CONCURRENCY);
  }

  claimAgent(): void {
    this.agents += 1;
    if (this.agents > AGENT_CAP) {
      throw new WorkflowInputError(`agent() cap reached (${AGENT_CAP})`);
    }
  }
}

class ExecutionState {
  // Injected into the workflow script with the orchestration primitives.
  task: LocalWorkflowTask;
  journal: WorkflowJournal;
  runner: MockAgentRunner | AnthropicAgentRunner;
  budget: Budget;
  args: Record<string, any>;
  private _depth: number;
  private _phase: string | null;
  private _phasesSeen: Set<string>;
  private _limits: ExecutionLimits;

  constructor(
    task: LocalWorkflowTask,
    journal: WorkflowJournal,
    runner: MockAgentRunner | AnthropicAgentRunner,
    budget: Budget,
    args: Record<string, any>,
    depth = 0,
    limits: ExecutionLimits | null = null,
  ) {
    this.task = task;
    this.journal = journal;
    this.runner = runner;
    this.budget = budget;
    this.args = args;
    this._depth = depth;
    this._phase = null;
    this._phasesSeen = new Set();
    this._limits = limits || new ExecutionLimits();
  }

  phase(title: string): void {
    // Start a phase; subsequent agent()s group under it. Upsert: emitting the
    // same phase again (e.g. from each pipeline item) does not re-announce it.
    this._phase = title;
    if (!this._phasesSeen.has(title)) {
      this._phasesSeen.add(title);
      this.task.progressEvent("workflow_phase", { title });
    }
  }

  log(message: string): void {
    // Emit a workflow_log progress line.
    this.task.progressEvent("workflow_log", { message });
  }

  async agent(
    prompt: string,
    schema: Record<string, any> | null = null,
    label: string | null = null,
    phase: string | null = null,
  ): Promise<any> {
    // Spawn one subagent. With a schema, force StructuredOutput + validate
    // (retry once). On resume, a cached key short-circuits the run.
    label = label || prompt.slice(0, 24) + "...";
    this._limits.claimAgent();
    if (this.budget.remaining() <= 0) {
      throw new WorkflowInputError("token budget exceeded");
    }

    const key = this.journal.key("agent", label, prompt, schema);
    const cached = this.journal.cached(key);
    if (cached !== MISS) {
      if (schema !== null) {
        const [ok, err] = new SimpleJsonSchema(schema).validate(cached);
        if (!ok) {
          throw new WorkflowInputError(
            `cached agent output failed schema validation: ${err}`,
          );
        }
      }
      this.task.progressEvent("workflow_agent", {
        label,
        phase: phase || this._phase,
        status: "cached",
      });
      return cached;
    }

    await this._limits.semaphore.acquire();
    let result: any;
    let tokens: number;
    try {
      const run = this.runner.run(prompt, schema, label);
      result = run.value;
      tokens = run.tokens;
    } finally {
      this._limits.semaphore.release();
    }

    if (schema !== null) {
      let [ok, err] = new SimpleJsonSchema(schema).validate(result);
      if (!ok) {
        const retry = this.runner.run(
          prompt + "\n\nReturn valid JSON.",
          schema,
          label,
        );
        result = retry.value;
        tokens += retry.tokens;
        [ok, err] = new SimpleJsonSchema(schema).validate(result);
        if (!ok) {
          throw new WorkflowInputError(`agent({schema}) invalid output: ${err}`);
        }
      }
    }

    this.budget.add(tokens);
    this.task.usage.agents += 1;
    this.task.usage.tokens += tokens;
    this.journal.record(key, result);
    this.task.progressEvent("workflow_agent", {
      label,
      phase: phase || this._phase,
      status: "done",
    });
    return result;
  }

  async parallel(thunks: Array<() => Promise<any>>): Promise<any[]> {
    // BARRIER: run all thunks concurrently and fail if any thunk fails.
    return await Promise.all(thunks.map((thunk) => thunk()));
  }

  async pipeline(
    items: any[],
    ...stages: Array<(prev: any, item: any, idx: number) => Promise<any>>
  ): Promise<any[]> {
    // Per-item staged flow, NO barrier between stages: item A can be in
    // stage 3 while item B is still in stage 1. Each stage gets
    // (prev_result, original_item, index). A throwing stage fails the workflow.
    const runItem = async (item: any, idx: number): Promise<any> => {
      let value = item;
      for (const stage of stages) {
        value = await stage(value, item, idx);
      }
      return value;
    };
    return await Promise.all(items.map((it, i) => runItem(it, i)));
  }

  async workflow(name: string, args: Record<string, any> | null = null): Promise<any> {
    // Run a saved workflow inline as a child (one level), sharing this run's
    // journal + budget + agent counter.
    if (this._depth >= 1) {
      throw new WorkflowInputError("workflow() nesting is one level only");
    }
    if (!(name in WORKFLOWS)) {
      throw new WorkflowInputError(`unknown workflow '${name}'`);
    }
    const [, fn] = WORKFLOWS[name];
    const child = new ExecutionState(
      this.task,
      this.journal,
      this.runner,
      this.budget,
      args || {},
      this._depth + 1,
      this._limits,
    );
    return await fn(child, args || {});
  }
}

// -- Workflow Tool --
class WorkflowTool {
  // The Workflow tool. .call() validates meta, runs the permission check,
  // creates runId/taskId, registers a LocalWorkflowTask, and emits lifecycle
  // events while executing the script. It returns the result and task state and
  // supports resume.

  async call(
    meta: Record<string, any>,
    scriptFn: (ctx: ExecutionState, args: Record<string, any>) => Promise<any>,
    args: Record<string, any> | null = null,
    resumeFromRunId: string | null = null,
  ): Promise<{ launched: any; result: any; task: LocalWorkflowTask }> {
    validateMeta(meta);
    checkPermission(meta);
    const resuming = resumeFromRunId !== null;
    let runId: string;
    if (resuming) {
      runId = validateRunId(resumeFromRunId);
    } else {
      runId = reserveRunId(meta);
    }
    return await withWorkflowRunLock(runId, () =>
      this._callLocked(meta, scriptFn, args, runId, resuming),
    );
  }

  async _callLocked(
    meta: Record<string, any>,
    scriptFn: (ctx: ExecutionState, args: Record<string, any>) => Promise<any>,
    args: Record<string, any> | null,
    runId: string,
    resuming: boolean,
  ): Promise<{ launched: any; result: any; task: LocalWorkflowTask }> {
    let journal: WorkflowJournal;
    if (resuming) {
      const snapshot = _readSnapshot(runId);
      if (snapshot["workflowName"] !== meta["name"]) {
        throw new WorkflowInputError("resume runId does not match workflow meta");
      }
      const savedArgs = snapshot["args"] || {};
      if (args === null) {
        args = savedArgs;
      } else if (JSON.stringify(args) !== JSON.stringify(savedArgs)) {
        throw new WorkflowInputError("resume args do not match the original run");
      }
      journal = new WorkflowJournal(runId, true);
    } else {
      args = args || {};
      journal = new WorkflowJournal(runId, false);
    }
    const taskId = createTaskId(runId);

    const task = new LocalWorkflowTask(taskId, runId, meta);
    // Record the launch envelope before workflow execution starts.
    const launched = {
      status: "async_launched",
      taskId,
      taskType: "local_workflow",
      runId,
      workflowName: meta["name"],
    };
    task.event("async_launched", { runId, taskId });
    task.event("task_started", {
      workflow: meta["name"],
      phases: (meta["phases"] || []).join(",") || "-",
      resume: resuming,
    });
    _writeJson(path.join(STORE, `${runId}.json`), {
      runId,
      workflowName: meta["name"],
      args,
      task: serializeTask(task),
    });

    let result: any;
    try {
      const ctx = new ExecutionState(
        task,
        journal,
        RUNNER_FACTORY(),
        new Budget((args as Record<string, any>)["budget"]),
        args as Record<string, any>,
      );
      result = await scriptFn(ctx, args as Record<string, any>);
      task.status = "completed";
    } catch (e: any) {
      // failed / stopped close the loop too
      task.status = "failed";
      result = { error: String(e?.message ?? e) };
    } finally {
      journal.close();
    }

    _writeJson(path.join(STORE, `${runId}.output.json`), result);
    _writeJson(path.join(STORE, `${runId}.json`), {
      runId,
      workflowName: meta["name"],
      args,
      task: serializeTask(task),
    });
    _saveLastRun(runId);
    task.event("task_notification", {
      status: task.status,
      agents: task.usage.agents,
      tokens: task.usage.tokens,
      outputFile: `.runtime/${runId}.output.json`,
    });
    return { launched, result, task };
  }
}

function _writeJson(filePath: string, value: any): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = filePath + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
  fs.renameSync(temporary, filePath);
}

function _readSnapshot(runId: string): Record<string, any> {
  const filePath = path.join(STORE, `${runId}.json`);
  if (!fs.existsSync(filePath)) {
    throw new WorkflowInputError(`resume snapshot not found for ${runId}`);
  }
  let snapshot: any;
  try {
    snapshot = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    throw new WorkflowInputError(`invalid resume snapshot for ${runId}`);
  }
  if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) {
    throw new WorkflowInputError(`invalid resume snapshot for ${runId}`);
  }
  return snapshot;
}

function _saveLastRun(runId: string): void {
  fs.writeFileSync(path.join(STORE, "last_run.txt"), runId);
}

function _readLastRun(): string | null {
  const p = path.join(STORE, "last_run.txt");
  return fs.existsSync(p) ? fs.readFileSync(p, "utf-8").trim() : null;
}

// -- Sample Workflow --
const FINDINGS_SCHEMA = {
  type: "object",
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["title", "severity"],
        properties: {
          title: { type: "string" },
          severity: { type: "string", enum: ["high", "medium", "low"] },
        },
      },
    },
  },
};
const VERDICT_SCHEMA = {
  type: "object",
  required: ["isReal", "reason"],
  properties: {
    isReal: { type: "boolean" },
    reason: { type: "string" },
  },
};

const SAMPLE_META = {
  name: "review-changes",
  description: "Review changed files across dimensions, verify each finding",
  phases: ["Review", "Verify"],
};

const DIMENSIONS = ["correctness", "security", "performance", "style"];
const DEMO_CHANGES =
  "def load_user(user_id):\n" +
  '    query = f"SELECT * FROM users WHERE id = {user_id}"\n' +
  "    return db.execute(query).fetchone()\n";

async function sampleWorkflow(
  ctx: ExecutionState,
  args: Record<string, any>,
): Promise<any> {
  // pipeline over review dimensions (audit -> verify-each), then keep only the
  // findings a verifier confirms. The plan is code, not a chat turn.
  ctx.phase("Review");
  const changes = args["changes"] ?? "";
  if (typeof changes !== "string") {
    throw new WorkflowInputError("args.changes must be a string");
  }
  const reviewInput = changes.trim() || "No change context was supplied.";

  const audit = async (_value: any, dimension: string, _idx: number) => {
    const out = await ctx.agent(
      `Review this change context for ${dimension} issues. ` +
        "Report only issues supported by the supplied text.\n\n" +
        `${reviewInput}`,
      FINDINGS_SCHEMA,
      `audit:${dimension}`,
      "Review",
    );
    return { dimension, findings: out["findings"] };
  };

  const verify = async (audited: any, dimension: string, _idx: number) => {
    ctx.phase("Verify");
    // Each finding is verified by its own adversarial subagent, concurrently.
    const verdicts = await ctx.parallel(
      audited["findings"].map(
        (f: any) => () =>
          ctx.agent(
            `Adversarially verify this ${dimension} finding against the ` +
              "supplied change context.\n\n" +
              `Change context:\n${reviewInput}\n\n` +
              `Finding:\n${JSON.stringify(f)}`,
            VERDICT_SCHEMA,
            `verify:${dimension}:${f["title"]}`,
            "Verify",
          ),
      ),
    );
    const confirmed = audited["findings"].filter(
      (f: any, i: number) => verdicts[i] && verdicts[i]["isReal"],
    );
    return { dimension, confirmed };
  };

  const results = await ctx.pipeline(DIMENSIONS, audit, verify);
  const confirmed: Array<Record<string, any>> = [];
  for (const r of results) {
    if (!r) continue;
    for (const f of r["confirmed"]) {
      confirmed.push({ dimension: r["dimension"], ...f });
    }
  }
  const rank: Record<string, number> = { high: 0, medium: 1, low: 2 };
  confirmed.sort((a, b) => (rank[a["severity"]] ?? 3) - (rank[b["severity"]] ?? 3));
  ctx.log(`confirmed ${confirmed.length} real finding(s)`);
  return { confirmed };
}

// Saved workflow registry
const WORKFLOWS: Record<
  string,
  [Record<string, any>, (ctx: ExecutionState, args: Record<string, any>) => Promise<any>]
> = {
  [SAMPLE_META.name]: [SAMPLE_META, sampleWorkflow],
};

const WORKFLOW_TOOL = {
  name: "Workflow",
  description: "Run a saved workflow by name. Pass input in args.",
  input_schema: {
    type: "object",
    properties: {
      name: { type: "string" },
      args: { type: "object" },
      resume_from_run_id: { type: "string" },
    },
    required: ["name"],
    additionalProperties: false,
  },
};

function serializeTask(task: LocalWorkflowTask): Record<string, any> {
  return {
    taskId: task.taskId,
    taskType: "local_workflow",
    runId: task.runId,
    workflowName: task.meta["name"],
    status: task.status,
    usage: { ...task.usage },
    progress: [...task.progress],
  };
}

async function runWorkflow(
  name: string,
  args: Record<string, any> | null = null,
  resumeFromRunId: string | null = null,
): Promise<{ launched: any; result: any; task: Record<string, any> }> {
  // Model-facing adapter: resolve trusted code from the host registry.
  if (typeof name !== "string") {
    throw new WorkflowInputError("workflow name must be a string");
  }
  if (!(name in WORKFLOWS)) {
    throw new WorkflowInputError(`unknown workflow '${name}'`);
  }
  if (
    args !== null &&
    (typeof args !== "object" || Array.isArray(args))
  ) {
    throw new WorkflowInputError("workflow args must be an object");
  }
  const [meta, scriptFn] = WORKFLOWS[name];
  const out = await new WorkflowTool().call(meta, scriptFn, args, resumeFromRunId);
  return {
    launched: out.launched,
    result: out.result,
    task: serializeTask(out.task),
  };
}

const WORKFLOW_HANDLERS: Record<string, typeof runWorkflow> = {
  Workflow: runWorkflow,
};
const INHERITS_TOOLS_FROM = "s15";

async function runWorkflowSync(toolInput: Record<string, any>): Promise<string> {
  // Bridge the synchronous host dispatcher to the async workflow runtime.
  try {
    return JSON.stringify(
      await runWorkflow(
        toolInput["name"],
        toolInput["args"],
        toolInput["resume_from_run_id"],
      ),
    );
  } catch (exc) {
    if (exc instanceof WorkflowInputError) {
      return `Error: ${exc.message}`;
    }
    throw exc;
  }
}

function installWorkflowTool(host: any): void {
  // Extend the s15 host tool pool without changing its dispatch loop.
  RUNNER_FACTORY = () => new AnthropicAgentRunner(host.client, host.MODEL);
  if (host._workflow_tool_installed) {
    return;
  }
  const baseAssemble = host.assemble_tool_pool.bind(host);

  const assembleWithWorkflow = () => {
    const [tools, handlers] = baseAssemble();
    if (!tools.some((tool: any) => tool["name"] === "Workflow")) {
      tools.push(WORKFLOW_TOOL);
    }
    handlers["Workflow"] = runWorkflowSync;
    return [tools, handlers];
  };

  host.assemble_tool_pool = assembleWithWorkflow;
  host._workflow_tool_installed = true;
}

function loadIntegratedHost(): any {
  // Load s15 lazily so deterministic workflow tests need no API key.
  const hostPath = path.join(
    path.dirname(__dirname),
    "s15_integrated_harness",
    "code.ts",
  );
  // In TypeScript/Node this maps to a dynamic require of the sibling module.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const host = require(hostPath);
  return host;
}

// -- CLI --
async function runDemo(argv: string[]): Promise<void> {
  let resumeId: string | null = null;
  if (argv.length && argv[0] === "resume") {
    resumeId = _readLastRun();
    if (!resumeId) {
      console.log("nothing to resume; run `node code.ts demo` first.");
      return;
    }
    console.log(
      `resuming ${resumeId}; unchanged agent() calls use the journal cache\n`,
    );
  } else {
    console.log("launching workflow `review-changes`\n");
  }

  const out = await WORKFLOW_HANDLERS["Workflow"](
    "review-changes",
    { budget: null, changes: DEMO_CHANGES },
    resumeId,
  );

  console.log("\nresult:");
  for (const f of out.result["confirmed"] || []) {
    console.log(`  [${String(f["severity"]).padEnd(6)}] ${f["dimension"]}: ${f["title"]}`);
  }
  const task = out.task;
  const usage = task["usage"];
  console.log(
    `\nstatus=${task["status"]}  agents=${usage["agents"]}  ` +
      `tokens=${usage["tokens"]}  journal=.runtime/${task["runId"]}.journal.jsonl`,
  );
}

function runCli(): void {
  // Run the cumulative s15 host with Workflow added to its tool pool.
  const host = loadIntegratedHost();
  installWorkflowTool(host);
  host.CLI_ACTIVE = true;
  host.start_runtime_services();
  console.log("s16: workflow runtime");
  console.log("Enter a question, press Enter to send. Type q to quit.\n");
  const history: any[] = [];
  let context = host.update_context({}, history);
  const sessionState = { active_user_request: "(no active user request)" };
  // In Python this spins up a background daemon thread; in Node this would be a
  // background async loop launched without awaiting.
  void host.async_event_loop(history, context, sessionState);
  // The interactive read loop (host.CONSOLE.ask) is a blocking prompt loop.
  // Faithful structure preserved below for reference.
  /*
  while (true) {
    let query: string;
    try {
      query = host.CONSOLE.ask("\x1b[36ms16 >> \x1b[0m");
    } catch {
      break;
    }
    if (["q", "exit", ""].includes(query.trim().toLowerCase())) {
      break;
    }
    // host.agent_lock guards the shared state during the turn.
    host.trigger_hooks("UserPromptSubmit", query);
    const turnStart = history.length;
    sessionState.active_user_request = query;
    history.push({ role: "user", content: query });
    host.agent_loop(history, context, query);
    context = host.update_context(context, history);
    host.print_turn_assistants(history, turnStart);
    console.log();
  }
  */
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.length && (argv[0] === "demo" || argv[0] === "resume")) {
    runDemo(argv);
  } else {
    runCli();
  }
}
