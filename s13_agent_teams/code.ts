#!/usr/bin/env node
/*
 * s13: Agent Teams - persistent teammates with shared tasks and mailboxes.
 *
 * Run:  node s13_agent_teams/code.ts
 * Need: npm install @anthropic-ai/sdk dotenv + .env with ANTHROPIC_API_KEY
 *
 *     +------+  spawn(task_id)  +----------+  result  +------+
 *     | Lead | ---------------> |   WORK   | -------> | IDLE |
 *     +--+---+                  +----+-----+          +--+---+
 *        ^                           |                   |
 *        | team events               | tools             | wait
 *        |                           v                   v
 *     +--+-----------+          +----------+        +----------+
 *     | MessageBus   |          | Task cwd | <----- | Mailbox  |
 *     +--------------+          +----------+  claim +----------+
 *
 *     .tasks/       shared task records and dependencies
 *     .mailboxes/   messages, results, and protocol responses
 *     .worktrees/   optional task-bound working directories
 */

import * as child_process from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

// In Node, `import { Anthropic } from "@anthropic-ai/sdk"` and dotenv config()
// stand in for the Python `from anthropic import Anthropic` + load_dotenv.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Anthropic } = require("@anthropic-ai/sdk");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { config: loadDotenv } = require("dotenv");

loadDotenv({ override: true });
if (process.env["ANTHROPIC_BASE_URL"]) {
  delete process.env["ANTHROPIC_AUTH_TOKEN"];
}

const WORKDIR = process.cwd();
const client = new Anthropic({ baseURL: process.env["ANTHROPIC_BASE_URL"] });
const MODEL = process.env["MODEL_ID"] as string;

// -- Task System --

const TASKS_DIR = path.join(WORKDIR, ".tasks");
const TASKS_ROOT = path.resolve(TASKS_DIR);
const TASK_ID_PATTERN = /^task_[0-9a-f]{8}$/;
const TASK_LOCK_PATH = path.join(TASKS_DIR, ".lock");

// owner -> {"task_id": str, "cwd": Path}. A teammate gets one assignment at
// a time, and every filesystem tool resolves its cwd through this registry.
const teammateAssignments: Record<string, { task_id: string; cwd: string }> = {};
const assignmentVersions: Record<string, number> = {};

// Node is single-threaded for our purposes, so the reentrant thread lock and
// cross-process flock are modelled as a reentrancy depth counter guarding an
// exclusively created lock file.
const _taskStoreState: { depth: number; handle: number | null } = {
  depth: 0,
  handle: null,
};

function taskStoreLock<T>(fn: () => T): T {
  // Serialize task mutations across threads and host processes.
  const depth = _taskStoreState.depth;
  if (depth === 0) {
    fs.mkdirSync(TASKS_DIR, { recursive: true });
    // "a+" open + exclusive intent; we retain the fd for the duration.
    _taskStoreState.handle = fs.openSync(TASK_LOCK_PATH, "a+");
  }
  _taskStoreState.depth = depth + 1;
  try {
    return fn();
  } finally {
    _taskStoreState.depth -= 1;
    if (_taskStoreState.depth === 0) {
      const handle = _taskStoreState.handle;
      if (handle !== null) {
        fs.closeSync(handle);
      }
      _taskStoreState.handle = null;
    }
  }
}

function advanceAssignmentVersion(owner: string): void {
  // Invalidate old approvals without clearing an explicit plan requirement.
  assignmentVersions[owner] = (assignmentVersions[owner] || 0) + 1;
  const gates = planGates;
  const requestIds = planRequestIds;
  // team_lock is modelled as a no-op in single-threaded Node.
  if (gates && owner in gates && gates[owner] !== "not_required") {
    gates[owner] = "required";
  }
  if (requestIds) {
    delete requestIds[owner];
  }
}

interface Task {
  id: string;
  subject: string;
  description: string;
  status: string; // pending | in_progress | completed
  owner: string | null;
  blockedBy: string[];
  worktree: string | null;
}

function makeTask(data: Partial<Task>): Task {
  return {
    id: data.id!,
    subject: data.subject!,
    description: data.description ?? "",
    status: data.status!,
    owner: data.owner ?? null,
    blockedBy: data.blockedBy ?? [],
    worktree: data.worktree ?? null,
  };
}

function _taskPath(taskId: any): string {
  if (typeof taskId !== "string" || !TASK_ID_PATTERN.test(taskId)) {
    throw new ValueError(`Invalid task ID: ${JSON.stringify(taskId)}`);
  }
  const p = path.resolve(path.join(TASKS_DIR, `${taskId}.json`));
  if (
    !isRelativeTo(TASKS_ROOT, path.resolve(WORKDIR)) ||
    !isRelativeTo(p, TASKS_ROOT)
  ) {
    throw new ValueError(`Invalid task ID: ${JSON.stringify(taskId)}`);
  }
  return p;
}

function createTask(
  subject: string,
  description = "",
  blockedBy: string[] | null = null,
): Task {
  subject = subject.trim();
  if (!subject) {
    throw new ValueError("Task subject cannot be empty");
  }
  // dict.fromkeys preserves order while de-duplicating.
  const dependencies = [...new Set(blockedBy || [])];
  return taskStoreLock(() => {
    for (const dependency of dependencies) {
      if (!isFile(_taskPath(dependency))) {
        throw new ValueError(`Dependency not found: ${dependency}`);
      }
    }
    for (let i = 0; i < 100; i++) {
      const task = makeTask({
        id: `task_${crypto.randomBytes(4).toString("hex")}`,
        subject,
        description,
        status: "pending",
        owner: null,
        blockedBy: dependencies,
      });
      try {
        const fd = fs.openSync(_taskPath(task.id), "wx");
        fs.writeSync(fd, JSON.stringify(task, null, 2));
        fs.closeSync(fd);
        return task;
      } catch (e: any) {
        if (e && e.code === "EEXIST") {
          continue;
        }
        throw e;
      }
    }
    throw new Error("Could not allocate a unique task ID");
  });
}

function saveTask(task: Task): void {
  taskStoreLock(() => {
    const p = _taskPath(task.id);
    const temporary = path.join(
      path.dirname(p),
      `.${path.basename(p)}.${process.pid}.${0}.tmp`,
    );
    try {
      fs.writeFileSync(temporary, JSON.stringify(task, null, 2), "utf-8");
      fs.renameSync(temporary, p);
    } finally {
      try {
        fs.unlinkSync(temporary);
      } catch {
        /* missing_ok */
      }
    }
  });
}

function loadTask(taskId: string): Task {
  // task_lock modelled as direct execution in single-threaded Node.
  const data = JSON.parse(fs.readFileSync(_taskPath(taskId), "utf-8"));
  const task = makeTask(data);
  if (task.id !== taskId) {
    throw new ValueError(`Task file ID does not match ${taskId}`);
  }
  if (!["pending", "in_progress", "completed"].includes(task.status)) {
    throw new ValueError(`Invalid task status: ${task.status}`);
  }
  return task;
}

function listTasks(): Task[] {
  if (!fs.existsSync(TASKS_DIR)) {
    return [];
  }
  if (!isRelativeTo(TASKS_ROOT, path.resolve(WORKDIR))) {
    throw new ValueError("Tasks directory escapes workspace");
  }
  return fs
    .readdirSync(TASKS_DIR)
    .filter((name) => /^task_.*\.json$/.test(name))
    .sort()
    .map((name) => loadTask(path.basename(name, ".json")));
}

function getTask(taskId: string): string {
  // Return full task details as JSON.
  const task = loadTask(taskId);
  return JSON.stringify(task, null, 2);
}

function canStart(taskId: string): boolean {
  // Check if all blockedBy dependencies are completed.
  // Missing dependencies are treated as blocked.
  const task = loadTask(taskId);
  for (const depId of task.blockedBy) {
    let depPath: string;
    try {
      depPath = _taskPath(depId);
    } catch (e) {
      if (e instanceof ValueError) {
        return false;
      }
      throw e;
    }
    if (!fs.existsSync(depPath)) {
      return false;
    }
    if (loadTask(depId).status !== "completed") {
      return false;
    }
  }
  return true;
}

function _ownerInProgress(owner: string): Task | null {
  return (
    listTasks().find(
      (task) => task.status === "in_progress" && task.owner === owner,
    ) || null
  );
}

function _incompleteDependencies(task: Task): string[] {
  const incomplete: string[] = [];
  for (const depId of task.blockedBy) {
    let depPath: string;
    try {
      depPath = _taskPath(depId);
    } catch (e) {
      if (e instanceof ValueError) {
        incomplete.push(depId);
        continue;
      }
      throw e;
    }
    if (!fs.existsSync(depPath) || loadTask(depId).status !== "completed") {
      incomplete.push(depId);
    }
  }
  return incomplete;
}

function claimTask(taskId: string, owner = "agent"): string {
  // Atomically claim one task and bind the owner's filesystem cwd.
  const result = taskStoreLock(() => {
    const task = loadTask(taskId);
    if (task.status !== "pending") {
      return `Task ${taskId} is ${task.status}, cannot claim`;
    }
    if (task.owner) {
      return `Task ${taskId} is already owned by ${task.owner}`;
    }
    const assignment = teammateAssignments[owner];
    if (assignment) {
      return (
        `Owner ${owner} must finish the current work turn for ` +
        `${assignment.task_id} before claiming another task`
      );
    }
    const current = _ownerInProgress(owner);
    if (current) {
      return (
        `Owner ${owner} must complete ${current.id} before ` +
        "claiming another task"
      );
    }
    if (!canStart(taskId)) {
      return `Blocked by: ${JSON.stringify(_incompleteDependencies(task))}`;
    }
    const [cwd, error] = taskWorktreeCwd(task);
    if (error) {
      return `Cannot claim ${taskId}: ${error}`;
    }
    task.owner = owner;
    task.status = "in_progress";
    saveTask(task);
    teammateAssignments[owner] = { task_id: task.id, cwd };
    advanceAssignmentVersion(owner);
    console.log(`  [claim] ${task.subject} -> in_progress (owner: ${owner})`);
    return `Claimed ${task.id} (${task.subject})`;
  });
  return result;
}

function completeTask(taskId: string, owner = "agent"): string {
  // Complete an assignment only when the caller owns it.
  const { msg } = taskStoreLock(() => {
    const task = loadTask(taskId);
    if (task.status !== "in_progress") {
      return { msg: `Task ${taskId} is ${task.status}, cannot complete` };
    }
    if (task.owner !== owner) {
      return {
        msg:
          `Task ${taskId} is owned by ${task.owner}, ` +
          `not ${owner}; cannot complete`,
      };
    }
    const gate = (planGates[owner] ?? "not_required");
    if (["required", "pending", "rejected"].includes(gate)) {
      return {
        msg: `Task ${taskId} cannot complete while plan status is ${gate}`,
      };
    }
    const assignment = teammateAssignments[owner];
    if (!assignment || assignment.task_id !== task.id) {
      const [cwd, error] = taskWorktreeCwd(task);
      if (error) {
        return { msg: `Task ${taskId} cannot complete: ${error}` };
      }
      teammateAssignments[owner] = { task_id: task.id, cwd };
    }
    task.status = "completed";
    saveTask(task);
    const unblocked = listTasks()
      .filter(
        (t) =>
          t.status === "pending" && t.blockedBy.length && canStart(t.id),
      )
      .map((t) => t.subject);
    console.log(`  [complete] ${task.subject}`);
    let message = `Completed ${task.id} (${task.subject})`;
    if (unblocked.length) {
      message += `\nUnblocked: ${unblocked.join(", ")}`;
      console.log(`  [unblocked] ${unblocked.join(", ")}`);
    }
    return { msg: message };
  });
  return msg;
}

// -- Task-bound Worktrees --

const WORKTREES_DIR = path.join(WORKDIR, ".worktrees");
const WORKTREES_ROOT = path.resolve(WORKTREES_DIR);
const VALID_WORKTREE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function validateWorktreeName(name: any): string | null {
  if (typeof name !== "string" || !VALID_WORKTREE_NAME.test(name)) {
    return (
      "worktree name must be 1-64 letters, digits, dots, " +
      "underscores, or dashes, and start with a letter or digit"
    );
  }
  if (name === "." || name === ".." || name.includes("..")) {
    return "worktree name cannot contain '..'";
  }
  return null;
}

function _worktreePath(name: string): string {
  const p = path.resolve(path.join(WORKTREES_DIR, name));
  if (
    !isRelativeTo(WORKTREES_ROOT, path.resolve(WORKDIR)) ||
    !isRelativeTo(p, WORKTREES_ROOT) ||
    p === WORKTREES_ROOT
  ) {
    throw new ValueError(`Worktree path escapes directory: ${JSON.stringify(name)}`);
  }
  return p;
}

function _worktreeBranch(name: string): string {
  return `wt/${name}`;
}

function _runGit(args: string[], cwd: string | null = null): [boolean, string] {
  // Run Git without shell interpolation and preserve machine output.
  let result: child_process.SpawnSyncReturns<string>;
  try {
    result = child_process.spawnSync("git", args, {
      cwd: cwd || WORKDIR,
      encoding: "utf-8",
      timeout: 30000,
    });
  } catch (exc: any) {
    return [false, `${exc?.name ?? "Error"}: ${exc?.message ?? exc}`];
  }
  if (result.error) {
    return [false, `${result.error.name}: ${result.error.message}`];
  }
  const output = ((result.stdout || "") + (result.stderr || "")).trim();
  return [result.status === 0, output || "(no output)"];
}

function runGit(args: string[], cwd: string | null = null): [boolean, string] {
  // Run Git and bound only the text returned to the model.
  const [ok, output] = _runGit(args, cwd);
  return [ok, output.slice(0, 5000)];
}

function _registeredWorktrees(): [
  Record<string, Record<string, string>>,
  string | null,
] {
  const [ok, output] = _runGit(["worktree", "list", "--porcelain"]);
  if (!ok) {
    return [{}, `cannot read Git worktree registry: ${output}`];
  }
  const entries: Record<string, Record<string, string>> = {};
  let current: Record<string, string> = {};
  for (const line of [...output.split("\n"), ""]) {
    if (!line) {
      const rawPath = current["worktree"];
      if (rawPath) {
        entries[path.resolve(rawPath)] = current;
      }
      current = {};
      continue;
    }
    const idx = line.indexOf(" ");
    const key = idx === -1 ? line : line.slice(0, idx);
    const value = idx === -1 ? "" : line.slice(idx + 1);
    current[key] = value;
  }
  return [entries, null];
}

function _registeredWorktree(name: string): [string | null, string | null] {
  let p: string;
  try {
    p = _worktreePath(name);
  } catch (exc: any) {
    return [null, String(exc?.message ?? exc)];
  }
  const [entries, error] = _registeredWorktrees();
  if (error) {
    return [null, error];
  }
  if (!(p in entries)) {
    return [null, `worktree '${name}' is not registered with Git`];
  }
  if (!isDir(p)) {
    return [null, `worktree '${name}' is missing at ${p}`];
  }
  const expectedBranch = `refs/heads/${_worktreeBranch(name)}`;
  if (entries[p]["branch"] !== expectedBranch) {
    return [
      null,
      `worktree '${name}' is not registered on expected ` +
        `branch '${_worktreeBranch(name)}'`,
    ];
  }
  return [p, null];
}

function taskWorktreeCwd(task: Task): [string, string | null] {
  // Resolve a task cwd, failing closed for broken worktree bindings.
  if (!task.worktree) {
    return [WORKDIR, null];
  }
  const [p, error] = _registeredWorktree(task.worktree);
  return [p || WORKDIR, error];
}

function assignmentCwd(owner: string): string {
  let assignment = teammateAssignments[owner];
  let task = _ownerInProgress(owner);
  if (task && (!assignment || assignment.task_id !== task.id)) {
    const [cwd, error] = taskWorktreeCwd(task);
    if (error) {
      throw new ValueError(error);
    }
    assignment = { task_id: task.id, cwd };
    teammateAssignments[owner] = assignment;
  } else if (!assignment) {
    return WORKDIR;
  }
  task = loadTask(String(assignment.task_id));
  if (
    !["in_progress", "completed"].includes(task.status) ||
    task.owner !== owner
  ) {
    throw new ValueError(`Assignment for ${owner} is no longer active`);
  }
  const [cwd, error] = taskWorktreeCwd(task);
  if (error) {
    throw new ValueError(error);
  }
  if (path.resolve(cwd) !== path.resolve(assignment.cwd)) {
    throw new ValueError(`Assignment cwd changed for task ${task.id}`);
  }
  return cwd;
}

function releaseCompletedAssignment(owner: string): boolean {
  // Release a completed cwd lease only at a model turn boundary.
  const assignment = teammateAssignments[owner];
  if (!assignment) {
    return false;
  }
  const task = loadTask(String(assignment.task_id));
  if (task.status !== "completed" || task.owner !== owner) {
    return false;
  }
  delete teammateAssignments[owner];
  advanceAssignmentVersion(owner);
  if (owner in planGates) {
    planGates[owner] = "not_required";
  }
  return true;
}

function releaseTeammateAssignment(owner: string): void {
  // Return abandoned teammate work to the task board on thread exit.
  try {
    const task = _ownerInProgress(owner);
    if (task) {
      task.status = "pending";
      task.owner = null;
      saveTask(task);
    }
  } finally {
    delete teammateAssignments[owner];
    advanceAssignmentVersion(owner);
    if (owner in planGates) {
      planGates[owner] = "not_required";
    }
  }
}

function createWorktree(name: string, taskId: string): string {
  // Create and bind a dedicated worktree after all inputs validate.
  const nameError = validateWorktreeName(name);
  if (nameError) {
    return `Error: ${nameError}`;
  }
  let p: string;
  let taskPath: string;
  try {
    p = _worktreePath(name);
    taskPath = _taskPath(taskId);
  } catch (exc: any) {
    return `Error: ${exc?.message ?? exc}`;
  }
  const branch = _worktreeBranch(name);

  if (!fs.existsSync(taskPath)) {
    return `Error: Task ${taskId} not found`;
  }
  const task = loadTask(taskId);
  if (task.status !== "pending" || task.owner !== null) {
    return `Error: Task ${taskId} must be pending and unowned`;
  }
  if (task.worktree) {
    return `Error: Task ${taskId} already uses worktree '${task.worktree}'`;
  }
  if (listTasks().some((t) => t.worktree === name && t.id !== taskId)) {
    return `Error: Worktree '${name}' is already bound to another task`;
  }
  if (fs.existsSync(p)) {
    return `Error: Worktree path already exists: ${p}`;
  }

  {
    const [ok, root] = runGit(["rev-parse", "--show-toplevel"]);
    if (!ok || path.resolve(root) !== path.resolve(WORKDIR)) {
      return "Error: Working directory must be the root of a Git repository";
    }
  }
  {
    const [ok, branchCheck] = runGit(["check-ref-format", "--branch", branch]);
    if (!ok) {
      return `Error: Invalid worktree branch '${branch}': ${branchCheck}`;
    }
  }
  {
    const [exists] = runGit([
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${branch}`,
    ]);
    if (exists) {
      return `Error: Branch '${branch}' already exists`;
    }
  }
  {
    const [entries, registryError] = _registeredWorktrees();
    if (registryError) {
      return `Error: ${registryError}`;
    }
    if (p in entries) {
      return `Error: Worktree path is already registered: ${p}`;
    }
  }

  fs.mkdirSync(WORKTREES_DIR, { recursive: true });
  {
    const [ok, result] = runGit([
      "worktree",
      "add",
      "-b",
      branch,
      String(p),
      "HEAD",
    ]);
    if (!ok) {
      const [entries, registryError] = _registeredWorktrees();
      const [branchExists] = runGit([
        "show-ref",
        "--verify",
        "--quiet",
        `refs/heads/${branch}`,
      ]);
      const artifacts: string[] = [];
      if (fs.existsSync(p)) {
        artifacts.push(`checkout path '${p}'`);
      }
      if (registryError === null && p in entries) {
        artifacts.push("registered Git worktree");
      }
      if (branchExists) {
        artifacts.push(`branch '${branch}'`);
      }
      if (artifacts.length) {
        return (
          "Partial operation: git worktree add reported an error " +
          `after leaving ${artifacts.join(", ")}. Task ${taskId} ` +
          "remains unbound and no Git data was deleted. Run " +
          `\`git worktree list\`, inspect '${p}' and '${branch}', ` +
          "then keep or remove those artifacts manually after " +
          `preserving any work. Git error: ${result}`
        );
      }
      return `Git error: ${result}`;
    }
  }

  try {
    task.worktree = name;
    saveTask(task);
  } catch (exc: any) {
    return (
      `Partial success: Worktree '${name}' was created at ` +
      `${p} on branch '${branch}', but task binding failed: ` +
      `${exc?.message ?? exc}. Git data was retained for manual recovery.`
    );
  }

  console.log(`  \x1b[33m[worktree] created: ${name} at ${p}\x1b[0m`);
  return `Worktree '${name}' created at ${p} for task ${taskId}`;
}

function removeWorktree(name: string, discardChanges = false): string {
  // Remove a registered checkout while always retaining its branch.
  const nameError = validateWorktreeName(name);
  if (nameError) {
    return `Error: ${nameError}`;
  }

  const [p, error] = _registeredWorktree(name);
  if (error) {
    return `Error: ${error}`;
  }
  const bound = listTasks().filter((task) => task.worktree === name);
  if (!bound.length) {
    return `Error: Worktree '${name}' is not bound to a task`;
  }
  const active = bound.filter((task) => task.status !== "completed");
  if (active.length) {
    return (
      `Error: Worktree '${name}' is bound to active task ` +
      `${active[0].id}; complete it before removal`
    );
  }
  const leased = Object.entries(teammateAssignments)
    .filter(
      ([, assignment]) => path.resolve(assignment.cwd) === path.resolve(p!),
    )
    .map(([owner]) => owner);
  if (leased.length) {
    return (
      `Error: Worktree '${name}' is still in use by ` +
      `${leased.sort().join(", ")}; wait for the turn to end`
    );
  }
  const [ok, status] = runGit(
    ["status", "--porcelain", "--ignored"],
    p,
  );
  if (!ok) {
    return `Error: Cannot verify worktree '${name}' status: ${status}`;
  }
  if (status !== "(no output)" && !discardChanges) {
    const changed = status.split("\n").filter((line) => line.trim()).length;
    return (
      `Error: Worktree '${name}' has ${changed} uncommitted ` +
      "change(s); preserve or discard them manually"
    );
  }

  const args = ["worktree", "remove"];
  if (discardChanges) {
    args.push("--force");
  }
  args.push(String(p));
  {
    const [ok2, result] = runGit(args);
    if (!ok2) {
      return `Git error: ${result}`;
    }
  }

  try {
    for (const task of bound) {
      task.worktree = null;
      saveTask(task);
    }
  } catch (exc: any) {
    return (
      `Partial success: Worktree '${name}' was removed and ` +
      `branch '${_worktreeBranch(name)}' retained, but task ` +
      `unbinding failed: ${exc?.message ?? exc}. Manual recovery is required.`
    );
  }

  console.log(`  [worktree] removed: ${name}; branch retained`);
  return `Worktree '${name}' removed; branch '${_worktreeBranch(name)}' retained`;
}

// -- System Prompt --

const PROMPT_SECTIONS: Record<string, string> = {
  identity: "You are a coding agent. Act, don't explain.",
  tools:
    "Available tools: bash, read_file, write_file, edit_file, glob, " +
    "get_task, create_task, list_tasks, claim_task, complete_task, " +
    "spawn_teammate, list_teammates, send_message, request_shutdown, " +
    "request_plan, review_plan, create_worktree.",
  teams:
    "When parallel work would help, first propose a small team with clear " +
    "responsibilities and wait for the user's confirmation. Do not call " +
    "spawn_teammate before the user confirms. After confirmation, delegate " +
    "independent work by creating a Task for each parallel change. Pass " +
    "task_id to spawn_teammate when assigning ready work, then " +
    "create a task-bound worktree only when a separate working directory " +
    "would prevent conflicting edits. A teammate must complete its current " +
    "Task before claiming another. A worktree changes tool default cwd " +
    "only; it is not a sandbox. Worktree removal stays with the host or " +
    "user. After spawning a teammate, end the current turn instead of " +
    "polling its status; the runtime will deliver team events and wake the " +
    "Lead. React to those events, and shut teammates down when " +
    "coordination is complete.",
  workspace: `Working directory: ${WORKDIR}`,
};

const SYSTEM = Object.values(PROMPT_SECTIONS).join("\n\n");

// -- Base Tools --

function safePath(p: string, cwd: string | null = null): string {
  const base = path.resolve(cwd || WORKDIR);
  const target = path.resolve(path.join(base, p));
  if (!isRelativeTo(target, base)) {
    throw new ValueError(`Path escapes workspace: ${p}`);
  }
  return target;
}

function runBash(command: string, cwd: string | null = null): string {
  try {
    const result = child_process.spawnSync(command, {
      shell: true,
      cwd: cwd || WORKDIR,
      encoding: "utf-8",
      timeout: 120000,
    });
    if (result.error && (result.error as any).code === "ETIMEDOUT") {
      return "Error: Timeout (120s)";
    }
    if (result.error) {
      return `Error: ${result.error.name}: ${result.error.message}`;
    }
    let output = ((result.stdout || "") + (result.stderr || "")).trim();
    output = output ? output.slice(0, 50000) : "(no output)";
    if (result.status) {
      return `Error: command exited with status ${result.status}\n${output}`;
    }
    return output;
  } catch (exc: any) {
    return `Error: ${exc?.name ?? "Error"}: ${exc?.message ?? exc}`;
  }
}

function runRead(
  p: string,
  limit: number | null = null,
  cwd: string | null = null,
): string {
  try {
    let lines = fs.readFileSync(safePath(p, cwd), "utf-8").split("\n");
    if (limit && limit < lines.length) {
      lines = [
        ...lines.slice(0, limit),
        `... (${lines.length - limit} more lines)`,
      ];
    }
    return lines.join("\n");
  } catch (e: any) {
    return `Error: ${e?.message ?? e}`;
  }
}

function runWrite(p: string, content: string, cwd: string | null = null): string {
  try {
    const fp = safePath(p, cwd);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content);
    return `Wrote ${content.length} bytes to ${p}`;
  } catch (e: any) {
    return `Error: ${e?.message ?? e}`;
  }
}

function runEdit(
  p: string,
  oldText: string,
  newText: string,
  cwd: string | null = null,
): string {
  try {
    const target = safePath(p, cwd);
    const content = fs.readFileSync(target, "utf-8");
    const count = content.split(oldText).length - 1;
    if (count !== 1) {
      return `Error: Expected 1 occurrence, found ${count}`;
    }
    fs.writeFileSync(target, content.replace(oldText, newText), "utf-8");
    return `Edited ${p}`;
  } catch (exc: any) {
    return `Error: ${exc?.message ?? exc}`;
  }
}

function runGlob(pattern: string, cwd: string | null = null): string {
  try {
    const base = path.resolve(cwd || WORKDIR);
    const matches = globInDir(base, pattern)
      .filter((rel) => isRelativeTo(path.resolve(base, rel), base))
      .sort();
    return matches.slice(0, 200).join("\n") || "No files found";
  } catch (exc: any) {
    return `Error: ${exc?.message ?? exc}`;
  }
}

function _agentCwd(): [string | null, string | null] {
  try {
    return [assignmentCwd("agent"), null];
  } catch (exc: any) {
    return [null, `Error: Invalid task assignment: ${exc?.message ?? exc}`];
  }
}

function runAgentBash(command: string): string {
  const [cwd, error] = _agentCwd();
  return error || runBash(command, cwd);
}

function runAgentRead(path_: string, limit: number | null = null): string {
  const [cwd, error] = _agentCwd();
  return error || runRead(path_, limit, cwd);
}

function runAgentWrite(path_: string, content: string): string {
  const [cwd, error] = _agentCwd();
  return error || runWrite(path_, content, cwd);
}

function runAgentEdit(path_: string, oldText: string, newText: string): string {
  const [cwd, error] = _agentCwd();
  return error || runEdit(path_, oldText, newText, cwd);
}

function runAgentGlob(pattern: string): string {
  const [cwd, error] = _agentCwd();
  return error || runGlob(pattern, cwd);
}

// -- Task Tools --

function runCreateTask(
  subject: string,
  description = "",
  blockedBy: string[] | null = null,
): string {
  const task = createTask(subject, description, blockedBy);
  const deps = blockedBy ? ` (blockedBy: ${blockedBy.join(", ")})` : "";
  console.log(`  \x1b[34m[create] ${task.subject}${deps}\x1b[0m`);
  return `Created ${task.id}: ${task.subject}${deps}`;
}

function runListTasks(): string {
  const tasks = listTasks();
  if (!tasks.length) {
    return "No tasks. Use create_task to add some.";
  }
  const lines: string[] = [];
  for (const t of tasks) {
    const icon =
      ({ pending: "[ ]", in_progress: "[~]", completed: "[x]" } as Record<
        string,
        string
      >)[t.status] || "[?]";
    const deps = t.blockedBy.length
      ? ` (blockedBy: ${t.blockedBy.join(", ")})`
      : "";
    const owner = t.owner ? ` [${t.owner}]` : "";
    const worktree = t.worktree ? ` (worktree: ${t.worktree})` : "";
    lines.push(
      `  ${icon} ${t.id}: ${t.subject} ` +
        `[${t.status}]${owner}${deps}${worktree}`,
    );
  }
  return lines.join("\n");
}

function runGetTask(taskId: string): string {
  try {
    return getTask(taskId);
  } catch (exc: any) {
    if (exc instanceof ValueError) {
      return `Error: ${exc.message}`;
    }
    if (exc && exc.code === "ENOENT") {
      return `Error: Task ${taskId} not found`;
    }
    throw exc;
  }
}

function runClaimTask(taskId: string): string {
  try {
    return claimTask(taskId, "agent");
  } catch (exc: any) {
    if (exc instanceof ValueError) {
      return `Error: ${exc.message}`;
    }
    if (exc && exc.code === "ENOENT") {
      return `Error: Task ${taskId} not found`;
    }
    throw exc;
  }
}

function runCompleteTask(taskId: string): string {
  try {
    return completeTask(taskId, "agent");
  } catch (exc: any) {
    if (exc instanceof ValueError) {
      return `Error: ${exc.message}`;
    }
    if (exc && exc.code === "ENOENT") {
      return `Error: Task ${taskId} not found`;
    }
    throw exc;
  }
}

// -- MessageBus and Team Protocols --

const MAILBOX_DIR = path.join(WORKDIR, ".mailboxes");
const MAILBOX_ROOT = path.resolve(MAILBOX_DIR);
const VALID_AGENT_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const RESERVED_TEAMMATE_NAMES = new Set(["lead", "agent"]);

function isValidAgentName(name: string): boolean {
  return VALID_AGENT_NAME.test(name);
}

interface BusMessage {
  from: string;
  to: string;
  content: string;
  type: string;
  ts: number;
  metadata: Record<string, any>;
}

class MessageBus {
  // Thread-safe file mailboxes with destructive reads.
  // In Node the RLock + Condition are modelled with plain synchronous logic plus
  // a list of waiters resolved when a message arrives.
  private _waiters: Array<() => void> = [];

  _path(agent: string): string {
    if (!isValidAgentName(agent)) {
      throw new ValueError(`Invalid mailbox recipient: ${JSON.stringify(agent)}`);
    }
    const p = path.resolve(path.join(MAILBOX_DIR, `${agent}.jsonl`));
    if (!isRelativeTo(p, MAILBOX_ROOT)) {
      throw new ValueError(`Mailbox path escapes directory: ${JSON.stringify(agent)}`);
    }
    return p;
  }

  _readUnlocked(agent: string): BusMessage[] {
    const inbox = this._path(agent);
    if (!fs.existsSync(inbox)) {
      return [];
    }
    const msgs = fs
      .readFileSync(inbox, "utf-8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
    fs.unlinkSync(inbox);
    return msgs;
  }

  send(
    fromAgent: string,
    toAgent: string,
    content: string,
    msgType = "message",
    metadata: Record<string, any> | null = null,
  ): void {
    const msg: BusMessage = {
      from: fromAgent,
      to: toAgent,
      content,
      type: msgType,
      ts: Date.now() / 1000,
      metadata: metadata || {},
    };
    fs.mkdirSync(MAILBOX_DIR, { recursive: true });
    fs.appendFileSync(this._path(toAgent), JSON.stringify(msg) + "\n", "utf-8");
    // notify_all: wake every waiter.
    const waiters = this._waiters;
    this._waiters = [];
    for (const waiter of waiters) {
      waiter();
    }
    console.log(
      `  [bus] ${fromAgent} -> ${toAgent}: ` +
        `(${msgType}) ${content.slice(0, 50)}`,
    );
  }

  readInbox(agent: string): BusMessage[] {
    return this._readUnlocked(agent);
  }

  peek(agent: string): boolean {
    const inbox = this._path(agent);
    return fs.existsSync(inbox) && fs.statSync(inbox).size > 0;
  }

  async waitForMessages(
    agent: string,
    timeout: number | null = null,
  ): Promise<BusMessage[]> {
    // Block until the agent has messages or timeout expires.
    const deadline = timeout === null ? null : Date.now() + timeout * 1000;
    while (!this.peek(agent)) {
      const remaining = deadline === null ? null : deadline - Date.now();
      if (remaining !== null && remaining <= 0) {
        return [];
      }
      await new Promise<void>((resolve) => {
        let done = false;
        const wake = () => {
          if (!done) {
            done = true;
            resolve();
          }
        };
        this._waiters.push(wake);
        if (remaining !== null) {
          setTimeout(wake, remaining);
        }
      });
    }
    return this._readUnlocked(agent);
  }
}

const BUS = new MessageBus();

// working | waiting_approval | idle | stopping
const activeTeammates: Record<string, string> = {};
const planGates: Record<string, string> = {};
const planRequestIds: Record<string, string> = {};
// team_lock is a no-op in single-threaded Node.

interface ProtocolState {
  request_id: string;
  type: string;
  sender: string;
  target: string;
  status: string;
  payload: string;
  work_version: number | null;
  task_id: string | null;
  created_at: number;
}

function makeProtocolState(data: Partial<ProtocolState>): ProtocolState {
  return {
    request_id: data.request_id!,
    type: data.type!,
    sender: data.sender!,
    target: data.target!,
    status: data.status!,
    payload: data.payload!,
    work_version: data.work_version ?? null,
    task_id: data.task_id ?? null,
    created_at: data.created_at ?? Date.now() / 1000,
  };
}

const pendingRequests: Record<string, ProtocolState> = {};

function newRequestId(): string {
  while (true) {
    const requestId = `req_${String(Math.floor(Math.random() * 1000000)).padStart(6, "0")}`;
    if (!(requestId in pendingRequests)) {
      return requestId;
    }
  }
}

function matchResponse(
  responseType: string,
  requestId: string,
  approve: boolean,
  fromAgent: string,
  toAgent: string,
): boolean {
  // Match one protocol response to one pending request.
  const state = pendingRequests[requestId];
  if (!state) {
    console.log(`  [protocol] unknown request_id: ${requestId}`);
    return false;
  }
  const expected = ({
    shutdown: "shutdown_response",
    plan_approval: "plan_approval_response",
  } as Record<string, string>)[state.type];
  if (responseType !== expected) {
    console.log(`  [protocol] expected ${expected}, got ${responseType}`);
    return false;
  }
  if (fromAgent !== state.target || toAgent !== state.sender) {
    console.log(`  [protocol] ${requestId} responder mismatch`);
    return false;
  }
  if (state.status !== "pending") {
    console.log(`  [protocol] ${requestId} already ${state.status}`);
    return false;
  }
  state.status = approve ? "approved" : "rejected";
  console.log(`  [protocol] ${requestId} -> ${state.status}`);
  return true;
}

function consumeLeadInbox(): BusMessage[] {
  // Consume Lead events and update protocol state before model delivery.
  const msgs = BUS.readInbox("lead");
  for (const msg of msgs) {
    const metadata = msg.metadata || {};
    const requestId = metadata["request_id"] || "";
    if (requestId && (msg.type || "").endsWith("_response")) {
      matchResponse(
        msg.type,
        requestId,
        metadata["approve"] || false,
        msg.from || "",
        msg.to || "",
      );
    }
  }
  return msgs;
}

function formatTeamEvents(msgs: BusMessage[]): string {
  const lines: string[] = [];
  for (const msg of msgs) {
    const metadata = msg.metadata || {};
    const requestId = metadata["request_id"];
    const suffix = requestId ? ` request_id=${requestId}` : "";
    lines.push(`[${msg.type}${suffix}] ${msg.from}: ${msg.content}`);
  }
  return "[Team events]\n" + lines.join("\n");
}

function _lastAssistantText(content: any): string {
  for (const block of content) {
    if (block?.type === "text") {
      return String(block.text).trim();
    }
    if (
      block !== null &&
      typeof block === "object" &&
      !Array.isArray(block) &&
      block["type"] === "text"
    ) {
      return String(block["text"] ?? "").trim();
    }
  }
  return "";
}

function currentWorkIdentity(owner: string): [number, string | null] {
  const assignment = teammateAssignments[owner];
  const taskId = assignment ? String(assignment.task_id) : null;
  return [assignmentVersions[owner] || 0, taskId];
}

function _teammateSubmitPlan(fromName: string, plan: string): string {
  const assignment = teammateAssignments[fromName];
  const taskId = assignment ? String(assignment.task_id) : null;
  const workVersion = assignmentVersions[fromName] || 0;
  if (planGates[fromName] === "pending") {
    return "A plan is already waiting for review.";
  }
  const requestId = newRequestId();
  pendingRequests[requestId] = makeProtocolState({
    request_id: requestId,
    type: "plan_approval",
    sender: fromName,
    target: "lead",
    status: "pending",
    payload: plan,
    work_version: workVersion,
    task_id: taskId,
  });
  planGates[fromName] = "pending";
  planRequestIds[fromName] = requestId;
  activeTeammates[fromName] = "waiting_approval";
  BUS.send(fromName, "lead", plan, "plan_approval_request", {
    request_id: requestId,
  });
  return `Plan submitted (${requestId}). Wait for Lead's decision.`;
}

function _runTeammateTool(
  name: string,
  block: any,
  handlers: Record<string, (...args: any[]) => any>,
): string {
  const gate = planGates[name] ?? "not_required";
  if (["bash", "write_file", "edit_file"].includes(block.name)) {
    if (gate !== "approved") {
      if (gate !== "not_required") {
        return (
          `Blocked: plan status is ${gate}. Submit or revise the ` +
          "plan and wait for approval before changing the workspace."
        );
      }
    }
    const blocked = checkPermission(block, false);
    if (blocked) {
      return blocked;
    }
  }
  const handler = handlers[block.name];
  if (!handler) {
    return `Unknown tool: ${block.name}`;
  }
  triggerHooks("PreToolUse", [block], true);
  let output: string;
  try {
    output = String(callHandler(handler, block.input));
  } catch (exc: any) {
    output = `Error: ${exc?.name ?? "Error"}: ${exc?.message ?? exc}`;
  }
  triggerHooks("PostToolUse", [block, output]);
  return output;
}

function applyPlanResponse(name: string, msg: BusMessage): [boolean, string] {
  // Apply only the Lead response for this teammate's current plan.
  const metadata = msg.metadata || {};
  const requestId = metadata["request_id"] || "";
  const [workVersion, taskId] = currentWorkIdentity(name);
  const state = pendingRequests[requestId];
  const expectedId = planRequestIds[name];
  const valid =
    msg.from === "lead" &&
    msg.to === name &&
    requestId === expectedId &&
    state !== undefined &&
    state.type === "plan_approval" &&
    state.sender === name &&
    state.target === "lead" &&
    state.work_version === workVersion &&
    state.task_id === taskId &&
    ["approved", "rejected"].includes(state.status) &&
    (metadata["approve"] || false) === (state.status === "approved");
  if (!valid) {
    return [false, "[Ignored plan response: request mismatch]"];
  }
  planGates[name] = state.status;
  activeTeammates[name] = "working";
  delete planRequestIds[name];
  const outcome = state.status;
  return [true, `[Plan ${outcome}] ${msg.content}`];
}

function applyShutdownRequest(name: string, msg: BusMessage): [boolean, string] {
  // Accept only a pending shutdown request sent by Lead to this teammate.
  const requestId = (msg.metadata || {})["request_id"] || "";
  const state = pendingRequests[requestId];
  const valid =
    msg.from === "lead" &&
    msg.to === name &&
    state !== undefined &&
    state.type === "shutdown" &&
    state.sender === "lead" &&
    state.target === name &&
    state.status === "pending" &&
    activeTeammates[name] !== "stopping";
  if (!valid) {
    return [false, "[Ignored shutdown request: request mismatch]"];
  }
  activeTeammates[name] = "stopping";
  return [true, requestId];
}

function _teammateSendMessage(fromName: string, to: string, content: string): string {
  if (to !== "lead" && !(to in activeTeammates)) {
    return `Agent '${to}' is not active`;
  }
  BUS.send(fromName, to, content);
  return `Sent to ${to}`;
}

// -- Idle Task Discovery --

const IDLE_SCAN_INTERVAL = 2.0;

function scanUnclaimedTasks(): Task[] {
  // Return ready tasks whose optional worktree binding is usable.
  const ready: Task[] = [];
  for (const task of listTasks()) {
    if (
      task.status !== "pending" ||
      task.owner !== null ||
      !canStart(task.id)
    ) {
      continue;
    }
    const [, error] = taskWorktreeCwd(task);
    if (!error) {
      ready.push(task);
    }
  }
  return ready;
}

function claimNextTask(name: string): Task | null {
  // Claim the first still-available task, never a second assignment.
  if (teammateAssignments[name] || _ownerInProgress(name)) {
    return null;
  }
  for (const task of scanUnclaimedTasks()) {
    const result = claimTask(task.id, name);
    if (result.startsWith("Claimed ")) {
      return loadTask(task.id);
    }
  }
  return null;
}

// -- Teammate Runtime --

class TeammateRuntime {
  // One persistent teammate with separate messages and WORK/IDLE phases.
  name: string;
  system: string;
  messages: Array<Record<string, any>>;
  handlers: Record<string, (...args: any[]) => any>;

  constructor(
    name: string,
    role: string,
    prompt: string,
    taskId: string | null,
    requirePlan: boolean,
  ) {
    this.name = name;
    this.system =
      `You are '${name}', a ${role}. Use tools to complete the assigned ` +
      "Task, then call complete_task and report a concise result. " +
      "If the first user message contains [Assigned task], that Task is " +
      "already claimed; do not call claim_task for it again. " +
      "When asked for a plan, call submit_plan and wait for approval " +
      "before bash or file changes. File and shell tools use the Task's " +
      "working directory; that directory is not a sandbox. The runtime " +
      "delivers your final text to Lead. Use send_message only for " +
      "intermediate coordination, and address the coordinator as 'lead'.";
    this.messages = [{ role: "user", content: prompt }];
    if (taskId) {
      const task = loadTask(taskId);
      const cwd = assignmentCwd(name);
      this.messages[0]["content"] +=
        `\n\n[Assigned task ${task.id}] ${task.subject}\n` +
        `${task.description}\nWork directory: ${cwd}`;
    }
    if (requirePlan) {
      this.messages[0]["content"] +=
        "\n\n[Plan required] Submit a plan and wait for Lead approval " +
        "before changing files or using bash.";
    }
    this.handlers = {
      bash: (command: string) => this.bash(command),
      read_file: (path_: string, limit: number | null = null) =>
        this.read(path_, limit),
      write_file: (path_: string, content: string) => this.write(path_, content),
      edit_file: (path_: string, oldText: string, newText: string) =>
        this.edit(path_, oldText, newText),
      glob: (pattern: string) => this.glob(pattern),
      send_message: (to: string, content: string) =>
        _teammateSendMessage(name, to, content),
      submit_plan: (plan: string) => _teammateSubmitPlan(name, plan),
      list_tasks: runListTasks,
      claim_task: (taskId_: string) => this.claim(taskId_),
      complete_task: (taskId_: string) => this.complete(taskId_),
    };
  }

  currentCwd(): [string | null, string | null] {
    if (!(this.name in teammateAssignments)) {
      return [null, "Error: Claim a Task before using workspace tools."];
    }
    try {
      return [assignmentCwd(this.name), null];
    } catch (exc: any) {
      return [null, `Error: Invalid task assignment: ${exc?.message ?? exc}`];
    }
  }

  bash(command: string): string {
    const [cwd, error] = this.currentCwd();
    return error || runBash(command, cwd);
  }

  read(path_: string, limit: number | null = null): string {
    const [cwd, error] = this.currentCwd();
    return error || runRead(path_, limit, cwd);
  }

  write(path_: string, content: string): string {
    const [cwd, error] = this.currentCwd();
    return error || runWrite(path_, content, cwd);
  }

  edit(path_: string, oldText: string, newText: string): string {
    const [cwd, error] = this.currentCwd();
    return error || runEdit(path_, oldText, newText, cwd);
  }

  glob(pattern: string): string {
    const [cwd, error] = this.currentCwd();
    return error || runGlob(pattern, cwd);
  }

  claim(taskId: string): string {
    try {
      return claimTask(taskId, this.name);
    } catch (exc: any) {
      if (exc instanceof ValueError) {
        return `Error: ${exc.message}`;
      }
      if (exc && exc.code === "ENOENT") {
        return `Error: Task ${taskId} not found`;
      }
      throw exc;
    }
  }

  complete(taskId: string): string {
    try {
      return completeTask(taskId, this.name);
    } catch (exc: any) {
      if (exc instanceof ValueError) {
        return `Error: ${exc.message}`;
      }
      if (exc && exc.code === "ENOENT") {
        return `Error: Task ${taskId} not found`;
      }
      throw exc;
    }
  }

  handleInbox(inbox: BusMessage[]): boolean {
    // Append work messages and return True for a valid shutdown.
    const workMessages: string[] = [];
    for (const msg of inbox) {
      const msgType = msg.type || "message";
      if (msgType === "shutdown_request") {
        const [accepted, notice] = applyShutdownRequest(this.name, msg);
        if (!accepted) {
          workMessages.push(notice);
          continue;
        }
        BUS.send(this.name, "lead", "Shutdown acknowledged.", "shutdown_response", {
          request_id: notice,
          approve: true,
        });
        return true;
      }
      if (msgType === "plan_approval_response") {
        const [, notice] = applyPlanResponse(this.name, msg);
        workMessages.push(notice);
        continue;
      }
      if (msgType === "plan_request") {
        workMessages.push(`[Plan required] ${msg.content}`);
        continue;
      }
      workMessages.push(`[Message from ${msg.from}] ${msg.content}`);
    }
    if (workMessages.length) {
      this.messages.push({ role: "user", content: workMessages.join("\n") });
    }
    return false;
  }

  work(): string {
    // Run one model turn. Return continue, idle, or stop.
    if (this.handleInbox(BUS.readInbox(this.name))) {
      return "stop";
    }
    activeTeammates[this.name] = "working";
    let response: any;
    try {
      response = client.messages.create({
        model: MODEL,
        system: this.system,
        messages: this.messages,
        tools: TEAMMATE_TOOLS,
        max_tokens: 8000,
      });
    } catch (exc: any) {
      BUS.send(this.name, "lead", `${exc?.name ?? "Error"}: ${exc?.message ?? exc}`, "error");
      return "stop";
    }

    this.messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason === "tool_use") {
      const results: Array<Record<string, any>> = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") {
          continue;
        }
        const output = _runTeammateTool(this.name, block, this.handlers);
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: output,
        });
      }
      this.messages.push({ role: "user", content: results });
      return "continue";
    }

    const summary = _lastAssistantText(response.content);
    const gate = planGates[this.name] ?? "not_required";
    if (gate !== "pending" && summary) {
      BUS.send(this.name, "lead", summary, "result");
    }
    if (gate === "pending") {
      activeTeammates[this.name] = "waiting_approval";
    } else {
      releaseCompletedAssignment(this.name);
      activeTeammates[this.name] = "idle";
      BUS.send(this.name, "lead", "Waiting for more work.", "idle_notification");
    }
    return "idle";
  }

  async waitForWork(): Promise<boolean> {
    // Wait for a message or atomically claim the next ready Task.
    while (true) {
      const inbox = await BUS.waitForMessages(this.name, IDLE_SCAN_INTERVAL);
      if (inbox.length) {
        const before = this.messages.length;
        if (this.handleInbox(inbox)) {
          return false;
        }
        if (this.messages.length > before) {
          return true;
        }
        continue;
      }

      const task = claimNextTask(this.name);
      if (!task) {
        continue;
      }
      const cwd = assignmentCwd(this.name);
      this.messages.push({
        role: "user",
        content:
          `[Auto-claimed task ${task.id}] ${task.subject}\n` +
          `${task.description}\nWork directory: ${cwd}`,
      });
      console.log(`  [idle] ${this.name} claimed ${task.id}: ${task.subject}`);
      return true;
    }
  }

  async run(): Promise<void> {
    try {
      let state = "continue";
      while (state !== "stop") {
        if (state === "idle" && !(await this.waitForWork())) {
          break;
        }
        state = this.work();
      }
    } catch (exc: any) {
      try {
        BUS.send(this.name, "lead", `${exc?.name ?? "Error"}: ${exc?.message ?? exc}`, "error");
      } catch {
        /* ignore */
      }
    } finally {
      try {
        releaseTeammateAssignment(this.name);
      } catch (exc: any) {
        try {
          BUS.send(
            this.name,
            "lead",
            `Assignment cleanup failed: ${exc?.name ?? "Error"}: ${exc?.message ?? exc}`,
            "error",
          );
        } catch {
          /* ignore */
        }
      }
      delete activeTeammates[this.name];
      delete planGates[this.name];
      delete planRequestIds[this.name];
      delete teammateThreads[this.name];
      console.log(`  [teammate] ${this.name} finished`);
    }
  }
}

// In Python teammates run on background threads; in Node this maps to detached
// async run() promises tracked by name.
const teammateThreads: Record<string, Promise<void>> = {};

function spawnTeammateThread(
  name: string,
  role: string,
  prompt: string,
  taskId: string | null = null,
  requirePlan = false,
): string {
  // Claim an initial Task, then start one persistent teammate.
  if (!isValidAgentName(name)) {
    return "Invalid teammate name: use 1-64 letters, digits, underscores, or dashes";
  }
  if (RESERVED_TEAMMATE_NAMES.has(name.toLowerCase())) {
    return `Invalid teammate name: '${name}' is reserved by the runtime`;
  }
  if (
    Object.keys(activeTeammates).some(
      (existing) => existing.toLowerCase() === name.toLowerCase(),
    )
  ) {
    return `Teammate '${name}' already exists`;
  }
  activeTeammates[name] = "working";
  planGates[name] = requirePlan ? "required" : "not_required";
  assignmentVersions[name] = 0;

  if (taskId) {
    let claimed: string;
    try {
      claimed = claimTask(taskId, name);
    } catch (exc: any) {
      claimed = `Error: ${exc?.message ?? exc}`;
    }
    if (!claimed.startsWith("Claimed ")) {
      delete activeTeammates[name];
      delete planGates[name];
      delete assignmentVersions[name];
      return `Cannot spawn teammate '${name}': ${claimed}`;
    }
  }

  const runtime = new TeammateRuntime(name, role, prompt, taskId, requirePlan);
  const thread = runtime.run();
  teammateThreads[name] = thread;
  console.log(`  [teammate] ${name} spawned as ${role}`);
  const assigned = taskId ? ` for ${taskId}` : " without an initial Task";
  return (
    `Teammate '${name}' spawned as ${role}${assigned}. ` +
    "End this turn; the runtime will deliver its events."
  );
}

// -- Lead Team Tools --

function runSpawnTeammate(
  name: string,
  role: string,
  prompt: string,
  taskId: string | null = null,
  requirePlan = false,
): string {
  return spawnTeammateThread(name, role, prompt, taskId, requirePlan);
}

function runListTeammates(): string {
  if (!Object.keys(activeTeammates).length) {
    return "No active teammates.";
  }
  return Object.entries(activeTeammates)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, status]) => `${name}: ${status}`)
    .join("\n");
}

function runSendMessage(to: string, content: string): string {
  if (!(to in activeTeammates)) {
    return `Teammate '${to}' is not active`;
  }
  BUS.send("lead", to, content);
  return `Sent to ${to}`;
}

function runRequestShutdown(teammate: string): string {
  if (!(teammate in activeTeammates)) {
    return `Teammate '${teammate}' is not active`;
  }
  const requestId = newRequestId();
  pendingRequests[requestId] = makeProtocolState({
    request_id: requestId,
    type: "shutdown",
    sender: "lead",
    target: teammate,
    status: "pending",
    payload: "",
  });
  BUS.send("lead", teammate, "Finish the current step and shut down.", "shutdown_request", {
    request_id: requestId,
  });
  return `Shutdown requested from ${teammate} (${requestId})`;
}

function runRequestPlan(teammate: string, task: string): string {
  if (!(teammate in activeTeammates)) {
    return `Teammate '${teammate}' is not active`;
  }
  planGates[teammate] = "required";
  BUS.send("lead", teammate, task, "plan_request");
  return `Plan requested from ${teammate}`;
}

function runReviewPlan(requestId: string, approve: boolean, feedback = ""): string {
  let state = pendingRequests[requestId];
  if (!state) {
    return `Request ${requestId} not found`;
  }
  const [workVersion, taskId] = currentWorkIdentity(state.sender);
  state = pendingRequests[requestId];
  if (!state) {
    return `Request ${requestId} not found`;
  }
  if (state.type !== "plan_approval") {
    return `Request ${requestId} is not a plan`;
  }
  if (state.status !== "pending") {
    return `Request ${requestId} already ${state.status}`;
  }
  if (state.work_version !== workVersion || state.task_id !== taskId) {
    return `Request ${requestId} belongs to an earlier assignment`;
  }
  if (planRequestIds[state.sender] !== requestId) {
    return `Request ${requestId} is not the current plan`;
  }
  state.status = approve ? "approved" : "rejected";
  const content =
    feedback || (approve ? "Plan approved." : "Revise the plan and submit it again.");
  BUS.send("lead", state.sender, content, "plan_approval_response", {
    request_id: requestId,
    approve,
  });
  return `Plan ${state.status} (${requestId})`;
}

function runCreateWorktree(name: string, taskId: string): string {
  return createWorktree(name, taskId);
}

// -- Tool Definitions --

const BASE_TOOLS = [
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
      properties: {
        path: { type: "string" },
        old_text: { type: "string" },
        new_text: { type: "string" },
      },
      required: ["path", "old_text", "new_text"],
    },
  },
  {
    name: "glob",
    description: "Find files by glob pattern.",
    input_schema: {
      type: "object",
      properties: { pattern: { type: "string" } },
      required: ["pattern"],
    },
  },
];

const TASK_TOOLS = [
  {
    name: "create_task",
    description: "Create a task with optional dependencies.",
    input_schema: {
      type: "object",
      properties: {
        subject: { type: "string" },
        description: { type: "string" },
        blockedBy: { type: "array", items: { type: "string" } },
      },
      required: ["subject"],
    },
  },
  {
    name: "list_tasks",
    description: "List shared tasks.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_task",
    description: "Get one task by ID.",
    input_schema: {
      type: "object",
      properties: { task_id: { type: "string" } },
      required: ["task_id"],
    },
  },
  {
    name: "claim_task",
    description: "Claim a ready task.",
    input_schema: {
      type: "object",
      properties: { task_id: { type: "string" } },
      required: ["task_id"],
    },
  },
  {
    name: "complete_task",
    description: "Complete an owned task.",
    input_schema: {
      type: "object",
      properties: { task_id: { type: "string" } },
      required: ["task_id"],
    },
  },
];

const TEAMMATE_TOOLS = [
  ...BASE_TOOLS,
  {
    name: "send_message",
    description: "Send an intermediate message to 'lead' or an active teammate.",
    input_schema: {
      type: "object",
      properties: { to: { type: "string" }, content: { type: "string" } },
      required: ["to", "content"],
    },
  },
  {
    name: "submit_plan",
    description: "Submit a work plan for Lead approval.",
    input_schema: {
      type: "object",
      properties: { plan: { type: "string" } },
      required: ["plan"],
    },
  },
  TASK_TOOLS.find((tool) => tool.name === "list_tasks")!,
  TASK_TOOLS.find((tool) => tool.name === "claim_task")!,
  TASK_TOOLS.find((tool) => tool.name === "complete_task")!,
];

const TEAM_TOOLS = [
  {
    name: "spawn_teammate",
    description: "Spawn a persistent teammate.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}$" },
        role: { type: "string" },
        prompt: { type: "string" },
        task_id: { type: "string", pattern: "^task_[0-9a-f]{8}$" },
        require_plan: { type: "boolean" },
      },
      required: ["name", "role", "prompt"],
    },
  },
  {
    name: "list_teammates",
    description: "List active teammates.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "send_message",
    description: "Message a teammate.",
    input_schema: {
      type: "object",
      properties: { to: { type: "string" }, content: { type: "string" } },
      required: ["to", "content"],
    },
  },
  {
    name: "request_shutdown",
    description: "Ask a teammate to shut down.",
    input_schema: {
      type: "object",
      properties: { teammate: { type: "string" } },
      required: ["teammate"],
    },
  },
  {
    name: "request_plan",
    description: "Require a teammate plan before workspace changes.",
    input_schema: {
      type: "object",
      properties: { teammate: { type: "string" }, task: { type: "string" } },
      required: ["teammate", "task"],
    },
  },
  {
    name: "review_plan",
    description: "Approve or reject a plan.",
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
    name: "create_worktree",
    description: "Create and bind a task worktree.",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          pattern: "^(?!.*\\.\\.)[A-Za-z0-9][A-Za-z0-9._-]{0,63}$",
          maxLength: 64,
        },
        task_id: { type: "string" },
      },
      required: ["name", "task_id"],
      additionalProperties: false,
    },
  },
];

const TOOLS = [...BASE_TOOLS, ...TASK_TOOLS, ...TEAM_TOOLS];

const TOOL_HANDLERS: Record<string, (...args: any[]) => any> = {
  bash: runAgentBash,
  read_file: runAgentRead,
  write_file: runAgentWrite,
  edit_file: runAgentEdit,
  glob: runAgentGlob,
  create_task: runCreateTask,
  list_tasks: runListTasks,
  get_task: runGetTask,
  claim_task: runClaimTask,
  complete_task: runCompleteTask,
  spawn_teammate: runSpawnTeammate,
  list_teammates: runListTeammates,
  send_message: runSendMessage,
  request_shutdown: runRequestShutdown,
  request_plan: runRequestPlan,
  review_plan: runReviewPlan,
  create_worktree: runCreateWorktree,
};

// -- Hooks and Permission Checks --

const HOOKS: Record<string, Array<(...args: any[]) => any>> = {
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

function triggerHooks(
  event: string,
  args: any[],
  skipPermission = false,
): any {
  for (const callback of HOOKS[event]) {
    if (skipPermission && callback === permissionHook) {
      continue;
    }
    const result = callback(...args);
    if (result !== null && result !== undefined) {
      return result;
    }
  }
  return null;
}

function checkPermission(block: any, promptUser = true): string | null {
  if (block.name === "bash") {
    const command = block.input["command"] ?? "";
    for (const pattern of DENY_LIST) {
      if (command.includes(pattern)) {
        return `Permission denied by deny list: ${pattern}`;
      }
    }
    if (DESTRUCTIVE.some((keyword) => command.includes(keyword))) {
      if (!promptUser) {
        return "Permission required: ask Lead to run this command.";
      }
      console.log(`\n[permission] ${block.name}(${JSON.stringify(block.input)})`);
      if (!["y", "yes"].includes(promptForInput("Allow? [y/N] ").trim().toLowerCase())) {
        return "Permission denied by user";
      }
    }
  }

  if (["read_file", "write_file", "edit_file"].includes(block.name)) {
    const rawPath = block.input["path"] ?? "";
    if (!isRelativeTo(path.resolve(path.join(WORKDIR, rawPath)), path.resolve(WORKDIR))) {
      if (!promptUser) {
        return "Permission required: path is outside the workspace.";
      }
      console.log(`\n[permission] ${block.name}(${JSON.stringify(block.input)})`);
      if (!["y", "yes"].includes(promptForInput("Allow? [y/N] ").trim().toLowerCase())) {
        return "Permission denied by user";
      }
    }
  }
  return null;
}

function permissionHook(block: any): string | null {
  return checkPermission(block, true);
}

function logHook(block: any): null {
  const preview = JSON.stringify(Object.values(block.input).slice(0, 2)).slice(0, 60);
  console.log(`[hook] ${block.name}(${preview})`);
  return null;
}

function largeOutputHook(block: any, output: any): null {
  if (String(output).length > 100000) {
    console.log(`[hook] Large output from ${block.name}: ${String(output).length} chars`);
  }
  return null;
}

function contextHook(_query: string): null {
  console.log(`[hook] UserPromptSubmit: working in ${WORKDIR}`);
  return null;
}

function summaryHook(messages: any[]): null {
  let toolCount = 0;
  for (const message of messages) {
    const content = Array.isArray(message["content"]) ? message["content"] : [];
    for (const block of content) {
      if (
        block !== null &&
        typeof block === "object" &&
        !Array.isArray(block) &&
        block["type"] === "tool_result"
      ) {
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

function executeTool(block: any): string {
  const blocked = triggerHooks("PreToolUse", [block]);
  if (blocked) {
    return String(blocked);
  }
  const handler = TOOL_HANDLERS[block.name];
  if (!handler) {
    return `Unknown tool: ${block.name}`;
  }
  let output: string;
  try {
    output = String(callHandler(handler, block.input));
  } catch (exc: any) {
    output = `Error: ${exc?.name ?? "Error"}: ${exc?.message ?? exc}`;
  }
  triggerHooks("PostToolUse", [block, output]);
  return output;
}

// -- Agent Loop --

function agentLoop(messages: any[]): void {
  while (true) {
    let response: any;
    try {
      response = client.messages.create({
        model: MODEL,
        system: SYSTEM,
        messages,
        tools: TOOLS,
        max_tokens: 8000,
      });
    } catch (exc: any) {
      messages.push({
        role: "assistant",
        content: [
          {
            type: "text",
            text: `[Error] ${exc?.name ?? "Error"}: ${exc?.message ?? exc}`,
          },
        ],
      });
      releaseCompletedAssignment("agent");
      triggerHooks("Stop", [messages]);
      return;
    }

    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") {
      releaseCompletedAssignment("agent");
      triggerHooks("Stop", [messages]);
      return;
    }

    const results: Array<Record<string, any>> = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") {
        continue;
      }
      console.log(`> ${block.name}`);
      const output = executeTool(block);
      console.log(output.slice(0, 300));
      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: output,
      });
    }
    messages.push({ role: "user", content: results });
  }
}

function printLastAssistantMessage(history: any[]): void {
  if (!history.length) {
    return;
  }
  for (const block of history[history.length - 1]["content"] || []) {
    if (block?.type === "text") {
      console.log(block.text);
    } else if (
      block !== null &&
      typeof block === "object" &&
      !Array.isArray(block) &&
      block["type"] === "text"
    ) {
      console.log(block["text"] ?? "");
    }
  }
}

// The original polls stdin + the mailbox in one select() loop. Node has no
// synchronous select(); the faithful structure is preserved as a helper that
// returns the next CLI event ("wake" for a team event, "user" for a line, or
// "quit").
async function waitForCliEvent(): Promise<["wake" | "user" | "quit", string | null]> {
  // Placeholder for the interactive select-based loop. See original comment.
  return ["quit", null];
}

async function mainCli(): Promise<void> {
  console.log("s13: agent teams");
  console.log("Enter a question, press Enter to send. Type q to quit.\n");
  const history: any[] = [];
  let hadTeammates = false;

  while (true) {
    const [kind, payload] = await waitForCliEvent();
    if (kind === "quit") {
      break;
    }
    if (kind === "user") {
      if (
        payload === null ||
        ["q", "exit", ""].includes(payload.trim().toLowerCase())
      ) {
        break;
      }
      triggerHooks("UserPromptSubmit", [payload]);
      history.push({ role: "user", content: payload });
    } else {
      const inbox = consumeLeadInbox();
      if (!inbox.length) {
        continue;
      }
      history.push({ role: "user", content: formatTeamEvents(inbox) });
      console.log(`[wake: ${inbox.length} team event(s) -> new turn]`);
    }

    agentLoop(history);
    printLastAssistantMessage(history);

    if (Object.keys(activeTeammates).length) {
      hadTeammates = true;
    } else if (hadTeammates && !BUS.peek("lead")) {
      console.log("[all teammates shut down]");
      hadTeammates = false;
    }
    console.log();
  }
}

// -- Helpers to model Python built-ins --

// Emulates Python's `ValueError`.
class ValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValueError";
  }
}

// Emulates Path.is_relative_to: is `target` inside `base`?
function isRelativeTo(target: string, base: string): boolean {
  const rel = path.relative(base, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// Recursive glob matcher standing in for Path.glob.
function globInDir(root: string, pattern: string): string[] {
  const results: string[] = [];
  const regex = new RegExp(
    "^" +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "\u0000")
        .replace(/\*/g, "[^/]*")
        .replace(/\u0000/g, ".*") +
      "$",
  );
  const walk = (dir: string, prefix: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (regex.test(rel)) {
        results.push(rel);
      }
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), rel);
      }
    }
  };
  walk(root, "");
  return results;
}

// Call a handler with a keyword-style input object. Python uses **block.input;
// here we spread the object's values in declaration order via the handler.
// For faithful behaviour handlers accept positional args matching the schema.
function callHandler(handler: (...args: any[]) => any, input: Record<string, any>): any {
  // The handlers above accept positional args; map common named params in order.
  // This mirrors Python's **kwargs expansion for the known tool signatures.
  const order: Record<string, string[]> = {
    // Best-effort ordering of known parameters.
  };
  void order;
  // Since our handlers are defined with positional params matching the schema
  // property order, spread the values in insertion order.
  return handler(...Object.values(input));
}

// Interactive line prompt placeholder (Python's input()).
function promptForInput(_message: string): string {
  // A live CLI would block for stdin here. Preserved for structure.
  return "";
}

if (require.main === module) {
  mainCli();
}
