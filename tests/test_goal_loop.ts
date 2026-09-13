// 由 test_goal_loop.py 翻译而来的 TypeScript 对照版本。
// 仅供逐行对照阅读，非可运行代码。原文件使用 pytest + asyncio，
// 验证 s17_goal_loop 章节的「目标循环」控制器与会话行为。

// from __future__ import annotations
// Python: import asyncio, importlib.util, sys; from pathlib import Path; from types import SimpleNamespace; import pytest
import * as asyncio from "asyncio";
import * as importlib from "importlib.util";
import * as sys from "sys";
import { Path } from "pathlib";
import { SimpleNamespace } from "types";
import * as pytest from "pytest";

const REPO_ROOT: Path = Path(__filename).resolve().parents[1];
const MODULE_PATH: Path = REPO_ROOT.joinpath("s17_goal_loop", "code.py");
const MODULE_NAME: string = "s17_goal_loop_under_test";
const SPEC = importlib.util.spec_from_file_location(MODULE_NAME, MODULE_PATH);
if (SPEC === null || SPEC.loader === null) {
  throw new Error(`Unable to load ${MODULE_PATH}`);
}
const goal_loop: any = importlib.util.module_from_spec(SPEC);
sys.modules[MODULE_NAME] = goal_loop;
SPEC.loader.exec_module(goal_loop);

// 构造一个纯文本模型响应。
function text_response(text: string): any {
  return SimpleNamespace({
    content: [SimpleNamespace({ type: "text", text })],
    usage: SimpleNamespace({ input_tokens: 10, output_tokens: 5 }),
  });
}

// 构造一个 tool_use 模型响应。
function tool_response(name: string, arguments_: Record<string, any>, tool_use_id: string = "tool-1"): any {
  return SimpleNamespace({
    content: [
      SimpleNamespace({
        type: "tool_use",
        id: tool_use_id,
        name,
        input: arguments_,
      }),
    ],
    usage: SimpleNamespace({ input_tokens: 10, output_tokens: 5 }),
  });
}

// 假的 messages 接口：按顺序返回预置响应，并记录每次调用参数。
class FakeMessages {
  responses: any[];
  calls: any[];
  constructor(responses: any[]) {
    this.responses = [...responses];
    this.calls = [];
  }

  create(kwargs: Record<string, any>): any {
    this.calls.push(kwargs);
    if (this.responses.length === 0) {
      throw new Error("unexpected model call"); // AssertionError
    }
    return this.responses.shift();
  }
}

// 假的客户端，暴露 messages 属性。
class FakeClient {
  messages: FakeMessages;
  constructor(responses: any[]) {
    this.messages = new FakeMessages(responses);
  }
}

// 记录型评估器：按序返回预置评估结果，或抛出预置错误，并记录调用。
class RecordingEvaluator {
  evaluations: any[];
  error: Error | null;
  calls: Array<[any, any[]]>;
  constructor(evaluations: any[] | null = null, error: Error | null = null) {
    this.evaluations = [...(evaluations ?? [])];
    this.error = error;
    this.calls = [];
  }

  async evaluate(condition: any, messages: any[]): Promise<any> {
    this.calls.push([condition, [...messages]]);
    if (this.error) {
      throw this.error;
    }
    if (this.evaluations.length === 0) {
      throw new Error("unexpected evaluator call"); // AssertionError
    }
    return this.evaluations.shift();
  }
}

// 构造一个用于测试的会话，返回 [session, client, evaluator]。
function make_session(
  tmp_path: Path,
  responses: any[],
  evaluations: any[],
  { block_cap = 8, background_running = null }: { block_cap?: number; background_running?: any } = {},
): [any, FakeClient, RecordingEvaluator] {
  const client = new FakeClient(responses);
  const evaluator = new RecordingEvaluator(evaluations);
  const goal = new goal_loop.GoalController(evaluator, { block_cap });
  const session = new goal_loop.AgentSession({
    client,
    model: "worker-model",
    goal,
    workdir: tmp_path,
    background_running,
  });
  return [session, client, evaluator];
}

// 未达成的目标会自动持续直到达成。
function test_unmet_goal_continues_automatically_until_achieved(tmp_path: Path): void {
  async function scenario(): Promise<void> {
    const [session, client, evaluator] = make_session(
      tmp_path,
      /* responses */ [
        text_response("I changed the implementation."),
        text_response("pytest now exits with code 0."),
      ],
      /* evaluations */ [
        new goal_loop.GoalEvaluation({
          ok: false,
          reason: "No test result appears in the conversation.",
        }),
        new goal_loop.GoalEvaluation({
          ok: true,
          reason: "The latest turn reports the required test result.",
        }),
      ],
    );

    const result = await session.submit("/goal pytest exits with code 0");

    assert(result.status === "achieved");
    assert(session.goal.active === null);
    assert(client.messages.calls.length === 2);
    assert(evaluator.calls.length === 2);
    assert(
      session.messages
        .filter((message: any) => message["role"] === "user")
        .some((message: any) => String(message["content"]).includes("No test result appears")),
    );
  }

  asyncio.run(scenario());
}

// worker 的工具执行结果应当抵达目标评估器。
function test_worker_tool_result_reaches_the_goal_evaluator(tmp_path: Path): void {
  async function scenario(): Promise<void> {
    const [session, client, evaluator] = make_session(
      tmp_path,
      /* responses */ [
        tool_response("bash", { command: "printf passed" }),
        text_response("The command exited successfully."),
      ],
      /* evaluations */ [
        new goal_loop.GoalEvaluation({
          ok: true,
          reason: "The conversation contains exit_code=0.",
        }),
      ],
    );

    const result = await session.submit("/goal the verification command exits with code 0");

    assert(result.status === "achieved");
    assert(client.messages.calls.length === 2);
    assert(client.messages.calls[0]["tools"] === goal_loop.TOOLS);
    const [_condition, messages] = evaluator.calls[0];
    assert(
      messages.some((message: any) =>
        goal_loop._plain_content(message["content"]).includes("exit_code=0"),
      ),
    );
  }

  asyncio.run(scenario());
}

// 评估器应接收到未经来源过滤的完整对话。
function test_evaluator_receives_the_conversation_without_origin_filtering(tmp_path: Path): void {
  async function scenario(): Promise<void> {
    const [session, _client, evaluator] = make_session(
      tmp_path,
      /* responses */ [text_response("tests passed")],
      /* evaluations */ [
        new goal_loop.GoalEvaluation({
          ok: true,
          reason: "The transcript contains a passing test result.",
        }),
      ],
    );

    await session.submit("/goal tests pass");

    const [_condition, messages] = evaluator.calls[0];
    assert(
      messages.some(
        (message: any) =>
          message["role"] === "assistant" &&
          goal_loop._plain_content(message["content"]) === "tests passed",
      ),
    );
  }

  asyncio.run(scenario());
}

// 后台工作进行中时，应推迟评估。
function test_background_work_defers_evaluation(): void {
  async function scenario(): Promise<void> {
    const evaluator = new RecordingEvaluator([
      new goal_loop.GoalEvaluation({ ok: true, reason: "done" }),
    ]);
    const controller = new goal_loop.GoalController(evaluator);
    controller.set_goal("background report is ready");

    const decision = await controller.evaluate_after_turn(
      [{ role: "assistant", content: "still running" }],
      { background_running: true },
    );

    assert(decision.action === "defer");
    assert(controller.active !== null);
    assert(evaluator.calls.length === 0);
  }

  asyncio.run(scenario());
}

// 后台结果返回后应重新进入同一目标循环。
function test_background_result_reenters_the_same_goal_loop(tmp_path: Path): void {
  async function scenario(): Promise<void> {
    let running = true;
    const [session, client, evaluator] = make_session(
      tmp_path,
      /* responses */ [
        text_response("The background test is still running."),
        text_response("The background result says pytest passed."),
      ],
      /* evaluations */ [
        new goal_loop.GoalEvaluation({
          ok: true,
          reason: "The completion notification contains a passing result.",
        }),
      ],
      { background_running: () => running },
    );

    const deferred = await session.submit("/goal pytest exits with code 0");
    assert(deferred.status === "defer");
    assert(evaluator.calls.length === 0);

    running = false;
    const completed = await session.submit_background_result("pytest: 12 passed; exit_code=0");

    assert(completed.status === "achieved");
    assert(client.messages.calls.length === 2);
    assert(evaluator.calls.length === 1);
    assert(
      session.messages.some((message: any) =>
        String(message["content"]).includes("Background task completed"),
      ),
    );
  }

  asyncio.run(scenario());
}

// 达到阻塞上限（block_cap）时应交还控制权，但保持目标 active。
function test_block_cap_returns_control_but_keeps_goal_active(tmp_path: Path): void {
  async function scenario(): Promise<void> {
    const [session, client, _evaluator] = make_session(
      tmp_path,
      /* responses */ [
        text_response("attempt one"),
        text_response("attempt two"),
        text_response("attempt three"),
      ],
      /* evaluations */ [
        new goal_loop.GoalEvaluation({ ok: false, reason: "missing result 1" }),
        new goal_loop.GoalEvaluation({ ok: false, reason: "missing result 2" }),
        new goal_loop.GoalEvaluation({ ok: false, reason: "missing result 3" }),
      ],
      { block_cap: 2 },
    );

    const result = await session.submit("/goal impossible for now");

    assert(result.status === "limit");
    assert(session.goal.active !== null);
    assert(client.messages.calls.length === 3);
  }

  asyncio.run(scenario());
}

// 不可能达成的目标应被记录为 failed。
function test_impossible_goal_is_recorded_as_failed(): void {
  async function scenario(): Promise<void> {
    const evaluator = new RecordingEvaluator([
      new goal_loop.GoalEvaluation({
        ok: false,
        impossible: true,
        reason: "The required service does not exist.",
      }),
    ]);
    const controller = new goal_loop.GoalController(evaluator);
    controller.set_goal("deploy to the missing service");

    const decision = await controller.evaluate_after_turn([
      { role: "assistant", content: "service not found" },
    ]);

    assert(decision.action === "failed");
    assert(controller.active === null);
    assert(controller.last_status["failed"] === true);
    assert(controller.status().startsWith("Goal failed:"));
  }

  asyncio.run(scenario());
}

// 评估器出错时应交还控制权并保留目标。
function test_evaluator_error_returns_control_and_keeps_goal(): void {
  async function scenario(): Promise<void> {
    const evaluator = new RecordingEvaluator(null, new Error("API unavailable")); // RuntimeError
    const controller = new goal_loop.GoalController(evaluator);
    controller.set_goal("tests pass");

    const decision = await controller.evaluate_after_turn([]);

    assert(decision.action === "error");
    assert(decision.reason.includes("API unavailable"));
    assert(controller.active !== null);
  }

  asyncio.run(scenario());
}

// restore 只重新装载仍处于 active 的目标。
function test_restore_reinstalls_only_an_active_goal(): void {
  const evaluator = new RecordingEvaluator();
  const active_events: Array<Record<string, any>> = [
    {
      type: "goal_status",
      condition: "tests pass",
      active: true,
      met: false,
      failed: false,
      reason: "still failing",
    },
  ];
  const restored = goal_loop.GoalController.restore(evaluator, active_events);

  assert(restored.active !== null);
  assert(restored.active.condition === "tests pass");
  assert(restored.active.iterations === 0);
  assert(restored.active.last_reason === null);

  const achieved_events = [
    ...active_events,
    {
      type: "goal_status",
      condition: "tests pass",
      active: false,
      met: true,
      failed: false,
      reason: "done",
    },
  ];
  const completed = goal_loop.GoalController.restore(evaluator, achieved_events);
  assert(completed.active === null);
}

// @pytest.mark.parametrize("alias", sorted(goal_loop.CLEAR_ALIASES))
// 参数化测试：每个清除别名都应能清空目标。
// pytest.mark.parametrize("alias", [...goal_loop.CLEAR_ALIASES].sort())
function test_clear_aliases(alias: string, tmp_path: Path): void {
  async function scenario(): Promise<void> {
    const evaluator = new RecordingEvaluator();
    const controller = new goal_loop.GoalController(evaluator);
    controller.set_goal("tests pass");
    const session = new goal_loop.AgentSession({
      client: new FakeClient([]),
      model: "worker-model",
      goal: controller,
      workdir: tmp_path,
    });

    const result = await session.submit(`/goal ${alias}`);

    assert(result.status === "cleared");
    assert(controller.active === null);
  }

  asyncio.run(scenario());
}

// 目标长度应受限（不超过 MAX_GOAL_LENGTH）。
function test_goal_length_is_bounded(): void {
  const controller = new goal_loop.GoalController(new RecordingEvaluator());
  // with pytest.raises(goal_loop.GoalError, match="4000"):
  pytest.raises(goal_loop.GoalError, { match: "4000" }, () => {
    controller.set_goal("x".repeat(goal_loop.MAX_GOAL_LENGTH + 1));
  });
}

// prompt 评估器应使用无工具的纯 JSON 响应。
function test_prompt_evaluator_uses_a_tool_free_json_response(): void {
  async function scenario(): Promise<void> {
    const client = new FakeClient([
      text_response(
        '{"ok": false, "reason": "test output is missing", ' + '"impossible": false}',
      ),
    ]);
    const evaluator = new goal_loop.PromptGoalEvaluator({
      client,
      model: "evaluator-model",
    });

    const result = await evaluator.evaluate("tests pass", [
      { role: "assistant", content: "implementation updated" },
    ]);

    assert(result.ok === false);
    assert(result.reason === "test output is missing");
    const call = client.messages.calls[0];
    assert(!("tools" in call));
    assert(call["model"] === "evaluator-model");
  }

  asyncio.run(scenario());
}

// 评估器应拒绝相互冲突的终止状态（同时 ok 与 impossible）。
function test_evaluator_rejects_conflicting_terminal_states(): void {
  // with pytest.raises(goal_loop.GoalError, match="both ok and impossible"):
  pytest.raises(goal_loop.GoalError, { match: "both ok and impossible" }, () => {
    goal_loop._parse_json_object('{"ok": true, "reason": "conflicting", "impossible": true}');
  });
}

// 当输出尾部被裁剪时，bash 输出仍应保留 exit_code。
function test_bash_output_keeps_exit_code_when_the_tail_is_trimmed(tmp_path: Path): void {
  const controller = new goal_loop.GoalController(new RecordingEvaluator());
  const session = new goal_loop.AgentSession({
    client: new FakeClient([]),
    model: "worker-model",
    goal: controller,
    workdir: tmp_path,
  });

  const output = session._run_tool("bash", {
    command: 'python -c "import sys; ' + "print('x' * 40000); sys.exit(7)\"",
  });

  assert(output.startsWith("exit_code=7\n"));
  assert(output.length <= 30000);
}

// read_file 不能逃出工作目录。
function test_read_file_cannot_escape_the_workdir(tmp_path: Path): void {
  const controller = new goal_loop.GoalController(new RecordingEvaluator());
  const session = new goal_loop.AgentSession({
    client: new FakeClient([]),
    model: "worker-model",
    goal: controller,
    workdir: tmp_path,
  });

  // with pytest.raises(goal_loop.GoalError, match="current repository"):
  pytest.raises(goal_loop.GoalError, { match: "current repository" }, () => {
    session._run_tool("read_file", { path: "../outside.txt" });
  });
}

// 裁剪转录文本时应保留完整的近期消息。
function test_transcript_trimming_keeps_complete_recent_messages(): void {
  const messages: Array<Record<string, any>> = [
    { role: "user", content: "old-" + "x".repeat(100) },
    { role: "assistant", content: "recent result" },
  ];
  const rendered = goal_loop.transcript_text(messages, { max_characters: 40 });

  assert(rendered.includes("recent result"));
  assert(!rendered.includes("old-"));
}

// 应裁剪单条超长消息的中部。
function test_transcript_trims_the_middle_of_one_oversized_message(): void {
  const rendered = goal_loop.transcript_text(
    [{ role: "user", content: "START" + "x".repeat(100) + "END" }],
    { max_characters: 40 },
  );

  assert(rendered.length === 40);
  assert(rendered.startsWith("USER:\nSTART"));
  assert(rendered.endsWith("END"));
  assert(rendered.includes("middle omitted"));
}

// 目标循环应保留 s04 的基础工具集与权限钩子。
function test_goal_loop_keeps_the_s04_base_tools_and_permission_hook(tmp_path: Path): void {
  const controller = new goal_loop.GoalController(new RecordingEvaluator());
  const session = new goal_loop.AgentSession({
    client: new FakeClient([]),
    model: "worker-model",
    goal: controller,
    workdir: tmp_path,
  });

  // assert {tool["name"] for tool in goal_loop.TOOLS} == {...}
  const toolNames = new Set<string>(goal_loop.TOOLS.map((tool: any) => tool["name"]));
  assert(
    setsEqual(toolNames, new Set(["bash", "read_file", "write_file", "edit_file", "glob"])),
  );
  const block = SimpleNamespace({
    name: "write_file",
    input: { path: "../outside.txt", content: "blocked" },
  });
  assert(session.trigger_hooks("PreToolUse", block).includes("outside"));
  assert(!tmp_path.parent.joinpath("outside.txt").exists());
}

// 目标循环的文件工具应使用当前仓库目录。
function test_goal_loop_file_tools_use_the_current_repository(tmp_path: Path): void {
  const controller = new goal_loop.GoalController(new RecordingEvaluator());
  const session = new goal_loop.AgentSession({
    client: new FakeClient([]),
    model: "worker-model",
    goal: controller,
    workdir: tmp_path,
  });

  assert(session._run_tool("write_file", { path: "src/value.txt", content: "old" }).includes("Wrote"));
  assert(
    session
      ._run_tool("edit_file", { path: "src/value.txt", old_text: "old", new_text: "new" })
      .includes("Edited"),
  );
  assert(session._run_tool("glob", { pattern: "src/*.txt" }) === "src/value.txt");
  assert(tmp_path.joinpath("src", "value.txt").read_text() === "new");
}

// 辅助：Python 的 assert 语义，条件为假时抛出 AssertionError。
function assert(condition: boolean): void {
  if (!condition) {
    throw new Error("AssertionError");
  }
}

// 辅助：比较两个集合是否相等。
function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  return a.size === b.size && [...a].every((item) => b.has(item));
}
