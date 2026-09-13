// 由 test_agent_teams_runtime.py 翻译而来的 TypeScript 对照版本。
// 仅供逐行对照阅读，非可运行代码。原文件使用 Python unittest，
// 验证 s13_agent_teams（及其下游 s14/s15）章节的「多智能体团队」运行时契约：
// 任务领取、收件箱投递、worktree、计划门禁、关闭协议、后台任务、cron 等。

// Python: import importlib.util, multiprocessing, os, shlex, subprocess, sys, tempfile, threading, time, types, unittest
// from pathlib import Path; from unittest.mock import patch
import * as importlib from "importlib.util";
import * as multiprocessing from "multiprocessing";
import * as os from "os";
import * as shlex from "shlex";
import * as subprocess from "subprocess";
import * as sys from "sys";
import * as tempfile from "tempfile";
import * as threading from "threading";
import * as time from "time";
import * as types from "types";
import * as unittest from "unittest";
import { Path } from "pathlib";
import { patch } from "unittest.mock";

const ROOT: Path = Path(__filename).resolve().parents[1];
const LESSON: Path = ROOT.joinpath("s13_agent_teams", "code.py");
const DOWNSTREAM_LESSONS: Path[] = [ROOT.joinpath("s15_integrated_harness", "code.py")];
const RUNTIME_LESSONS: Path[] = [LESSON, ...DOWNSTREAM_LESSONS];
const MCP_LESSONS: Path[] = [
  ROOT.joinpath("s14_mcp_plugin", "code.py"),
  ROOT.joinpath("s15_integrated_harness", "code.py"),
];
const BACKGROUND_LESSONS: Path[] = ["s11_background_tasks", "s15_integrated_harness"].map((name) =>
  ROOT.joinpath(name, "code.py"),
);
const CRON_LESSONS: Path[] = ["s12_cron_scheduler", "s15_integrated_harness"].map((name) =>
  ROOT.joinpath(name, "code.py"),
);

// 在指定临时工作目录下加载课程模块，临时替换 anthropic / dotenv / yaml 模块及环境变量，完成后恢复。
function load_lesson(temp_cwd: Path, lesson_path: Path = LESSON): any {
  const fake_anthropic = types.ModuleType("anthropic");
  const fake_yaml = types.ModuleType("yaml");

  class FakeAnthropic {
    messages: any;
    constructor(..._args: any[]) {
      this.messages = types.SimpleNamespace({ create: null });
    }
  }

  const fake_dotenv = types.ModuleType("dotenv");
  (fake_anthropic as any).Anthropic = FakeAnthropic;
  (fake_dotenv as any).load_dotenv = (override: boolean = true): null => null;
  (fake_yaml as any).safe_load = (value: any): Record<string, any> => ({});
  (fake_yaml as any).YAMLError = Error; // ValueError

  const previous_modules: Record<string, any> = {
    anthropic: sys.modules.get("anthropic"),
    dotenv: sys.modules.get("dotenv"),
    yaml: sys.modules.get("yaml"),
  };
  const previous_cwd = Path.cwd();
  const previous_model = os.environ.get("MODEL_ID");

  const name = `agent_teams_test_${lesson_path.parent.name}_${time.time_ns()}`;
  const spec = importlib.util.spec_from_file_location(name, lesson_path);
  if (spec === null || spec.loader === null) {
    throw new Error(`Unable to load ${lesson_path}`);
  }
  const module = importlib.util.module_from_spec(spec);

  sys.modules["anthropic"] = fake_anthropic;
  sys.modules["dotenv"] = fake_dotenv;
  sys.modules["yaml"] = fake_yaml;
  sys.modules[name] = module;
  try {
    os.chdir(temp_cwd);
    os.environ["MODEL_ID"] = "test-model";
    spec.loader.exec_module(module);
    return module;
  } finally {
    os.chdir(previous_cwd);
    if (previous_model === null || previous_model === undefined) {
      os.environ.pop("MODEL_ID", null);
    } else {
      os.environ["MODEL_ID"] = previous_model;
    }
    for (const [module_name, previous] of Object.entries(previous_modules)) {
      if (previous === null || previous === undefined) {
        sys.modules.pop(module_name, null);
      } else {
        sys.modules[module_name] = previous;
      }
    }
  }
}

// 轮询等待某条件成立，超时返回 false。
function wait_until(predicate: () => any, timeout: number = 2.0): boolean {
  const deadline = time.monotonic() + timeout;
  while (time.monotonic() < deadline) {
    if (predicate()) {
      return true;
    }
    time.sleep(0.01);
  }
  return false;
}

// 在给定目录初始化一个 git 仓库并做一次初始提交。
function init_git_repo(root: Path): void {
  subprocess.run(["git", "init", "-q", "-b", "main"], { cwd: root, check: true });
  subprocess.run(["git", "config", "user.email", "tests@example.com"], { cwd: root, check: true });
  subprocess.run(["git", "config", "user.name", "Runtime Tests"], { cwd: root, check: true });
  root.joinpath("tracked.txt").write_text("initial\n");
  subprocess.run(["git", "add", "tracked.txt"], { cwd: root, check: true });
  subprocess.run(["git", "commit", "-q", "-m", "initial"], { cwd: root, check: true });
}

// 在子进程中领取任务（用于跨进程原子领取测试）。
function claim_in_child(
  lesson_path: string,
  root: string,
  task_id: string,
  owner: string,
  barrier: any,
  results: any,
): void {
  const lesson = load_lesson(Path(root), Path(lesson_path));
  barrier.wait();
  results.put(lesson.claim_task(task_id, { owner }));
}

// class AgentTeamsRuntimeTests(unittest.TestCase)
class AgentTeamsRuntimeTests extends unittest.TestCase {
  // 下游课程应执行合并后的运行时契约。
  test_downstream_lessons_execute_the_merged_runtime_contract(): void {
    for (const lesson_path of RUNTIME_LESSONS) {
      this.subTest({ lesson: lesson_path.parent.name });
      tempfile.TemporaryDirectory((tmp: string) => {
        const lesson = load_lesson(Path(tmp), lesson_path);
        const task = lesson.create_task("Runtime contract");
        this.assertIn("Claimed", lesson.claim_task(task.id, { owner: "alice" }));
        this.assertIn("Completed", lesson.complete_task(task.id, { owner: "alice" }));
        this.assertIn("alice", lesson.teammate_assignments);
        this.assertTrue(lesson.release_completed_assignment("alice"));
        this.assertNotIn("alice", lesson.teammate_assignments);
      });
    }
  }

  // 收件箱投递应由运行时拥有（check_inbox 不作为模型工具暴露）。
  test_inbox_delivery_is_runtime_owned(): void {
    tempfile.TemporaryDirectory((tmp: string) => {
      const lesson = load_lesson(Path(tmp));

      const tool_names = new Set<string>(lesson.TOOLS.map((tool: any) => tool["name"]));
      this.assertNotIn("check_inbox", tool_names);
      this.assertIn("create_worktree", tool_names);
      this.assertNotIn("remove_worktree", tool_names);
      this.assertNotIn("keep_worktree", tool_names);
      const worktree_tools: Record<string, any> = {};
      for (const tool of lesson.TOOLS) {
        if (tool["name"] === "create_worktree") {
          worktree_tools[tool["name"]] = tool["input_schema"];
        }
      }
      for (const schema of Object.values(worktree_tools)) {
        this.assertFalse((schema as any)["additionalProperties"]);
        this.assertEqual((schema as any)["properties"]["name"]["maxLength"], 64);
      }
      this.assertIn("wait for the user's confirmation", lesson.PROMPT_SECTIONS["teams"]);
      this.assertIn("creating a Task", lesson.PROMPT_SECTIONS["teams"]);
      this.assertIn("not a sandbox", lesson.PROMPT_SECTIONS["teams"]);

      lesson.BUS.send("alice", "lead", "done", "result");
      const events = lesson.consume_lead_inbox();

      this.assertEqual(events.map((event: any) => event["type"]), ["result"]);
      this.assertIn("[result] alice: done", lesson.format_team_events(events));
    });
  }

  // spawn 应在启动线程前领取初始任务。
  test_spawn_claims_the_initial_task_before_starting_the_thread(): void {
    tempfile.TemporaryDirectory((tmp: string) => {
      const lesson = load_lesson(Path(tmp));
      const task = lesson.create_task("Review authentication");
      const schema = lesson.TOOLS.find((tool: any) => tool["name"] === "spawn_teammate")["input_schema"];
      this.assertIn("task_id", schema["properties"]);

      // with patch.object(lesson.threading.Thread, "start", lambda _thread: None):
      patch.object(lesson.threading.Thread, "start", (_thread: any) => null, () => {
        const result = lesson.spawn_teammate_thread("alice", "reviewer", "Review the assigned Task.", task.id);
        this.assertIn(task.id, result);
      });

      const claimed = lesson.load_task(task.id);
      this.assertEqual(claimed.status, "in_progress");
      this.assertEqual(claimed.owner, "alice");
      this.assertEqual(lesson.teammate_assignments["alice"]["task_id"], task.id);
    });
  }

  // spawn 应允许无初始任务的空闲队友。
  test_spawn_allows_an_idle_teammate_without_an_initial_task(): void {
    for (const lesson_path of RUNTIME_LESSONS) {
      this.subTest({ lesson: lesson_path.parent.name });
      tempfile.TemporaryDirectory((tmp: string) => {
        const lesson = load_lesson(Path(tmp), lesson_path);
        let tool_defs = lesson.TOOLS ?? null;
        if (tool_defs === null) {
          tool_defs = lesson.BUILTIN_TOOLS;
        }
        const schema = tool_defs.find((tool: any) => tool["name"] === "spawn_teammate")["input_schema"];
        this.assertNotIn("task_id", schema["required"]);

        patch.object(lesson.threading.Thread, "start", (_thread: any) => null, () => {
          const result = lesson.run_spawn_teammate("alice", "reviewer", "Wait for a ready Task.");
          this.assertIn("without an initial Task", result);
          this.assertNotIn("alice", lesson.teammate_assignments);
        });
      });
    }
  }

  // 队友的工作区工具应要求已领取任务。
  test_teammate_workspace_tools_require_a_claimed_task(): void {
    tempfile.TemporaryDirectory((tmp: string) => {
      const root = Path(tmp);
      const lesson = load_lesson(root);
      const runtime = new lesson.TeammateRuntime("alice", "reviewer", "Inspect the project.", null, false);

      const result = runtime.write("unassigned.txt", "must not be written");

      this.assertIn("Claim a Task", result);
      this.assertFalse(root.joinpath("unassigned.txt").exists());
    });
  }

  // 普通消息不应改变分配或计划版本号。
  test_plain_message_does_not_change_assignment_or_plan_version(): void {
    tempfile.TemporaryDirectory((tmp: string) => {
      const lesson = load_lesson(Path(tmp));
      lesson.active_teammates["alice"] = "working";
      lesson.plan_gates["alice"] = "approved";
      lesson.assignment_versions["alice"] = 3;

      this.assertIn("Sent", lesson.run_send_message("alice", "Continue."));

      this.assertEqual(lesson.plan_gates["alice"], "approved");
      this.assertEqual(lesson.assignment_versions["alice"], 3);
    });
  }

  // worktree 删除应仅限宿主执行。
  test_worktree_removal_is_host_only(): void {
    for (const lesson_path of RUNTIME_LESSONS) {
      this.subTest({ lesson: lesson_path.parent.name });
      tempfile.TemporaryDirectory((tmp: string) => {
        const lesson = load_lesson(Path(tmp), lesson_path);
        let tool_defs = lesson.TOOLS ?? null;
        if (tool_defs === null) {
          tool_defs = lesson.BUILTIN_TOOLS;
        }
        this.assertNotIn("remove_worktree", new Set(tool_defs.map((tool: any) => tool["name"])));
        this.assertTrue(callable(lesson.remove_worktree));
        this.assertFalse("run_remove_worktree" in lesson);
      });
    }
  }

  // 团队能力建立在 Task 之上，而非 background 或 cron 之上。
  test_agent_teams_builds_on_tasks_not_background_or_cron(): void {
    tempfile.TemporaryDirectory((tmp: string) => {
      const root = Path(tmp);
      const lesson = load_lesson(root);
      const tool_names = new Set<string>(lesson.TOOLS.map((tool: any) => tool["name"]));

      this.assertTrue(
        isSubset(
          new Set([
            "bash", "read_file", "write_file", "edit_file", "glob",
            "create_task", "list_tasks", "get_task", "claim_task",
            "complete_task", "spawn_teammate", "list_teammates",
            "send_message", "request_shutdown", "request_plan",
            "review_plan", "create_worktree",
          ]),
          tool_names,
        ),
      );
      this.assertTrue(isDisjoint(new Set(["schedule_cron", "list_crons", "cancel_cron"]), tool_names));
      const bashSchema = lesson.TOOLS.find((tool: any) => tool["name"] === "bash")["input_schema"];
      this.assertNotIn("run_in_background", bashSchema["properties"]);
      this.assertFalse(root.joinpath(".tasks").exists());
      this.assertFalse(root.joinpath(".mailboxes").exists());
      this.assertFalse(root.joinpath(".worktrees").exists());
    });
  }

  // 集成 harness 应复用内存的召回与提取能力。
  test_integrated_harness_reuses_memory_recall_and_extraction(): void {
    tempfile.TemporaryDirectory((tmp: string) => {
      const lesson = load_lesson(Path(tmp), DOWNSTREAM_LESSONS[0]);
      const calls: Array<[string, any]> = [];
      lesson.MEMORY_RUNTIME = types.SimpleNamespace({
        read_memory_index: () => "- [Style](style.md) - Project style",
        load_memories: (messages: any) => {
          calls.push(["recall", [...messages]]);
          return '[{"source":"style.md","content":"Use black."}]';
        },
        extract_memories: (messages: any) => {
          calls.push(["extract", [...messages]]);
          return 1;
        },
        consolidate_memories: () => {
          calls.push(["consolidate", null]);
        },
      });
      const messages: Array<Record<string, any>> = [{ role: "user", content: "Format this file." }];

      const context = lesson.update_context({}, messages);
      const system = lesson.assemble_system_prompt(context);
      lesson.remember_after_turn(messages);

      this.assertIn("Memory catalog", system);
      this.assertIn("Relevant memory records", system);
      this.assertEqual(calls.map(([name, _payload]) => name), ["recall", "extract", "consolidate"]);
    });
  }

  // MCP 课程应建立在基础内核之上。
  test_mcp_lesson_builds_on_the_base_kernel(): void {
    tempfile.TemporaryDirectory((tmp: string) => {
      const lesson = load_lesson(Path(tmp), ROOT.joinpath("s14_mcp_plugin", "code.py"));
      const [tools_before, handlers_before] = lesson.assemble_tool_pool();
      this.assertEqual(
        new Set(tools_before.map((tool: any) => tool["name"])),
        new Set(["bash", "read_file", "write_file", "edit_file", "glob", "connect_mcp"]),
      );
      this.assertNotIn("mcp__docs__search", handlers_before);

      this.assertIn("Connected to MCP server 'docs'", lesson.connect_mcp("docs"));
      const [tools_after, handlers_after] = lesson.assemble_tool_pool();
      this.assertIn("mcp__docs__search", new Set(tools_after.map((tool: any) => tool["name"])));
      this.assertEqual(
        handlers_after["mcp__docs__search"]({ query: "hooks" }),
        "[docs] Found 3 results for 'hooks'",
      );
    });
  }

  // 后台派发应仅限 bash，并上报失败。
  test_background_dispatch_is_bash_only_and_reports_failures(): void {
    for (const lesson_path of BACKGROUND_LESSONS) {
      this.subTest({ lesson: lesson_path.parent.name });
      tempfile.TemporaryDirectory((tmp: string) => {
        const lesson = load_lesson(Path(tmp), lesson_path);
        this.assertFalse(lesson.should_run_background("write_file", { run_in_background: true }));
        const block = types.SimpleNamespace({
          id: "tool_fail",
          name: "bash",
          input: { command: "exit 7", run_in_background: true },
        });
        let bg_id: any;
        if (["s14_mcp_plugin", "s15_integrated_harness"].includes(lesson_path.parent.name)) {
          bg_id = lesson.start_background_task(block, {});
        } else {
          bg_id = lesson.start_background_task(block);
        }
        this.assertTrue(wait_until(() => lesson.background_tasks[bg_id]["status"] !== "running"));
        this.assertEqual(lesson.background_tasks[bg_id]["status"], "failed");
        const notification = lesson.collect_background_results()[0];
        this.assertIn("<status>failed</status>", notification);
        this.assertIn("status 7", notification);
      });
    }
  }

  // shell 完成时应终止同一进程组的子进程。
  test_shell_completion_terminates_children_in_the_same_process_group(): void {
    for (const lesson_path of BACKGROUND_LESSONS) {
      this.subTest({ lesson: lesson_path.parent.name });
      tempfile.TemporaryDirectory((tmp: string) => {
        const lesson = load_lesson(Path(tmp), lesson_path);
        const marker = Path(tmp).joinpath("late-write.txt");
        const command =
          "nohup sh -c " + shlex.quote(`sleep 0.3; printf late > ${marker}`) + " >/dev/null 2>&1 &";

        const [_, exit_code] = lesson._run_bash_process(command);
        time.sleep(0.5);

        this.assertEqual(exit_code, 0);
        this.assertFalse(marker.exists());
      });
    }
  }

  // SIGTERM 应停止活跃 shell 的进程组。
  test_sigterm_stops_active_shell_process_groups(): void {
    for (const lesson_path of BACKGROUND_LESSONS) {
      this.subTest({ lesson: lesson_path.parent.name });
      tempfile.TemporaryDirectory((tmp: string) => {
        const root = Path(tmp);
        const started = root.joinpath("started.txt");
        const late = root.joinpath("late.txt");
        const command =
          `printf started > ${shlex.quote(String(started))}; ` +
          `sleep 0.8; printf late > ${shlex.quote(String(late))}`;
        const script =
          "import importlib.util, os, sys, time, types\n" +
          "fake_anthropic = types.ModuleType('anthropic')\n" +
          "fake_anthropic.Anthropic = lambda *a, **k: " +
          "types.SimpleNamespace(messages=types.SimpleNamespace(create=None))\n" +
          "fake_dotenv = types.ModuleType('dotenv')\n" +
          "fake_dotenv.load_dotenv = lambda **k: None\n" +
          "fake_yaml = types.ModuleType('yaml')\n" +
          "fake_yaml.safe_load = lambda value: {}\n" +
          "fake_yaml.YAMLError = ValueError\n" +
          "sys.modules.update({'anthropic': fake_anthropic, " +
          "'dotenv': fake_dotenv, 'yaml': fake_yaml})\n" +
          "os.environ['MODEL_ID'] = 'test-model'\n" +
          "os.environ['ANTHROPIC_API_KEY'] = 'test-key'\n" +
          `spec = importlib.util.spec_from_file_location('lesson', ${pyRepr(String(lesson_path))})\n` +
          "lesson = importlib.util.module_from_spec(spec)\n" +
          "spec.loader.exec_module(lesson)\n" +
          `lesson.run_bash(${pyRepr(command)}, run_in_background=True)\n` +
          "time.sleep(10)\n";
        const process = subprocess.Popen([sys.executable, "-c", script], {
          cwd: root,
          stdout: subprocess.DEVNULL,
          stderr: subprocess.DEVNULL,
        });
        try {
          this.assertTrue(wait_until(() => started.exists()));
          process.terminate();
          process.wait({ timeout: 2 });
          time.sleep(1);
          this.assertFalse(late.exists());
        } finally {
          if (process.poll() === null) {
            process.kill();
            process.wait({ timeout: 2 });
          }
        }
      });
    }
  }

  // 一次性的持久任务在模型接受后应被确认（ack）。
  test_durable_one_shot_is_acknowledged_after_model_acceptance(): void {
    for (const lesson_path of CRON_LESSONS) {
      this.subTest({ lesson: lesson_path.parent.name });
      tempfile.TemporaryDirectory((tmp: string) => {
        const lesson = load_lesson(Path(tmp), lesson_path);
        const job = new lesson.CronJob({
          id: "cron_test",
          cron: "* * * * *",
          prompt: "resume the report",
          recurring: false,
          durable: true,
          pending_delivery: true,
        });
        lesson.scheduled_jobs[job.id] = job;
        lesson.cron_queue.push(job);
        lesson.save_durable_jobs();

        this.assertIn(job.id, lesson.scheduled_jobs);
        const persisted = lesson.DURABLE_PATH.read_text();
        this.assertIn('"pending_delivery": true', persisted);
        lesson.client.messages.create = (_: any) =>
          types.SimpleNamespace({ content: [], stop_reason: "end_turn" });
        const messages: any[] = [];
        if (lesson_path.parent.name === "s15_integrated_harness") {
          lesson.agent_loop(messages, {}, "scheduled delivery");
        } else {
          lesson.agent_loop(messages, {});
        }

        this.assertTrue(
          messages.some((message: any) => message["content"] === "[Scheduled] resume the report"),
        );
        this.assertNotIn(job.id, lesson.scheduled_jobs);
        this.assertNotIn("cron_test", lesson.DURABLE_PATH.read_text());
      });
    }
  }

  // 模型调用失败时应恢复尚未确认的 cron 投递。
  test_failed_model_call_restores_unacknowledged_cron_delivery(): void {
    for (const lesson_path of CRON_LESSONS) {
      this.subTest({ lesson: lesson_path.parent.name });
      tempfile.TemporaryDirectory((tmp: string) => {
        const lesson = load_lesson(Path(tmp), lesson_path);
        const job = new lesson.CronJob({
          id: "cron_retry",
          cron: "* * * * *",
          prompt: "retry me",
          recurring: false,
          durable: true,
          pending_delivery: true,
        });
        lesson.scheduled_jobs[job.id] = job;
        lesson.cron_queue.push(job);
        lesson.save_durable_jobs();
        lesson.client.messages.create = (_: any) => {
          throw new Error("offline"); // RuntimeError
        };

        const messages: any[] = [];
        if (lesson_path.parent.name === "s15_integrated_harness") {
          lesson.agent_loop(messages, {}, "scheduled retry");
        } else {
          lesson.agent_loop(messages, {});
        }

        this.assertIn(job.id, lesson.scheduled_jobs);
        this.assertEqual(lesson.cron_queue.map((queued: any) => queued.id), [job.id]);
        this.assertIn(job.id, lesson.DURABLE_PATH.read_text());
      });
    }
  }

  // cron 持久化失败时应在入队前重试。
  test_failed_cron_persistence_retries_before_queueing(): void {
    for (const lesson_path of CRON_LESSONS) {
      this.subTest({ lesson: lesson_path.parent.name });
      tempfile.TemporaryDirectory((tmp: string) => {
        const lesson = load_lesson(Path(tmp), lesson_path);
        const job = new lesson.CronJob({
          id: "cron_persist_retry",
          cron: "* * * * *",
          prompt: "persist before delivery",
          recurring: false,
          durable: true,
        });
        lesson.scheduled_jobs[job.id] = job;
        const original_save = lesson.save_durable_jobs;
        let attempts = 0;

        function flaky_save(): void {
          attempts += 1;
          if (attempts === 1) {
            throw new Error("disk unavailable"); // OSError
          }
          original_save();
        }

        lesson.save_durable_jobs = flaky_save;
        // with self.assertRaisesRegex(OSError, "disk unavailable"):
        this.assertRaisesRegex(Error, "disk unavailable", () => {
          // with lesson.cron_lock:
          withLock(lesson.cron_lock, () => {
            lesson._enqueue_due_job(job);
          });
        });

        this.assertFalse(job.pending_delivery);
        this.assertEqual(lesson.cron_queue, []);

        withLock(lesson.cron_lock, () => {
          lesson._enqueue_due_job(job);
        });

        this.assertTrue(job.pending_delivery);
        this.assertEqual(lesson.cron_queue.map((queued: any) => queued.id), [job.id]);
        this.assertIn('"pending_delivery": true', lesson.DURABLE_PATH.read_text());
      });
    }
  }

  // 已取消的 cron 应从待投递队列中移除。
  test_cancelled_cron_is_removed_from_pending_queue(): void {
    for (const lesson_path of CRON_LESSONS) {
      this.subTest({ lesson: lesson_path.parent.name });
      tempfile.TemporaryDirectory((tmp: string) => {
        const lesson = load_lesson(Path(tmp), lesson_path);
        const job = new lesson.CronJob({
          id: "cron_cancel",
          cron: "* * * * *",
          prompt: "do not run",
          recurring: true,
          durable: true,
        });
        lesson.scheduled_jobs[job.id] = job;
        lesson.cron_queue.push(job);

        this.assertIn("Cancelled", lesson.cancel_job(job.id));
        this.assertEqual(lesson.consume_cron_queue(), []);
      });
    }
  }

  // MCP 权限应使用宿主策略。
  test_mcp_permission_uses_host_policy(): void {
    for (const lesson_path of MCP_LESSONS) {
      this.subTest({ lesson: lesson_path.parent.name });
      tempfile.TemporaryDirectory((tmp: string) => {
        const lesson = load_lesson(Path(tmp), lesson_path);
        lesson.connect_mcp("deploy");
        lesson.assemble_tool_pool();
        const status = types.SimpleNamespace({ name: "mcp__deploy__status", input: { service: "web" } });
        const trigger = types.SimpleNamespace({ name: "mcp__deploy__trigger", input: { service: "web" } });

        this.assertIsNone(lesson.permission_hook(status));
        // with patch("builtins.input", return_value="no"):
        patch("builtins.input", { return_value: "no" }, () => {
          this.assertEqual(lesson.permission_hook(trigger), "Permission denied by user");
        });

        const spoofed = types.SimpleNamespace({
          name: "mcp__third_party__erase",
          input: { description: "Erase records. (readOnly)" },
        });
        patch("builtins.input", { return_value: "no" }, () => {
          this.assertEqual(lesson.permission_hook(spoofed), "Permission denied by user");
        });
      });
    }
  }

  // 集成权限应对每一条 shell 命令都要求审批。
  test_integrated_permission_requires_approval_for_every_shell_command(): void {
    tempfile.TemporaryDirectory((tmp: string) => {
      const root = Path(tmp);
      const lesson = load_lesson(root, ROOT.joinpath("s15_integrated_harness", "code.py"));
      const outside = root.parent.joinpath(`outside-${time.time_ns()}.txt`);
      const block = types.SimpleNamespace({
        name: "bash",
        input: { command: `printf overwritten > ${outside}` },
      });
      try {
        patch("builtins.input", { return_value: "no" }, () => {
          this.assertEqual(lesson.permission_hook(block), "Permission denied by user");
        });
        this.assertFalse(outside.exists());
      } finally {
        outside.unlink({ missing_ok: true });
      }
    });
  }

  // 消息总线应拒绝未注册或不安全的收件人。
  test_message_bus_rejects_unregistered_or_unsafe_recipients(): void {
    tempfile.TemporaryDirectory((tmp: string) => {
      const root = Path(tmp);
      const lesson = load_lesson(root);
      lesson.active_teammates["alice"] = "idle";

      // with self.assertRaises(ValueError):
      this.assertRaises(Error, () => {
        lesson.BUS.send("alice", "../escape", "bad");
      });
      this.assertFalse(root.joinpath("escape.jsonl").exists());

      const result = lesson._teammate_send_message("alice", "ghost", "Are you there?");
      this.assertIn("not active", result);
      this.assertFalse(lesson.MAILBOX_DIR.joinpath("ghost.jsonl").exists());
    });
  }

  // 保留名不应遮蔽运行时身份。
  test_reserved_teammate_names_do_not_shadow_runtime_identities(): void {
    for (const lesson_path of RUNTIME_LESSONS) {
      this.subTest({ lesson: lesson_path.parent.name });
      tempfile.TemporaryDirectory((tmp: string) => {
        const lesson = load_lesson(Path(tmp), lesson_path);

        for (const name of ["lead", "agent", "Lead", "Agent"]) {
          const rejected = lesson.spawn_teammate_thread(name, "backend", "Inspect auth.");
          this.assertIn("reserved", rejected.toLowerCase());
          this.assertNotIn(name, lesson.active_teammates);
        }

        lesson.BUS.send("alice", "lead", "still routable");
        this.assertEqual(lesson.BUS.read_inbox("lead")[0]["content"], "still routable");

        lesson.active_teammates["Alice"] = "idle";
        const duplicate = lesson.spawn_teammate_thread("alice", "backend", "Inspect auth.");
        this.assertIn("already exists", duplicate);
      });
    }
  }

  // 公开的任务工具遇到非法 id 应返回错误。
  test_public_task_tools_return_errors_for_bad_ids(): void {
    for (const lesson_path of RUNTIME_LESSONS) {
      this.subTest({ lesson: lesson_path.parent.name });
      tempfile.TemporaryDirectory((tmp: string) => {
        const lesson = load_lesson(Path(tmp), lesson_path);
        for (const task_id of ["../escape", "task_missing"]) {
          for (const tool_name of ["run_get_task", "run_claim_task", "run_complete_task"]) {
            this.subTest({ tool: tool_name, task_id });
            const result = lesson[tool_name](task_id);
            this.assertIn("Error:", result);
          }
        }
      });
    }
  }

  // 计划门禁应在审批前阻止会产生变更的工具。
  test_plan_gate_blocks_mutating_tools_until_approval(): void {
    tempfile.TemporaryDirectory((tmp: string) => {
      const lesson = load_lesson(Path(tmp));
      const cases: Record<string, Record<string, any>> = {
        write_file: { path: "config.py", content: "VALUE = 1" },
        edit_file: { path: "config.py", old_text: "0", new_text: "1" },
      };
      for (const [tool_name, tool_input] of Object.entries(cases)) {
        this.subTest({ tool: tool_name });
        const calls: any[] = [];
        const block = types.SimpleNamespace({ name: tool_name, input: tool_input });
        const handlers: Record<string, any> = {
          [tool_name]: (kwargs: any) => {
            calls.push(kwargs);
            return "done";
          },
        };

        lesson.plan_gates["alice"] = "pending";
        const blocked = lesson._run_teammate_tool("alice", block, handlers);
        this.assertIn("Blocked", blocked);
        this.assertEqual(calls, []);

        lesson.plan_gates["alice"] = "approved";
        const allowed = lesson._run_teammate_tool("alice", block, handlers);
        this.assertEqual(allowed, "done");
        this.assertEqual(calls.length, 1);
      }
    });
  }

  // 队友工具错误应转化为 tool_result。
  test_teammate_tool_errors_become_tool_results(): void {
    tempfile.TemporaryDirectory((tmp: string) => {
      const lesson = load_lesson(Path(tmp));
      lesson.plan_gates["alice"] = "not_required";
      const block = types.SimpleNamespace({ name: "write_file", input: { path: "config.py" } });

      const result = lesson._run_teammate_tool("alice", block, {
        write_file: (path: any, content: any) => "wrote",
      });

      this.assertIn("TypeError", result);
    });
  }

  // 队友应保留完整的工具历史。
  test_teammate_keeps_complete_tool_history(): void {
    tempfile.TemporaryDirectory((tmp: string) => {
      const lesson = load_lesson(Path(tmp));
      lesson.IDLE_SCAN_INTERVAL = 5.0;
      let calls = 0;

      const respond = (kwargs: any): any => {
        calls += 1;
        this.assertEqual(kwargs["messages"][0]["content"], "Inspect the project.");
        if (calls <= 11) {
          return types.SimpleNamespace({
            stop_reason: "tool_use",
            content: [
              types.SimpleNamespace({ type: "tool_use", name: "list_tasks", id: `list-${calls}`, input: {} }),
            ],
          });
        }
        return types.SimpleNamespace({
          stop_reason: "end_turn",
          content: [types.SimpleNamespace({ type: "text", text: "Inspection complete." })],
        });
      };

      lesson.client.messages.create = respond;
      lesson.spawn_teammate_thread("alice", "reviewer", "Inspect the project.");
      this.assertTrue(wait_until(() => lesson.BUS.peek("lead"), 3.0));
      this.assertEqual(calls, 12);
      lesson.run_request_shutdown("alice");
      this.assertTrue(wait_until(() => !("alice" in lesson.active_teammates)));
    });
  }

  // s15 队友派发应运行权限钩子与后置钩子。
  test_s15_teammate_dispatch_runs_permission_and_post_hooks(): void {
    tempfile.TemporaryDirectory((tmp: string) => {
      const lesson = load_lesson(Path(tmp), ROOT.joinpath("s15_integrated_harness", "code.py"));
      const block = types.SimpleNamespace({
        name: "write_file",
        input: { path: "config.py", content: "VALUE = 1" },
      });
      const calls: any[] = [];
      const handlers: Record<string, any> = {
        write_file: (kwargs: any) => {
          calls.push(["handler", kwargs]);
          return "wrote";
        },
      };
      lesson.plan_gates["alice"] = "approved";
      lesson.HOOKS["PreToolUse"] = [
        (seen: any) => {
          calls.push(["pre", seen.name]);
          return "denied";
        },
      ];
      lesson.HOOKS["PostToolUse"] = [
        (seen: any, output: any) => {
          calls.push(["post", seen.name, output]);
        },
      ];

      const denied = lesson._run_teammate_tool("alice", block, handlers);
      this.assertEqual(denied, "denied");
      this.assertEqual(calls, [["pre", "write_file"]]);

      calls.length = 0; // calls.clear()
      lesson.HOOKS["PreToolUse"] = [
        (seen: any) => {
          calls.push(["pre", seen.name]);
        },
      ];
      const allowed = lesson._run_teammate_tool("alice", block, handlers);

      this.assertEqual(allowed, "wrote");
      this.assertEqual(calls, [
        ["pre", "write_file"],
        ["handler", block.input],
        ["post", "write_file", "wrote"],
      ]);
    });
  }

  // s15 队友应在工具回合之间读取关闭信号。
  test_s15_teammate_reads_shutdown_between_tool_rounds(): void {
    tempfile.TemporaryDirectory((tmp: string) => {
      const lesson = load_lesson(Path(tmp), ROOT.joinpath("s15_integrated_harness", "code.py"));
      const entered = new threading.Event();
      const release = new threading.Event();
      const calls: any[] = [];

      const create = (_kwargs: any): any => {
        calls.push("llm");
        entered.set();
        release.wait({ timeout: 2 });
        const block = types.SimpleNamespace({ type: "tool_use", id: "tool_1", name: "list_tasks", input: {} });
        return types.SimpleNamespace({ stop_reason: "tool_use", content: [block] });
      };

      lesson.client.messages.create = create;
      lesson.spawn_teammate_thread("alice", "reviewer", "Inspect tasks");
      this.assertTrue(entered.wait({ timeout: 2 }));
      lesson.run_request_shutdown("alice");
      release.set();

      this.assertTrue(wait_until(() => !("alice" in lesson.active_teammates)));
      this.assertEqual(calls, ["llm"]);
    });
  }

  // 规范化后的 MCP 工具名冲突应被拒绝。
  test_normalized_mcp_tool_name_collisions_are_rejected(): void {
    for (const lesson_path of MCP_LESSONS) {
      this.subTest({ lesson: lesson_path.parent.name });
      tempfile.TemporaryDirectory((tmp: string) => {
        const lesson = load_lesson(Path(tmp), lesson_path);
        const first = new lesson.MCPClient("docs.one");
        first.register([{ name: "get.version", inputSchema: {} }], { "get.version": () => "one" });
        const second = new lesson.MCPClient("docs_one");
        second.register([{ name: "get_version", inputSchema: {} }], { get_version: () => "two" });
        lesson.mcp_clients.clear();
        lesson.mcp_clients.update({ "docs.one": first, docs_one: second });

        this.assertRaisesRegex(Error, "collision.*mcp__docs_one__get_version", () => {
          lesson.assemble_tool_pool();
        });
      });
    }
  }

  // 计划被拒后需重新提交。
  test_plan_rejection_requires_a_new_submission(): void {
    tempfile.TemporaryDirectory((tmp: string) => {
      const lesson = load_lesson(Path(tmp));
      lesson.active_teammates["alice"] = "idle";

      this.assertIn("Plan requested", lesson.run_request_plan("alice", "Refactor auth"));
      const request = lesson.BUS.read_inbox("alice");
      this.assertEqual(request[0]["type"], "plan_request");
      this.assertEqual(lesson.plan_gates["alice"], "required");

      const submission = lesson._teammate_submit_plan("alice", "1. Read\n2. Test");
      const request_id = submission.split("(")[1].split(")")[0];
      this.assertEqual(lesson.pending_requests[request_id].status, "pending");

      const result = lesson.run_review_plan(request_id, false, "Add a rollback step.");
      this.assertIn("rejected", result);
      this.assertEqual(lesson.plan_gates["alice"], "pending");

      const responses = lesson.BUS.read_inbox("alice");
      const [accepted, _] = lesson.apply_plan_response("alice", responses[responses.length - 1]);
      this.assertTrue(accepted);
      this.assertEqual(lesson.plan_gates["alice"], "rejected");

      const second = lesson._teammate_submit_plan(
        "alice",
        "1. Read\n2. Change\n3. Test\n4. Roll back on failure",
      );
      const second_id = second.split("(")[1].split(")")[0];
      this.assertNotEqual(second_id, request_id);
      this.assertEqual(lesson.pending_requests[second_id].status, "pending");
    });
  }

  // 不匹配的计划响应不能释放门禁。
  test_mismatched_plan_response_cannot_release_gate(): void {
    tempfile.TemporaryDirectory((tmp: string) => {
      const lesson = load_lesson(Path(tmp));
      lesson.active_teammates["alice"] = "waiting_approval";
      const submission = lesson._teammate_submit_plan("alice", "1. Read\n2. Test");
      const request_id = submission.split("(")[1].split(")")[0];

      const forged: Record<string, any> = {
        from: "lead",
        to: "alice",
        type: "plan_approval_response",
        content: "Approved",
        metadata: { request_id: "req_stale", approve: true },
      };
      const [accepted, notice] = lesson.apply_plan_response("alice", forged);

      this.assertFalse(accepted);
      this.assertIn("Ignored", notice);
      this.assertEqual(lesson.plan_gates["alice"], "pending");
      this.assertEqual(lesson.plan_request_ids["alice"], request_id);

      const current_but_unreviewed = {
        ...forged,
        metadata: { request_id, approve: true },
      };
      const [accepted2, _] = lesson.apply_plan_response("alice", current_but_unreviewed);
      this.assertFalse(accepted2);
      this.assertEqual(lesson.plan_gates["alice"], "pending");
    });
  }

  // 关闭响应必须来自被请求关闭的那个队友。
  test_shutdown_response_must_come_from_requested_teammate(): void {
    tempfile.TemporaryDirectory((tmp: string) => {
      const lesson = load_lesson(Path(tmp));
      Object.assign(lesson.active_teammates, { alice: "idle", bob: "idle" });
      const result = lesson.run_request_shutdown("alice");
      const request_id = result.split("(")[1].split(")")[0];

      lesson.BUS.send("bob", "lead", "Shutdown acknowledged.", "shutdown_response", {
        request_id,
        approve: true,
      });
      lesson.consume_lead_inbox();

      this.assertEqual(lesson.pending_requests[request_id].status, "pending");
    });
  }

  // 关闭请求必须匹配活跃的协议（请求 id）。
  test_shutdown_request_must_match_active_protocol(): void {
    tempfile.TemporaryDirectory((tmp: string) => {
      const lesson = load_lesson(Path(tmp));
      lesson.active_teammates["alice"] = "idle";
      const forged: Record<string, any> = {
        from: "lead",
        to: "alice",
        type: "shutdown_request",
        content: "Shut down.",
        metadata: { request_id: "req_unknown" },
      };

      const [accepted, notice] = lesson.apply_shutdown_request("alice", forged);
      this.assertFalse(accepted);
      this.assertIn("Ignored", notice);
      this.assertEqual(lesson.active_teammates["alice"], "idle");

      const result = lesson.run_request_shutdown("alice");
      const request_id = result.split("(")[1].split(")")[0];
      const request = lesson.BUS.read_inbox("alice");
      const lastRequest = request[request.length - 1];
      const [accepted2, matched_id] = lesson.apply_shutdown_request("alice", lastRequest);

      this.assertTrue(accepted2);
      this.assertEqual(matched_id, request_id);
      this.assertEqual(lesson.active_teammates["alice"], "stopping");
      const [replayed, _] = lesson.apply_shutdown_request("alice", lastRequest);
      this.assertFalse(replayed);
    });
  }

  // 队友应先发出 result 再发 idle，然后关闭。
  test_teammate_emits_result_then_idle_and_shuts_down(): void {
    tempfile.TemporaryDirectory((tmp: string) => {
      const lesson = load_lesson(Path(tmp));
      lesson.IDLE_SCAN_INTERVAL = 5.0;
      const pending = lesson.create_task("Do not claim before mailbox delivery");
      const seen_tools = new Set<string>();

      const respond = (kwargs: any): any => {
        for (const tool of kwargs["tools"]) {
          seen_tools.add(tool["name"]);
        }
        return types.SimpleNamespace({
          stop_reason: "end_turn",
          content: [types.SimpleNamespace({ type: "text", text: "Task complete." })],
        });
      };

      lesson.client.messages.create = respond;

      lesson.spawn_teammate_thread("alice", "backend", "Inspect auth.");
      const lead_inbox = lesson.MAILBOX_DIR.joinpath("lead.jsonl");
      this.assertTrue(
        wait_until(() => lead_inbox.exists() && lead_inbox.read_text().split("\n").length >= 2),
      );
      const events = lesson.consume_lead_inbox();

      this.assertEqual(events.map((event: any) => event["type"]), ["result", "idle_notification"]);
      this.assertEqual(lesson.active_teammates["alice"], "idle");
      this.assertTrue(isSubset(new Set(["list_tasks", "claim_task", "complete_task"]), seen_tools));
      this.assertTrue(
        isDisjoint(new Set(["create_worktree", "remove_worktree", "keep_worktree"]), seen_tools),
      );

      lesson.run_request_shutdown("alice");
      this.assertTrue(wait_until(() => !("alice" in lesson.active_teammates)));
      const shutdown_events = lesson.consume_lead_inbox();
      this.assertEqual(shutdown_events[shutdown_events.length - 1]["type"], "shutdown_response");
      const request_id = shutdown_events[shutdown_events.length - 1]["metadata"]["request_id"];
      this.assertEqual(lesson.pending_requests[request_id].status, "approved");
      this.assertEqual(lesson.load_task(pending.id).status, "pending");
    });
  }

  // 下游队友应能超过十个工具回合继续执行。
  test_downstream_teammates_continue_past_ten_tool_rounds(): void {
    for (const lesson_path of DOWNSTREAM_LESSONS) {
      this.subTest({ lesson: lesson_path.parent.name });
      tempfile.TemporaryDirectory((tmp: string) => {
        const lesson = load_lesson(Path(tmp), lesson_path);
        lesson.IDLE_SCAN_INTERVAL = 5.0;
        let calls = 0;

        const respond = (kwargs: any): any => {
          calls += 1;
          if (calls <= 11) {
            return types.SimpleNamespace({
              stop_reason: "tool_use",
              content: [
                types.SimpleNamespace({ type: "tool_use", name: "list_tasks", id: `list-${calls}`, input: {} }),
              ],
            });
          }
          return types.SimpleNamespace({
            stop_reason: "end_turn",
            content: [types.SimpleNamespace({ type: "text", text: "Long task complete." })],
          });
        };

        lesson.client.messages.create = respond;
        lesson.spawn_teammate_thread("alice", "backend", "Use more than ten tool rounds.");
        const lead_inbox = lesson.MAILBOX_DIR.joinpath("lead.jsonl");
        this.assertTrue(
          wait_until(() => lead_inbox.exists() && lead_inbox.read_text().split("\n").length >= 2, 3.0),
        );
        const events = lesson.consume_lead_inbox();

        this.assertEqual(calls, 12);
        this.assertEqual(events.map((event: any) => event["type"]), ["result", "idle_notification"]);
        this.assertEqual(lesson.active_teammates["alice"], "idle");
        lesson.run_request_shutdown("alice");
        this.assertTrue(wait_until(() => !("alice" in lesson.active_teammates)));
      });
    }
  }

  // 队友异常应释放运行时与任务所有权。
  test_teammate_exception_releases_runtime_and_task_ownership(): void {
    for (const lesson_path of RUNTIME_LESSONS) {
      this.subTest({ lesson: lesson_path.parent.name });
      tempfile.TemporaryDirectory((tmp: string) => {
        const lesson = load_lesson(Path(tmp), lesson_path);
        const task = lesson.create_task("Implement auth");
        let calls = 0;

        const respond = (kwargs: any): any => {
          calls += 1;
          const tool_name = calls === 1 ? "claim_task" : "list_tasks";
          const tool_input = calls === 1 ? { task_id: task.id } : {};
          return types.SimpleNamespace({
            stop_reason: "tool_use",
            content: [
              types.SimpleNamespace({ type: "tool_use", name: tool_name, id: `tool-${calls}`, input: tool_input }),
            ],
          });
        };

        const original_dispatch = lesson._run_teammate_tool;

        function crash_after_claim(name: string, block: any, handlers: any): any {
          if (block.name === "list_tasks") {
            throw new Error("simulated dispatch failure"); // RuntimeError
          }
          return original_dispatch(name, block, handlers);
        }

        lesson.client.messages.create = respond;
        lesson._run_teammate_tool = crash_after_claim;
        lesson.spawn_teammate_thread("alice", "backend", "Claim and begin work.");

        this.assertTrue(wait_until(() => !("alice" in lesson.active_teammates)));
        this.assertNotIn("alice", lesson.teammate_assignments);
        const recovered = lesson.load_task(task.id);
        this.assertEqual(recovered.status, "pending");
        this.assertIsNone(recovered.owner);
        const events = lesson.consume_lead_inbox();
        this.assertEqual(events.map((event: any) => event["type"]), ["error"]);
        this.assertIn("simulated dispatch failure", events[0]["content"]);
      });
    }
  }

  // s15 已完成的后台任务应仅唤醒 agent 一次。
  test_s15_completed_background_task_wakes_the_agent_once(): void {
    tempfile.TemporaryDirectory((tmp: string) => {
      const lesson = load_lesson(Path(tmp), ROOT.joinpath("s15_integrated_harness", "code.py"));
      const seen_messages: any[] = [];

      const respond = (messages: any, context: any, tools: any, state: any, max_tokens: any): any => {
        seen_messages.push([...messages]);
        return types.SimpleNamespace({
          stop_reason: "end_turn",
          content: [types.SimpleNamespace({ type: "text", text: "Background result handled." })],
        });
      };

      lesson.call_llm = respond;
      lesson.background_tasks["bg_0001"] = {
        tool_use_id: "tool-1",
        command: "pytest",
        status: "completed",
      };
      lesson.background_results["bg_0001"] = "all tests passed";
      const history: any[] = [];
      const context = {};
      const session_state = { active_user_request: "Run tests" };
      new threading.Thread({
        target: lesson.async_event_loop,
        args: [history, context, session_state],
        daemon: true,
      }).start();

      this.assertTrue(wait_until(() => Boolean(seen_messages.length), 3.0));
      const delivered = String(seen_messages[0]);
      this.assertIn("<task_notification>", delivered);
      this.assertIn("all tests passed", delivered);
      this.assertFalse(lesson.has_pending_background());
      const calls_after_delivery = seen_messages.length;
      time.sleep(1.2);
      this.assertEqual(seen_messages.length, calls_after_delivery);
    });
  }

  // 队友应能在 worktree 分配失效时存活。
  test_teammate_survives_stale_worktree_assignment(): void {
    tempfile.TemporaryDirectory((tmp: string) => {
      const root = Path(tmp);
      init_git_repo(root);
      const lesson = load_lesson(root);
      lesson.IDLE_SCAN_INTERVAL = 5.0;
      const task = lesson.create_task("Implement auth");
      lesson.create_worktree("auth", task.id);
      const worktree = lesson.WORKTREES_DIR.joinpath("auth");
      let calls = 0;
      const bash_result: any[] = [];

      const respond = (kwargs: any): any => {
        calls += 1;
        if (calls === 1) {
          return types.SimpleNamespace({
            stop_reason: "tool_use",
            content: [
              types.SimpleNamespace({ type: "tool_use", name: "claim_task", id: "claim-1", input: { task_id: task.id } }),
            ],
          });
        }
        if (calls === 2) {
          subprocess.run(["git", "worktree", "remove", "--force", String(worktree)], {
            cwd: root,
            check: true,
          });
          return types.SimpleNamespace({
            stop_reason: "tool_use",
            content: [types.SimpleNamespace({ type: "tool_use", name: "bash", id: "bash-1", input: { command: "pwd" } })],
          });
        }
        bash_result.push(kwargs["messages"][kwargs["messages"].length - 1]["content"][0]["content"]);
        return types.SimpleNamespace({
          stop_reason: "end_turn",
          content: [types.SimpleNamespace({ type: "text", text: "Handled stale assignment." })],
        });
      };

      lesson.client.messages.create = respond;
      lesson.spawn_teammate_thread("alice", "backend", "Claim the task.");

      this.assertTrue(wait_until(() => Boolean(bash_result.length)));
      this.assertIn("Invalid task assignment", bash_result[0]);
      this.assertIn("alice", lesson.active_teammates);
      lesson.run_request_shutdown("alice");
      this.assertTrue(wait_until(() => !("alice" in lesson.active_teammates)));
    });
  }

  // 空闲领取应在多个队友之间保持原子性。
  test_idle_claim_is_atomic_across_teammates(): void {
    tempfile.TemporaryDirectory((tmp: string) => {
      const lesson = load_lesson(Path(tmp));
      const task = lesson.create_task("Refactor auth");

      const barrier = new threading.Barrier(3);
      const claimed: Record<string, any> = {};

      const claim = (name: string): void => {
        barrier.wait();
        claimed[name] = lesson.claim_next_task(name);
      };

      const threads = ["alice", "bob"].map((name) => new threading.Thread({ target: claim, args: [name] }));
      for (const thread of threads) {
        thread.start();
      }
      barrier.wait();
      for (const thread of threads) {
        thread.join({ timeout: 2 });
      }

      this.assertTrue(threads.every((thread) => !thread.is_alive()));
      this.assertEqual(Object.values(claimed).filter((result) => result !== null).length, 1);
      const winner = Object.values(claimed).find((result) => result !== null).owner;
      this.assertEqual(lesson.load_task(task.id).owner, winner);
    });
  }

  // 分配应强制「一次只做一个任务」且仅所有者可完成。
  test_assignment_enforces_one_task_and_owner_only_completion(): void {
    tempfile.TemporaryDirectory((tmp: string) => {
      const lesson = load_lesson(Path(tmp));
      const first = lesson.create_task("Refactor auth");
      const second = lesson.create_task("Refactor login");

      this.assertIn("Claimed", lesson.claim_task(first.id, { owner: "alice" }));
      let denied = lesson.claim_task(second.id, { owner: "alice" });
      this.assertIn("must finish", denied);
      this.assertEqual(lesson.load_task(second.id).status, "pending");

      denied = lesson.complete_task(first.id, { owner: "bob" });
      this.assertIn("not bob", denied);
      this.assertEqual(lesson.load_task(first.id).status, "in_progress");

      this.assertIn("Completed", lesson.complete_task(first.id, { owner: "alice" }));
      this.assertIn("alice", lesson.teammate_assignments);
      denied = lesson.claim_task(second.id, { owner: "alice" });
      this.assertIn("must finish", denied);
      this.assertTrue(lesson.release_completed_assignment("alice"));
      this.assertIn("Claimed", lesson.claim_task(second.id, { owner: "alice" }));
    });
  }

  // 已完成的分配应让 lead 留在 worktree 中直到回合边界。
  test_completed_assignment_keeps_lead_in_worktree_until_turn_boundary(): void {
    for (const lesson_path of RUNTIME_LESSONS) {
      this.subTest({ lesson: lesson_path.parent.name });
      tempfile.TemporaryDirectory((tmp: string) => {
        const root = Path(tmp);
        init_git_repo(root);
        const lesson = load_lesson(root, lesson_path);
        const first = lesson.create_task("Implement auth");
        const second = lesson.create_task("Update docs");
        lesson.create_worktree("auth", first.id);

        this.assertIn("Claimed", lesson.claim_task(first.id, { owner: "agent" }));
        this.assertIn("Completed", lesson.complete_task(first.id, { owner: "agent" }));
        this.assertIn("Wrote", lesson.run_agent_write("after-complete.txt", "done"));
        this.assertTrue(lesson.WORKTREES_DIR.joinpath("auth", "after-complete.txt").exists());
        this.assertFalse(root.joinpath("after-complete.txt").exists());
        this.assertIn("must finish", lesson.claim_task(second.id, { owner: "agent" }));

        this.assertTrue(lesson.release_completed_assignment("agent"));
        this.assertIn("Claimed", lesson.claim_task(second.id, { owner: "agent" }));
      });
    }
  }

  // 处理中的分配应在运行时重启后重新水合（rehydrate）。
  test_in_progress_assignment_rehydrates_after_runtime_restart(): void {
    for (const lesson_path of RUNTIME_LESSONS) {
      this.subTest({ lesson: lesson_path.parent.name });
      tempfile.TemporaryDirectory((tmp: string) => {
        const root = Path(tmp);
        init_git_repo(root);
        const lesson = load_lesson(root, lesson_path);
        const task = lesson.create_task("Implement auth");
        lesson.create_worktree("auth", task.id);
        lesson.claim_task(task.id, { owner: "alice" });

        lesson.teammate_assignments.clear();
        const recovered = lesson.assignment_cwd("alice");

        this.assertEqual(recovered.resolve(), lesson.WORKTREES_DIR.joinpath("auth").resolve());
        this.assertEqual(lesson.teammate_assignments["alice"]["task_id"], task.id);
      });
    }
  }

  // 完成任务前应先重新水合 cwd 租约。
  test_completion_rehydrates_cwd_lease_before_status_change(): void {
    for (const lesson_path of RUNTIME_LESSONS) {
      this.subTest({ lesson: lesson_path.parent.name });
      tempfile.TemporaryDirectory((tmp: string) => {
        const root = Path(tmp);
        init_git_repo(root);
        const lesson = load_lesson(root, lesson_path);
        const task = lesson.create_task("Implement auth");
        lesson.create_worktree("auth", task.id);
        lesson.claim_task(task.id, { owner: "agent" });
        lesson.teammate_assignments.clear();

        this.assertIn("Completed", lesson.complete_task(task.id, { owner: "agent" }));
        this.assertIn("Wrote", lesson.run_agent_write("after.txt", "done"));
        this.assertTrue(lesson.WORKTREES_DIR.joinpath("auth", "after.txt").exists());
        this.assertFalse(root.joinpath("after.txt").exists());
      });
    }
  }

  // 完成任务应替换掉跨运行时的失效 cwd 租约。
  test_completion_replaces_a_stale_cross_runtime_cwd_lease(): void {
    for (const lesson_path of RUNTIME_LESSONS) {
      this.subTest({ lesson: lesson_path.parent.name });
      tempfile.TemporaryDirectory((tmp: string) => {
        const root = Path(tmp);
        init_git_repo(root);
        const first = load_lesson(root, lesson_path);
        const old_task = first.create_task("Old assignment");
        first.create_worktree("old", old_task.id);
        first.claim_task(old_task.id, { owner: "agent" });
        first.complete_task(old_task.id, { owner: "agent" });

        const second = load_lesson(root, lesson_path);
        const new_task = second.create_task("New assignment");
        second.create_worktree("new", new_task.id);
        second.claim_task(new_task.id, { owner: "agent" });

        this.assertIn("Completed", first.complete_task(new_task.id, { owner: "agent" }));
        this.assertIn("Wrote", first.run_agent_write("after.txt", "done"));
        this.assertTrue(first.WORKTREES_DIR.joinpath("new", "after.txt").exists());
        this.assertFalse(first.WORKTREES_DIR.joinpath("old", "after.txt").exists());
      });
    }
  }

  // 任务领取应在多个进程之间保持原子性。
  test_task_claim_is_atomic_across_processes(): void {
    const context = multiprocessing.get_context("spawn");
    for (const lesson_path of RUNTIME_LESSONS) {
      this.subTest({ lesson: lesson_path.parent.name });
      tempfile.TemporaryDirectory((tmp: string) => {
        const lesson = load_lesson(Path(tmp), lesson_path);
        const task = lesson.create_task("Only once");
        const barrier = context.Barrier(3);
        const results = context.Queue();

        const workers = ["alice", "bob"].map((owner) =>
          context.Process({
            target: claim_in_child,
            args: [String(lesson_path), tmp, task.id, owner, barrier, results],
          }),
        );
        for (const worker of workers) {
          worker.start();
        }
        barrier.wait();
        for (const worker of workers) {
          worker.join(5);
          this.assertEqual(worker.exitcode, 0);
        }
        const outcomes = workers.map(() => results.get({ timeout: 1 }));

        this.assertEqual(
          outcomes.filter((outcome: string) => outcome.startsWith("Claimed ")).length,
          1,
        );
        const persisted = lesson.load_task(task.id);
        this.assertEqual(persisted.status, "in_progress");
        this.assertIn(persisted.owner, new Set(["alice", "bob"]));
      });
    }
  }

  // 计划审批不能跨越分配边界。
  test_plan_approval_cannot_cross_assignment_boundary(): void {
    for (const lesson_path of RUNTIME_LESSONS) {
      this.subTest({ lesson: lesson_path.parent.name });
      tempfile.TemporaryDirectory((tmp: string) => {
        const lesson = load_lesson(Path(tmp), lesson_path);
        lesson.active_teammates["alice"] = "working";
        lesson.plan_gates["alice"] = "required";
        lesson.assignment_versions["alice"] = 1;
        lesson._teammate_submit_plan("alice", "Inspect, edit, test");
        const request_id = Object.keys(lesson.pending_requests)[0];

        lesson.advance_assignment_version("alice");
        const result = lesson.run_review_plan(request_id, true);

        this.assertIn("earlier assignment", result);
        this.assertNotEqual(lesson.plan_gates["alice"], "approved");
      });
    }
  }

  // 需要计划的队友应在其线程启动前就已激活计划门禁。
  test_required_plan_is_active_before_teammate_thread_starts(): void {
    for (const lesson_path of RUNTIME_LESSONS) {
      this.subTest({ lesson: lesson_path.parent.name });
      tempfile.TemporaryDirectory((tmp: string) => {
        const lesson = load_lesson(Path(tmp), lesson_path);
        let tool_defs = lesson.TOOLS ?? null;
        if (tool_defs === null) {
          tool_defs = lesson.BUILTIN_TOOLS;
        }
        const spawn_schema = tool_defs.find((tool: any) => tool["name"] === "spawn_teammate")["input_schema"];
        this.assertIn("require_plan", spawn_schema["properties"]);
        patch.object(lesson.threading.Thread, "start", (_thread: any) => null, () => {
          lesson.spawn_teammate_thread("alice", "backend", "Claim and edit.", { require_plan: true });
        });
        const task = lesson.create_task("Edit auth");
        this.assertIn("Claimed", lesson.claim_task(task.id, "alice"));
        this.assertEqual(lesson.plan_gates["alice"], "required");
        const calls: any[] = [];
        const block = types.SimpleNamespace({
          name: "write_file",
          input: { path: "auth.py", content: "changed" },
        });
        const denied = lesson._run_teammate_tool("alice", block, {
          write_file: (kw: any) => calls.push(kw),
        });
        this.assertIn("Blocked", denied);
        this.assertEqual(calls, []);
      });
    }
  }

  // worktree 注册表解析不应使用显示用的截断。
  test_worktree_registry_parsing_does_not_use_display_truncation(): void {
    for (const lesson_path of RUNTIME_LESSONS) {
      this.subTest({ lesson: lesson_path.parent.name });
      tempfile.TemporaryDirectory((tmp: string) => {
        const lesson = load_lesson(Path(tmp), lesson_path);
        const entries: string[] = [];
        for (let index = 0; index < 80; index++) {
          const path = Path(tmp).joinpath(".worktrees", `work-${index}-` + "x".repeat(80));
          entries.push(`worktree ${path}\nHEAD ${"0".repeat(40)}\n` + `branch refs/heads/wt/work-${index}\n`);
        }
        const porcelain = entries.join("\n");
        this.assertGreater(porcelain.length, 5000);
        lesson._run_git = (args: any, cwd: any = null): [boolean, string] => [true, porcelain];

        const [registered, error] = lesson._registered_worktrees();

        this.assertIsNone(error);
        this.assertEqual(registered.length, 80);
      });
    }
  }

  // 任务的 worktree 应设置分配 cwd，并包含文件工具。
  test_task_worktree_sets_assignment_cwd_and_contains_file_tools(): void {
    tempfile.TemporaryDirectory((tmp: string) => {
      const root = Path(tmp);
      init_git_repo(root);
      const lesson = load_lesson(root);
      const task = lesson.create_task("Implement auth");

      const created = lesson.create_worktree("auth", task.id);
      this.assertIn("created", created);
      const worktree = lesson.WORKTREES_DIR.joinpath("auth");
      this.assertEqual(lesson.load_task(task.id).worktree, "auth");

      this.assertIn("Claimed", lesson.claim_task(task.id, { owner: "alice" }));
      const assignment = lesson.teammate_assignments["alice"];
      this.assertEqual(assignment["task_id"], task.id);
      this.assertEqual(assignment["cwd"], worktree);
      this.assertIn(
        "Wrote",
        lesson.run_write("nested/result.txt", "done", { cwd: lesson.assignment_cwd("alice") }),
      );
      this.assertEqual(worktree.joinpath("nested", "result.txt").read_text(), "done");
      const escaped = lesson.run_write("../outside.txt", "bad", { cwd: lesson.assignment_cwd("alice") });
      this.assertIn("escapes workspace", escaped);
      this.assertFalse(lesson.WORKTREES_DIR.joinpath("outside.txt").exists());
      const missing_cwd = lesson.run_bash("pwd", { cwd: worktree.joinpath("missing") });
      this.assertIn("FileNotFoundError", missing_cwd);
    });
  }

  // 非法或未注册的 worktree 永远不应变为可领取。
  test_invalid_or_unregistered_worktree_never_becomes_claimable(): void {
    tempfile.TemporaryDirectory((tmp: string) => {
      const root = Path(tmp);
      init_git_repo(root);
      const lesson = load_lesson(root);
      const task = lesson.create_task("Implement auth");

      const invalid = lesson.create_worktree("../escape", task.id);
      this.assertIn("Error", invalid);
      this.assertIsNone(lesson.load_task(task.id).worktree);
      this.assertFalse(root.joinpath("escape").exists());

      const missing = lesson.create_worktree("auth", "../missing");
      this.assertIn("Error", missing);
      this.assertFalse(lesson.WORKTREES_DIR.joinpath("auth").exists());

      const bound = lesson.load_task(task.id);
      bound.worktree = "ghost";
      lesson.save_task(bound);
      const denied = lesson.claim_task(task.id, { owner: "alice" });
      this.assertIn("not registered", denied);
      this.assertEqual(lesson.load_task(task.id).status, "pending");
      this.assertEqual(lesson.scan_unclaimed_tasks(), []);
    });
  }

  // create 应校验分支，并仅在 git add 之后才绑定。
  test_create_validates_branch_and_binds_only_after_git_add(): void {
    tempfile.TemporaryDirectory((tmp: string) => {
      const root = Path(tmp);
      init_git_repo(root);
      const lesson = load_lesson(root);
      const task = lesson.create_task("Implement auth");
      subprocess.run(["git", "branch", "wt/auth"], { cwd: root, check: true });

      const collision = lesson.create_worktree("auth", task.id);
      this.assertIn("already exists", collision);
      this.assertIsNone(lesson.load_task(task.id).worktree);
      this.assertFalse(lesson.WORKTREES_DIR.joinpath("auth").exists());

      const original_run_git = lesson.run_git;

      function fail_add(args: any, cwd: any = null): [boolean, string] {
        if (arraysEqual(args.slice(0, 2), ["worktree", "add"])) {
          return [false, "simulated add failure"];
        }
        return original_run_git(args, { cwd });
      }

      lesson.run_git = fail_add;
      const failed = lesson.create_worktree("login", task.id);
      this.assertIn("simulated add failure", failed);
      this.assertIsNone(lesson.load_task(task.id).worktree);
      this.assertFalse(lesson.WORKTREES_DIR.joinpath("login").exists());
    });
  }

  // git add 失败时应上报并保留部分产物。
  test_failed_git_add_reports_and_preserves_partial_artifacts(): void {
    for (const lesson_path of RUNTIME_LESSONS) {
      this.subTest({ lesson: lesson_path.parent.name });
      tempfile.TemporaryDirectory((tmp: string) => {
        const root = Path(tmp);
        init_git_repo(root);
        const lesson = load_lesson(root, lesson_path);
        const task = lesson.create_task("Implement auth");
        const original_run_git = lesson.run_git;

        const fail_after_add = (args: any, cwd: any = null): [boolean, string] => {
          if (arraysEqual(args.slice(0, 2), ["worktree", "add"])) {
            const [ok, output] = original_run_git(args, { cwd });
            this.assertTrue(ok, output);
            return [false, "simulated late add failure"];
          }
          return original_run_git(args, { cwd });
        };

        lesson.run_git = fail_after_add;
        const result = lesson.create_worktree("auth", task.id);

        this.assertIn("Partial operation", result);
        this.assertIn("simulated late add failure", result);
        this.assertIn("remains unbound", result);
        this.assertIn("git worktree list", result);
        this.assertTrue(lesson.WORKTREES_DIR.joinpath("auth").is_dir());
        this.assertIsNone(lesson.load_task(task.id).worktree);
        const branch = subprocess.run(
          ["git", "show-ref", "--verify", "--quiet", "refs/heads/wt/auth"],
          { cwd: root },
        );
        this.assertEqual(branch.returncode, 0);
      });
    }
  }

  // 绑定失败时应保留已创建的 git 数据以便恢复。
  test_binding_failure_retains_created_git_data_for_recovery(): void {
    tempfile.TemporaryDirectory((tmp: string) => {
      const root = Path(tmp);
      init_git_repo(root);
      const lesson = load_lesson(root);
      const task = lesson.create_task("Implement auth");
      const original_save_task = lesson.save_task;

      function fail_binding(candidate: any): void {
        if (candidate.worktree === "auth") {
          throw new Error("simulated task persistence failure"); // OSError
        }
        original_save_task(candidate);
      }

      lesson.save_task = fail_binding;
      const result = lesson.create_worktree("auth", task.id);

      this.assertIn("Partial success", result);
      this.assertIn("manual recovery", result);
      this.assertTrue(lesson.WORKTREES_DIR.joinpath("auth").is_dir());
      this.assertIsNone(lesson.load_task(task.id).worktree);
      const branch = subprocess.run(
        ["git", "show-ref", "--verify", "--quiet", "refs/heads/wt/auth"],
        { cwd: root },
      );
      this.assertEqual(branch.returncode, 0);
    });
  }

  // remove_worktree 默认应拒绝有未提交改动的检出目录。
  test_remove_worktree_refuses_dirty_checkout_by_default(): void {
    tempfile.TemporaryDirectory((tmp: string) => {
      const root = Path(tmp);
      init_git_repo(root);
      const lesson = load_lesson(root);
      const task = lesson.create_task("Implement auth");
      lesson.create_worktree("auth", task.id);
      lesson.claim_task(task.id, { owner: "alice" });
      lesson.complete_task(task.id, { owner: "alice" });
      lesson.release_completed_assignment("alice");
      const worktree = lesson.WORKTREES_DIR.joinpath("auth");
      worktree.joinpath("dirty.txt").write_text("unsaved\n");

      const denied = lesson.remove_worktree("auth");

      this.assertIn("uncommitted", denied);
      this.assertTrue(worktree.exists());
      this.assertEqual(lesson.load_task(task.id).worktree, "auth");
    });
  }

  // remove_worktree 应把被忽略的文件也视为未提交数据。
  test_remove_worktree_treats_ignored_files_as_uncommitted_data(): void {
    for (const lesson_path of RUNTIME_LESSONS) {
      this.subTest({ lesson: lesson_path.parent.name });
      tempfile.TemporaryDirectory((tmp: string) => {
        const root = Path(tmp);
        init_git_repo(root);
        root.joinpath(".gitignore").write_text("ignored.log\n");
        subprocess.run(["git", "add", ".gitignore"], { cwd: root, check: true });
        subprocess.run(["git", "commit", "-q", "-m", "ignore runtime log"], { cwd: root, check: true });
        const lesson = load_lesson(root, lesson_path);
        const task = lesson.create_task("Implement auth");
        lesson.create_worktree("auth", task.id);
        lesson.claim_task(task.id, { owner: "alice" });
        lesson.complete_task(task.id, { owner: "alice" });
        lesson.release_completed_assignment("alice");
        const worktree = lesson.WORKTREES_DIR.joinpath("auth");
        worktree.joinpath("ignored.log").write_text("valuable output\n");

        const denied = lesson.remove_worktree("auth");

        this.assertIn("uncommitted", denied);
        this.assertTrue(worktree.exists());
        this.assertEqual(lesson.load_task(task.id).worktree, "auth");
        const removed = lesson.remove_worktree("auth", { discard_changes: true });
        this.assertIn("branch 'wt/auth' retained", removed);
        this.assertFalse(worktree.exists());
      });
    }
  }

  // discard 应移除检出目录但保留分支。
  test_discard_removes_checkout_but_retains_branch(): void {
    tempfile.TemporaryDirectory((tmp: string) => {
      const root = Path(tmp);
      init_git_repo(root);
      const lesson = load_lesson(root);
      const task = lesson.create_task("Implement auth");
      lesson.create_worktree("auth", task.id);
      lesson.claim_task(task.id, { owner: "alice" });
      lesson.complete_task(task.id, { owner: "alice" });
      lesson.release_completed_assignment("alice");
      const worktree = lesson.WORKTREES_DIR.joinpath("auth");
      worktree.joinpath("dirty.txt").write_text("discard me\n");

      const removed = lesson.remove_worktree("auth", { discard_changes: true });

      this.assertIn("branch 'wt/auth' retained", removed);
      this.assertFalse(worktree.exists());
      this.assertIsNone(lesson.load_task(task.id).worktree);
      const branch = subprocess.run(
        ["git", "show-ref", "--verify", "--quiet", "refs/heads/wt/auth"],
        { cwd: root },
      );
      this.assertEqual(branch.returncode, 0);
    });
  }

  // 干净的本地提交应在非强制移除检出目录后仍然保留。
  test_clean_local_commit_survives_non_force_checkout_removal(): void {
    tempfile.TemporaryDirectory((tmp: string) => {
      const root = Path(tmp);
      init_git_repo(root);
      const lesson = load_lesson(root);
      const task = lesson.create_task("Implement auth");
      lesson.create_worktree("auth", task.id);
      lesson.claim_task(task.id, { owner: "alice" });
      lesson.complete_task(task.id, { owner: "alice" });
      lesson.release_completed_assignment("alice");
      const worktree = lesson.WORKTREES_DIR.joinpath("auth");
      worktree.joinpath("feature.txt").write_text("committed work\n");
      subprocess.run(["git", "add", "feature.txt"], { cwd: worktree, check: true });
      subprocess.run(["git", "commit", "-q", "-m", "feature"], { cwd: worktree, check: true });
      const commit = subprocess.check_output(["git", "rev-parse", "HEAD"], { cwd: worktree, text: true }).strip();
      const upstream = subprocess
        .check_output(["git", "for-each-ref", "--format=%(upstream)", "refs/heads/wt/auth"], { cwd: root, text: true })
        .strip();
      this.assertEqual(upstream, "");

      const removed = lesson.remove_worktree("auth");

      this.assertIn("branch 'wt/auth' retained", removed);
      this.assertFalse(worktree.exists());
      const retained = subprocess.check_output(["git", "rev-parse", "wt/auth"], { cwd: root, text: true }).strip();
      this.assertEqual(retained, commit);
    });
  }

  // 活跃任务应同时阻止普通移除与 discard 移除。
  test_active_task_blocks_normal_and_discard_removal(): void {
    tempfile.TemporaryDirectory((tmp: string) => {
      const root = Path(tmp);
      init_git_repo(root);
      const lesson = load_lesson(root);
      const task = lesson.create_task("Implement auth");
      lesson.create_worktree("auth", task.id);
      const worktree = lesson.WORKTREES_DIR.joinpath("auth");

      const pending_normal = lesson.remove_worktree("auth");
      const pending_discard = lesson.remove_worktree("auth", { discard_changes: true });
      this.assertIn("active task", pending_normal);
      this.assertIn("active task", pending_discard);

      lesson.claim_task(task.id, { owner: "alice" });
      const progress_normal = lesson.remove_worktree("auth");
      const progress_discard = lesson.remove_worktree("auth", { discard_changes: true });

      this.assertIn("active task", progress_normal);
      this.assertIn("active task", progress_discard);
      this.assertTrue(worktree.exists());
      this.assertEqual(lesson.load_task(task.id).status, "in_progress");
    });
  }
}

// ------- 辅助函数（对照可读性用） -------

// Python 中的 callable(...)。
function callable(obj: any): boolean {
  return typeof obj === "function";
}

// 判断 a 是否为 b 的子集。
function isSubset<T>(a: Set<T>, b: Set<T>): boolean {
  return [...a].every((item) => b.has(item));
}

// 判断两个集合是否不相交。
function isDisjoint<T>(a: Set<T>, b: Set<T>): boolean {
  return [...a].every((item) => !b.has(item));
}

// 数组浅相等比较。
function arraysEqual(a: any[], b: any[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

// 以 with 语义持有一个锁执行回调。
function withLock(lock: any, body: () => void): void {
  lock.acquire();
  try {
    body();
  } finally {
    lock.release();
  }
}

// Python repr(str) 的近似：生成带引号的字面量表达。
function pyRepr(value: string): string {
  return JSON.stringify(value);
}

// if __name__ == "__main__": unittest.main()
if (require.main === module) {
  unittest.main();
}
