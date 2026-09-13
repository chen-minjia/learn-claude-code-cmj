// 由 test_compaction_tool_pairs.py 翻译而来的 TypeScript 对照版本。
// 仅供逐行对照阅读，非可运行代码。原文件使用 Python 的 unittest 框架，
// 通过动态加载章节模块（s08 / s15）来验证「上下文压缩」保持 tool_use/tool_result 成对。

// Python: import importlib.util, os, sys, tempfile, types, unittest; from pathlib import Path
import * as importlib from "importlib.util";
import * as os from "os";
import * as sys from "sys";
import * as tempfile from "tempfile";
import * as types from "types";
import * as unittest from "unittest";
import { Path } from "pathlib";

// REPO_ROOT = Path(__file__).resolve().parents[1]
const REPO_ROOT: Path = Path(__filename).resolve().parents[1];
const MODULES: Record<string, Path> = {
  s08: REPO_ROOT.joinpath("s08_context_compact", "code.py"),
  s15: REPO_ROOT.joinpath("s15_integrated_harness", "code.py"),
};

/**
 * 在指定的临时工作目录下加载章节模块。
 * 会临时替换 anthropic / dotenv 模块以及若干环境变量，加载完成后再恢复。
 */
function load_module(name: string, path: Path, temp_cwd: Path): any {
  const fake_anthropic = types.ModuleType("anthropic");

  class FakeAnthropic {
    messages: any;
    constructor(..._args: any[]) {
      this.messages = types.SimpleNamespace({ create: null });
    }
  }

  const fake_dotenv = types.ModuleType("dotenv");
  (fake_anthropic as any).Anthropic = FakeAnthropic;
  (fake_dotenv as any).load_dotenv = (override: boolean = true): null => null;

  const previous_anthropic = sys.modules.get("anthropic");
  const previous_dotenv = sys.modules.get("dotenv");
  const previous_cwd = Path.cwd();
  const previous_model = os.environ.get("MODEL_ID");
  const previous_key = os.environ.get("ANTHROPIC_API_KEY");

  const spec = importlib.util.spec_from_file_location(name, path);
  if (spec === null || spec.loader === null) {
    throw new Error(`Unable to load ${path}`);
  }
  const module = importlib.util.module_from_spec(spec);

  sys.modules["anthropic"] = fake_anthropic;
  sys.modules["dotenv"] = fake_dotenv;
  os.environ["MODEL_ID"] = "test-model";
  os.environ["ANTHROPIC_API_KEY"] = "test-key";
  try {
    os.chdir(temp_cwd);
    spec.loader.exec_module(module);
    return module;
  } finally {
    os.chdir(previous_cwd);
    if (previous_anthropic === null || previous_anthropic === undefined) {
      sys.modules.pop("anthropic", null);
    } else {
      sys.modules["anthropic"] = previous_anthropic;
    }
    if (previous_dotenv === null || previous_dotenv === undefined) {
      sys.modules.pop("dotenv", null);
    } else {
      sys.modules["dotenv"] = previous_dotenv;
    }
    if (previous_model === null || previous_model === undefined) {
      os.environ.pop("MODEL_ID", null);
    } else {
      os.environ["MODEL_ID"] = previous_model;
    }
    if (previous_key === null || previous_key === undefined) {
      os.environ.pop("ANTHROPIC_API_KEY", null);
    } else {
      os.environ["ANTHROPIC_API_KEY"] = previous_key;
    }
  }
}

// 构造一条 assistant 文本消息。
function assistant_text(): Record<string, any> {
  return { role: "assistant", content: [types.SimpleNamespace({ type: "text", text: "ok" })] };
}

// 构造一条 user 文本消息。
function user_text(): Record<string, any> {
  return { role: "user", content: "continue" };
}

// 构造一条包含 tool_use 块的 assistant 消息。
function tool_use_message(tool_id: string = "tool-1"): Record<string, any> {
  return {
    role: "assistant",
    content: [types.SimpleNamespace({ type: "tool_use", id: tool_id, name: "bash" })],
  };
}

// 构造一条包含 tool_result 块的 user 消息。
function tool_result_message(tool_id: string = "tool-1"): Record<string, any> {
  return {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: tool_id, content: "ok" }],
  };
}

// 判断某条消息是否为带有 tool_use 块的 assistant 消息。
function message_has_tool_use(message: Record<string, any>): boolean {
  const content = message["content"];
  return (
    message["role"] === "assistant" &&
    Array.isArray(content) &&
    content.some((block: any) => (block?.type ?? null) === "tool_use")
  );
}

// 断言：任何携带 tool_result 的 user 消息，其前一条必须是带 tool_use 的 assistant 消息（无孤儿 tool_result）。
function assert_no_orphan_tool_results(testcase: any, messages: Array<Record<string, any>>): void {
  messages.forEach((message, idx) => {
    const content = message["content"];
    if (message["role"] !== "user" || !Array.isArray(content)) {
      return;
    }
    if (!content.some((block: any) => typeof block === "object" && block?.["type"] === "tool_result")) {
      return;
    }
    testcase.assertGreater(idx, 0);
    testcase.assertTrue(message_has_tool_use(messages[idx - 1]), messages);
  });
}

// 返回本章节的压缩实现。
function compaction_api(module: any): any {
  /** Return the chapter's compaction implementation. */
  return module.COMPACTOR ?? module;
}

// class CompactionToolPairTests(unittest.TestCase)
class CompactionToolPairTests extends unittest.TestCase {
  test_snip_compact_keeps_head_tool_pair(): void {
    const messages: Array<Record<string, any>> = [
      user_text(),
      assistant_text(),
      tool_use_message("head-tool"),
      tool_result_message("head-tool"),
      assistant_text(),
      user_text(),
      assistant_text(),
      user_text(),
      assistant_text(),
      user_text(),
    ];

    for (const [name, path] of Object.entries(MODULES)) {
      // with self.subTest(name=name), tempfile.TemporaryDirectory() as tmp:
      this.subTest({ name });
      tempfile.TemporaryDirectory((tmp: string) => {
        const module = load_module(`${name}_head_under_test`, path, Path(tmp));
        const compacted = compaction_api(module).snip_compact([...messages], { max_messages: 6 });
        this.assertEqual(compacted[2], messages[2]);
        this.assertEqual(compacted[3], messages[3]);
        assert_no_orphan_tool_results(this, compacted);
      });
    }
  }

  test_snip_compact_keeps_tail_tool_pair(): void {
    const messages: Array<Record<string, any>> = [
      user_text(),
      assistant_text(),
      user_text(),
      assistant_text(),
      user_text(),
      assistant_text(),
      tool_use_message("tail-tool"),
      tool_result_message("tail-tool"),
      assistant_text(),
      user_text(),
    ];

    for (const [name, path] of Object.entries(MODULES)) {
      this.subTest({ name });
      tempfile.TemporaryDirectory((tmp: string) => {
        const module = load_module(`${name}_under_test`, path, Path(tmp));
        const compacted = compaction_api(module).snip_compact([...messages], { max_messages: 6 });
        assert_no_orphan_tool_results(this, compacted);
      });
    }
  }

  test_reactive_compact_keeps_tail_tool_pair(): void {
    const messages: Array<Record<string, any>> = [
      user_text(),
      assistant_text(),
      user_text(),
      tool_use_message("reactive-tool"),
      tool_result_message("reactive-tool"),
      assistant_text(),
      user_text(),
      assistant_text(),
      user_text(),
    ];

    for (const [name, path] of Object.entries(MODULES)) {
      this.subTest({ name });
      tempfile.TemporaryDirectory((tmp: string) => {
        const module = load_module(`${name}_reactive_under_test`, path, Path(tmp));
        const api = compaction_api(module);
        api.write_transcript = (_messages: any): Path => Path("transcript.jsonl");
        api.summarize_history = (_messages: any): string => "summary";
        const compacted = api.reactive_compact([...messages], "continue");
        this.assertEqual(compacted[1], messages[3]);
        assert_no_orphan_tool_results(this, compacted);
      });
    }
  }

  test_reactive_compact_summarizes_only_old_history(): void {
    const messages: Array<Record<string, any>> = [
      user_text(),
      assistant_text(),
      user_text(),
      assistant_text(),
      user_text(),
      assistant_text(),
      user_text(),
      assistant_text(),
      user_text(),
    ];

    for (const [name, path] of Object.entries(MODULES)) {
      this.subTest({ name });
      tempfile.TemporaryDirectory((tmp: string) => {
        const module = load_module(`${name}_reactive_oldhist_under_test`, path, Path(tmp));
        const api = compaction_api(module);
        api.write_transcript = (_messages: any): Path => Path("transcript.jsonl");
        const captured: Record<string, any> = {};

        function fake_summarize(passed: any, _store: Record<string, any> = captured): string {
          _store["messages"] = [...passed];
          return "summary";
        }

        api.summarize_history = fake_summarize;
        const compacted = api.reactive_compact([...messages], "continue");
        // The summary must cover only the old history, not the kept tail.
        this.assertEqual(captured["messages"], messages.slice(0, 4));
        // The recent tail is appended verbatim after the summary message.
        this.assertEqual(compacted.slice(1), messages.slice(4));
        assert_no_orphan_tool_results(this, compacted);
      });
    }
  }

  test_reactive_compact_summary_excludes_tail_pair_pulled_in(): void {
    // A tool_use/tool_result pair straddles the tail boundary, so the
    // adjustment pulls the tool_use into the kept tail. The summary must
    // cover only what stays trimmed (messages[:adjusted_tail_start]), i.e.
    // it must not re-summarize the tool_use that is kept verbatim.
    const messages: Array<Record<string, any>> = [
      user_text(),
      assistant_text(),
      user_text(),
      tool_use_message("reactive-tool"),
      tool_result_message("reactive-tool"),
      assistant_text(),
      user_text(),
      assistant_text(),
      user_text(),
    ];

    for (const [name, path] of Object.entries(MODULES)) {
      this.subTest({ name });
      tempfile.TemporaryDirectory((tmp: string) => {
        const module = load_module(`${name}_reactive_pairscope_under_test`, path, Path(tmp));
        const api = compaction_api(module);
        api.write_transcript = (_messages: any): Path => Path("transcript.jsonl");
        const captured: Record<string, any> = {};

        function fake_summarize(passed: any, _store: Record<string, any> = captured): string {
          _store["messages"] = [...passed];
          return "summary";
        }

        api.summarize_history = fake_summarize;
        const compacted = api.reactive_compact([...messages], "continue");
        // tail_start starts at 4, decrements to 3 to keep the pair intact.
        this.assertEqual(captured["messages"], messages.slice(0, 3));
        this.assertEqual(compacted[1], messages[3]);
        this.assertEqual(compacted.slice(1), messages.slice(3));
        assert_no_orphan_tool_results(this, compacted);
      });
    }
  }

  test_s15_has_tool_use_still_accepts_content_blocks(): void {
    tempfile.TemporaryDirectory((tmp: string) => {
      const module = load_module("s15_has_tool_use_under_test", MODULES["s15"], Path(tmp));
      this.assertTrue(module.has_tool_use([types.SimpleNamespace({ type: "tool_use" })]));
      this.assertFalse(module.has_tool_use([types.SimpleNamespace({ type: "text" })]));
    });
  }
}

// if __name__ == "__main__": unittest.main()
if (require.main === module) {
  unittest.main();
}
