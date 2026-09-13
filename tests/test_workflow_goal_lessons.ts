// 由 test_workflow_goal_lessons.py 翻译而来的 TypeScript 对照版本。
// 仅供逐行对照阅读，非可运行代码。原文件使用 pytest + asyncio，
// 验证 s16_workflow_runtime 章节的工作流运行时（日志/预算/断点续跑/锁/工具适配器等）。

// from __future__ import annotations
// Python: import asyncio, importlib.util, json, multiprocessing, shutil, subprocess, sys, threading, types; from pathlib import Path; import pytest
import * as asyncio from "asyncio";
import * as importlib from "importlib.util";
import * as json from "json";
import * as multiprocessing from "multiprocessing";
import * as shutil from "shutil";
import * as subprocess from "subprocess";
import * as sys from "sys";
import * as threading from "threading";
import * as types from "types";
import { Path } from "pathlib";
import * as pytest from "pytest";

const ROOT: Path = Path(__filename).resolve().parents[1];

// 从指定脚本路径加载一个课程模块。
function load_lesson(name: string, script: Path): any {
  const spec = importlib.util.spec_from_file_location(name, script);
  if (spec === null || spec.loader === null) {
    throw new Error(`unable to load ${script}`);
  }
  const module = importlib.util.module_from_spec(spec);
  spec.loader.exec_module(module);
  return module;
}

// 在子进程中获取 workflow 运行锁（用于跨进程锁测试）。
function acquire_workflow_lock_in_child(
  script: string,
  store: string,
  run_id: string,
  results: any,
): void {
  const workflow = load_lesson("workflow_lock_child", Path(script));
  workflow.STORE = Path(store);
  try {
    // with workflow.workflow_run_lock(run_id):
    workflow.workflow_run_lock(run_id, () => {
      results.put("acquired");
    });
  } catch (exc: any) {
    // except workflow.WorkflowInputError as exc:
    if (exc instanceof workflow.WorkflowInputError) {
      results.put(String(exc));
    } else {
      throw exc;
    }
  }
}

// 以子进程方式运行课程脚本，返回其 stdout。
function run_lesson(script: Path, ...args: string[]): string {
  const result = subprocess.run(
    [sys.executable, String(script), ...args],
    {
      cwd: script.parent,
      check: true,
      capture_output: true,
      text: true,
      timeout: 30,
    },
  );
  return result.stdout;
}

// 工作流运行时应能从 journal 断点续跑。
function test_workflow_runtime_resumes_from_journal(tmp_path: Path): void {
  const script = tmp_path.joinpath("code.py");
  shutil.copy2(ROOT.joinpath("s16_workflow_runtime", "code.py"), script);

  const first = run_lesson(script, "demo");
  const resumed = run_lesson(script, "resume");

  assert(first.includes("status=completed"));
  assert(first.includes("async_launched"));
  assert(resumed.includes("status=cached"));
  assert(resumed.includes("status=completed  agents=0  tokens=0"));
}

// 工作流运行时应拒绝不安全的 artifact 名称。
function test_workflow_runtime_rejects_unsafe_artifact_names(): void {
  const workflow = load_lesson("workflow_name_test", ROOT.joinpath("s16_workflow_runtime", "code.py"));

  for (const name of ["../escape", "../../escape", "nested/name"]) {
    // with pytest.raises(workflow.WorkflowInputError):
    pytest.raises(workflow.WorkflowInputError, () => {
      workflow.validate_meta({ name, description: "unsafe" });
    });
  }

  const severity = workflow.FINDINGS_SCHEMA["properties"]["findings"]["items"]["properties"]["severity"];
  const validator = new workflow.SimpleJsonSchema(severity);
  assert(arraysEqual(validator.validate("high"), [true, null]));
  assert(validator.validate("warning")[0] === false);
}

// 工作流运行时应强制执行预算与共享 agent 上限。
function test_workflow_runtime_enforces_budget_and_shared_agent_cap(
  tmp_path: Path,
  monkeypatch: any,
): void {
  const workflow = load_lesson("workflow_limit_test", ROOT.joinpath("s16_workflow_runtime", "code.py"));
  const budget = new workflow.Budget({ total: 1 });
  pytest.raises(workflow.WorkflowInputError, () => {
    budget.add(2);
  });
  assert(budget.spent() === 0);

  const journal = new workflow.WorkflowJournal("wf_limit-test_0001", { resume: false, store: tmp_path });
  const task = new workflow.LocalWorkflowTask("task", "wf_limit-test_0001", {});
  const state = new workflow.ExecutionState(task, journal, new workflow.MockAgentRunner(), new workflow.Budget(), {});

  async function child(child_state: any, _args: any): Promise<any> {
    return await child_state.agent("second call");
  }

  monkeypatch.setattr(workflow, "AGENT_CAP", 1);
  monkeypatch.setitem(workflow.WORKFLOWS, "limit-child", [
    { name: "limit-child", description: "test" },
    child,
  ]);

  async function run(): Promise<void> {
    await state.agent("first call");
    // with pytest.raises(workflow.WorkflowInputError):
    await pytest.raisesAsync(workflow.WorkflowInputError, async () => {
      await state.workflow("limit-child");
    });

    async function fail_stage(_value: any, _item: any, _index: any): Promise<void> {
      throw new Error("stage failed"); // RuntimeError
    }

    // with pytest.raises(RuntimeError, match="stage failed"):
    await pytest.raisesAsync(Error, { match: "stage failed" }, async () => {
      await state.pipeline(["item"], fail_stage);
    });
  }

  try {
    asyncio.run(run());
  } finally {
    journal.close();
  }
}

// 断点续跑时应拒绝损坏的 journal。
function test_workflow_runtime_rejects_corrupt_resume_journal(tmp_path: Path): void {
  const workflow = load_lesson("workflow_journal_test", ROOT.joinpath("s16_workflow_runtime", "code.py"));
  const run_id = "wf_corrupt_0001";
  tmp_path.joinpath(`${run_id}.journal.jsonl`).write_text("{not-json}\n");

  // with pytest.raises(workflow.WorkflowInputError, match="line 1"):
  pytest.raises(workflow.WorkflowInputError, { match: "line 1" }, () => {
    new workflow.WorkflowJournal(run_id, { resume: true, store: tmp_path });
  });
}

// 工作流工具适配器应使用注册表并返回 JSON。
function test_workflow_tool_adapter_uses_registry_and_returns_json(
  tmp_path: Path,
  monkeypatch: any,
): void {
  const workflow = load_lesson("workflow_adapter_test", ROOT.joinpath("s16_workflow_runtime", "code.py"));
  monkeypatch.setattr(workflow, "STORE", tmp_path);

  const result = asyncio.run(
    workflow.WORKFLOW_HANDLERS["Workflow"]({ name: "review-changes", args: { budget: null } }),
  );

  assert(arraysEqual(workflow.WORKFLOW_TOOL["input_schema"]["required"], ["name"]));
  assert(result["launched"]["workflowName"] === "review-changes");
  assert(result["task"]["status"] === "completed");
  assert(result["task"]["taskType"] === "local_workflow");
  assert(result["result"]["confirmed"].length === 5);
  const snapshot = json.loads(tmp_path.joinpath(`${result["task"]["runId"]}.json`).read_text());
  assert(snapshot["workflowName"] === "review-changes");
  assert(objectsEqual(snapshot["args"], { budget: null }));
  assert(snapshot["task"]["status"] === "completed");

  json.dumps(result);
}

// 全新工作流运行应具有唯一身份，断点续跑应校验参数一致。
function test_fresh_workflow_runs_have_unique_identity_and_resume_validates_args(
  tmp_path: Path,
  monkeypatch: any,
): void {
  const workflow = load_lesson("workflow_identity_test", ROOT.joinpath("s16_workflow_runtime", "code.py"));
  monkeypatch.setattr(workflow, "STORE", tmp_path);

  const first = asyncio.run(workflow.run_workflow("review-changes", { budget: null }));
  const second = asyncio.run(workflow.run_workflow("review-changes", { budget: null }));

  assert(first["task"]["runId"] !== second["task"]["runId"]);
  assert(first["task"]["taskId"] !== second["task"]["taskId"]);
  // with pytest.raises(workflow.WorkflowInputError, match="args do not match"):
  pytest.raises(workflow.WorkflowInputError, { match: "args do not match" }, () => {
    asyncio.run(
      workflow.run_workflow("review-changes", { budget: 1 }, { resume_from_run_id: first["task"]["runId"] }),
    );
  });
}

// 全新运行应拒绝已存在的身份标识。
function test_fresh_workflow_run_refuses_an_existing_identity(
  tmp_path: Path,
  monkeypatch: any,
): void {
  const workflow = load_lesson("workflow_collision_test", ROOT.joinpath("s16_workflow_runtime", "code.py"));
  monkeypatch.setattr(workflow, "STORE", tmp_path);
  const fixed_id = "wf_review-changes_0000000000001a7b";
  monkeypatch.setattr(workflow, "create_run_id", (_meta: any) => fixed_id);

  const first = asyncio.run(workflow.run_workflow("review-changes", { budget: null }));
  const first_snapshot = tmp_path.joinpath(`${fixed_id}.json`).read_text();
  const first_output = tmp_path.joinpath(`${fixed_id}.output.json`).read_text();

  // with pytest.raises(workflow.WorkflowInputError, match="unique workflow runId"):
  pytest.raises(workflow.WorkflowInputError, { match: "unique workflow runId" }, () => {
    asyncio.run(workflow.run_workflow("review-changes", { budget: null }));
  });

  assert(first["task"]["runId"] === fixed_id);
  assert(tmp_path.joinpath(`${fixed_id}.json`).read_text() === first_snapshot);
  assert(tmp_path.joinpath(`${fixed_id}.output.json`).read_text() === first_output);
}

// 无效的续跑不应覆盖已完成的 artifacts。
function test_invalid_resume_does_not_overwrite_completed_artifacts(
  tmp_path: Path,
  monkeypatch: any,
): void {
  const workflow = load_lesson("workflow_resume_guard_test", ROOT.joinpath("s16_workflow_runtime", "code.py"));
  monkeypatch.setattr(workflow, "STORE", tmp_path);
  const result = asyncio.run(workflow.run_workflow("review-changes", { budget: null }));
  const run_id = result["task"]["runId"];
  const snapshot_path = tmp_path.joinpath(`${run_id}.json`);
  const output_path = tmp_path.joinpath(`${run_id}.output.json`);
  const journal_path = tmp_path.joinpath(`${run_id}.journal.jsonl`);
  const snapshot = snapshot_path.read_text();
  const output = output_path.read_text();
  journal_path.write_text("not-json\n");

  // with pytest.raises(workflow.WorkflowInputError, match="invalid resume journal"):
  pytest.raises(workflow.WorkflowInputError, { match: "invalid resume journal" }, () => {
    asyncio.run(workflow.run_workflow("review-changes", { resume_from_run_id: run_id }));
  });

  assert(snapshot_path.read_text() === snapshot);
  assert(output_path.read_text() === output);
}

// 活跃中的运行应拒绝并发的续跑。
function test_active_workflow_run_rejects_concurrent_resume(
  tmp_path: Path,
  monkeypatch: any,
): void {
  const workflow = load_lesson("workflow_active_run_test", ROOT.joinpath("s16_workflow_runtime", "code.py"));
  monkeypatch.setattr(workflow, "STORE", tmp_path);
  const run_id = "wf_slow-test_0000000000001a7b";
  monkeypatch.setattr(workflow, "create_run_id", (_meta: any) => run_id);
  const started = new asyncio.Event();
  const release = new asyncio.Event();
  const meta = { name: "slow-test", description: "hold the run open" };

  async function slow_workflow(_ctx: any, _args: any): Promise<any> {
    started.set();
    await release.wait();
    return { invocation: 1 };
  }

  async function exercise(): Promise<any> {
    const first = asyncio.create_task(new workflow.WorkflowTool().call(meta, slow_workflow));
    await started.wait();
    try {
      // with pytest.raises(workflow.WorkflowInputError, match="already active"):
      await pytest.raisesAsync(workflow.WorkflowInputError, { match: "already active" }, async () => {
        await new workflow.WorkflowTool().call(meta, slow_workflow, { resume_from_run_id: run_id });
      });
    } finally {
      release.set();
    }
    return await first;
  }

  const result = asyncio.run(exercise());

  assert(objectsEqual(result["result"], { invocation: 1 }));
  assert(objectsEqual(json.loads(tmp_path.joinpath(`${run_id}.output.json`).read_text()), { invocation: 1 }));
}

// 运行锁应是跨进程有效的。
function test_workflow_run_lock_is_cross_process(tmp_path: Path): void {
  const workflow = load_lesson("workflow_process_lock_test", ROOT.joinpath("s16_workflow_runtime", "code.py"));
  workflow.STORE = tmp_path;
  const run_id = "wf_process-lock_0000000000001a7b";
  const context = multiprocessing.get_context("spawn");
  const results = context.Queue();

  // with workflow.workflow_run_lock(run_id):
  let child: any;
  workflow.workflow_run_lock(run_id, () => {
    child = context.Process({
      target: acquire_workflow_lock_in_child,
      args: [String(ROOT.joinpath("s16_workflow_runtime", "code.py")), String(tmp_path), run_id, results],
    });
    child.start();
    child.join(5);
  });

  assert(child.exitcode === 0);
  assert(results.get({ timeout: 1 }).includes("already active"));
}

// 工作流工具应扩展 s15 集成宿主的工具池。
function test_workflow_tool_extends_the_integrated_host_pool(): void {
  const workflow = load_lesson("workflow_host_test", ROOT.joinpath("s16_workflow_runtime", "code.py"));
  const host = types.SimpleNamespace({
    assemble_tool_pool: (): [any[], Record<string, any>] => [
      [{ name: "bash", input_schema: {} }],
      { bash: (..._: any[]) => "ok" },
    ],
  });

  workflow.install_workflow_tool(host);
  const [tools, handlers] = host.assemble_tool_pool();

  assert(arraysEqual(tools.map((tool: any) => tool["name"]), ["bash", "Workflow"]));
  assert(handlers["Workflow"] === workflow.run_workflow_sync);
}

// Anthropic runner 应解析 JSON 并记录真实用量。
function test_anthropic_runner_parses_json_and_records_real_usage(): void {
  const workflow = load_lesson("workflow_real_runner_test", ROOT.joinpath("s16_workflow_runtime", "code.py"));
  const calls: any[] = [];

  function create(kwargs: Record<string, any>): any {
    calls.push(kwargs);
    return types.SimpleNamespace({
      content: [types.SimpleNamespace({ type: "text", text: '```json\n{"ok": true}\n```' })],
      usage: types.SimpleNamespace({ input_tokens: 11, output_tokens: 7 }),
    });
  }

  const client = types.SimpleNamespace({ messages: types.SimpleNamespace({ create }) });
  const runner = new workflow.AnthropicAgentRunner(client, "deepseek-v4-flash");

  const result = runner.run("Check the supplied change.", {
    schema: {
      type: "object",
      required: ["ok"],
      properties: { ok: { type: "boolean" } },
    },
    label: "check",
  });

  assert(objectsEqual(result.value, { ok: true }));
  assert(result.tokens === 18);
  assert(calls[0]["model"] === "deepseek-v4-flash");
  assert(!("tools" in calls[0]));
}

// 真实 runner 遇到无效 JSON 后应重试一次。
function test_real_runner_output_retries_once_after_invalid_json(tmp_path: Path): void {
  const workflow = load_lesson(
    "workflow_real_runner_retry_test",
    ROOT.joinpath("s16_workflow_runtime", "code.py"),
  );
  const responses = iter([
    types.SimpleNamespace({
      content: [types.SimpleNamespace({ type: "text", text: "not json" })],
      usage: types.SimpleNamespace({ input_tokens: 3, output_tokens: 2 }),
    }),
    types.SimpleNamespace({
      content: [types.SimpleNamespace({ type: "text", text: 'Result:\n```json\n{"ok": true}\n```\nDone.' })],
      usage: types.SimpleNamespace({ input_tokens: 4, output_tokens: 3 }),
    }),
  ]);
  const client = types.SimpleNamespace({
    messages: types.SimpleNamespace({ create: (_kwargs: any) => next(responses) }),
  });
  const runner = new workflow.AnthropicAgentRunner(client, "test-model");
  const journal = new workflow.WorkflowJournal("wf_json-retry_0001", { resume: false, store: tmp_path });
  const task = new workflow.LocalWorkflowTask("task", "wf_json-retry_0001", {});
  const state = new workflow.ExecutionState(task, journal, runner, new workflow.Budget(), {});

  let result: any;
  try {
    result = asyncio.run(
      state.agent("Return a result.", {
        schema: {
          type: "object",
          required: ["ok"],
          properties: { ok: { type: "boolean" } },
        },
        label: "json-retry",
      }),
    );
  } finally {
    journal.close();
  }

  assert(objectsEqual(result, { ok: true }));
  assert(objectsEqual(task.usage, { agents: 1, tokens: 12 }));
}

// install_workflow_tool 应选择宿主的 API runner。
function test_install_workflow_tool_selects_the_host_api_runner(): void {
  const workflow = load_lesson(
    "workflow_runner_factory_test",
    ROOT.joinpath("s16_workflow_runtime", "code.py"),
  );
  const client = new Object();
  const host = types.SimpleNamespace({
    client,
    MODEL: "deepseek-v4-flash",
    assemble_tool_pool: (): [any[], Record<string, any>] => [[], {}],
  });

  workflow.install_workflow_tool(host);
  const runner = workflow.RUNNER_FACTORY();

  assert(runner instanceof workflow.AnthropicAgentRunner);
  assert(runner.client === client);
  assert(runner.model === "deepseek-v4-flash");
}

// 并行 agent 调用不应阻塞事件循环。
function test_parallel_agent_calls_do_not_block_the_event_loop(tmp_path: Path): void {
  const workflow = load_lesson(
    "workflow_parallel_runner_test",
    ROOT.joinpath("s16_workflow_runtime", "code.py"),
  );
  const barrier = new threading.Barrier(2);

  class BarrierRunner {
    run(prompt: any, schema: any = null, label: any = null): any {
      barrier.wait({ timeout: 2 });
      return new workflow.RunnerOutput({ label }, 1);
    }
  }

  const journal = new workflow.WorkflowJournal("wf_parallel-test_0001", { resume: false, store: tmp_path });
  const task = new workflow.LocalWorkflowTask("task", "wf_parallel-test_0001", {});
  const state = new workflow.ExecutionState(task, journal, new BarrierRunner(), new workflow.Budget(), {});

  async function run(): Promise<any> {
    return await state.parallel([
      () => state.agent("first", { label: "first" }),
      () => state.agent("second", { label: "second" }),
    ]);
  }

  let result: any;
  try {
    result = asyncio.run(run());
  } finally {
    journal.close();
  }

  assert(arraysEqual(result, [{ label: "first" }, { label: "second" }]));
  assert(objectsEqual(task.usage, { agents: 2, tokens: 2 }));
}

// Workflow 的默认入口应扩展真实的 s15 宿主。
function test_workflow_default_entry_extends_the_real_s15_host(
  tmp_path: Path,
  monkeypatch: any,
): void {
  monkeypatch.chdir(tmp_path);
  monkeypatch.setenv("MODEL_ID", "test-model");
  const workflow = load_lesson("workflow_real_host_test", ROOT.joinpath("s16_workflow_runtime", "code.py"));
  const host = workflow.load_integrated_host();

  workflow.install_workflow_tool(host);
  const [tools, handlers] = host.assemble_tool_pool();
  const names = tools.map((tool: any) => tool["name"]);

  assert(host.BUILTIN_TOOLS.length === 25);
  assert(arraysEqual(names.slice(0, -1), host.BUILTIN_TOOLS.map((tool: any) => tool["name"])));
  assert(names[names.length - 1] === "Workflow");
  assert(handlers["Workflow"] === workflow.run_workflow_sync);
  assert(handlers["Workflow"]({ name: "missing" }) === "Error: unknown workflow 'missing'");
}

// 工作流工具适配器应拒绝模型提供的代码（不接受 script/description 字段）。
function test_workflow_tool_adapter_rejects_model_supplied_code(): void {
  const workflow = load_lesson("workflow_schema_test", ROOT.joinpath("s16_workflow_runtime", "code.py"));
  const properties = workflow.WORKFLOW_TOOL["input_schema"]["properties"];

  assert(setsEqual(new Set(Object.keys(properties)), new Set(["name", "args", "resume_from_run_id"])));
  assert(!("description" in properties));
  assert(!("script" in properties));
  // with pytest.raises(workflow.WorkflowInputError, match="name must be a string"):
  pytest.raises(workflow.WorkflowInputError, { match: "name must be a string" }, () => {
    asyncio.run(workflow.run_workflow({ name: "review-changes" }));
  });
  // with pytest.raises(workflow.WorkflowInputError, match="unknown workflow"):
  pytest.raises(workflow.WorkflowInputError, { match: "unknown workflow" }, () => {
    asyncio.run(workflow.run_workflow("missing"));
  });
}

// ------- 辅助函数（对照可读性用） -------

// Python 的 assert 语义。
function assert(condition: boolean): void {
  if (!condition) {
    throw new Error("AssertionError");
  }
}

// 集合相等比较。
function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  return a.size === b.size && [...a].every((item) => b.has(item));
}

// 数组浅相等比较。
function arraysEqual(a: any[], b: any[]): boolean {
  return a.length === b.length && a.every((item, index) => objectsEqual(item, b[index]));
}

// 对象/值深相等比较（简化版）。
function objectsEqual(a: any, b: any): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Python iter(...) 的占位实现。
function iter(items: any[]): { items: any[]; index: number } {
  return { items, index: 0 };
}

// Python next(...) 的占位实现。
function next(iterator: { items: any[]; index: number }): any {
  return iterator.items[iterator.index++];
}
