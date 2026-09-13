import * as importlib_util from "importlib/util"; // Python: import importlib.util
import * as os from "os";
import * as sys from "sys";
import * as tempfile from "tempfile";
import * as types from "types";
import * as path from "path"; // Python: from pathlib import Path
import * as fs from "fs";

// ROOT = Path(__file__).resolve().parents[1]
const ROOT: string = path.resolve(__dirname, "..");
// LESSON = ROOT / "s07_skill_loading" / "code.py"
const LESSON: string = path.join(ROOT, "s07_skill_loading", "code.py");

// def load_lesson(workdir: Path):
function load_lesson(workdir: string): any {
  const fake_anthropic: any = types.ModuleType("anthropic");
  const fake_dotenv: any = types.ModuleType("dotenv");

  class FakeAnthropic {
    messages: any;
    constructor(...args: any[]) {
      this.messages = types.SimpleNamespace({ create: null });
    }
  }

  fake_anthropic.Anthropic = FakeAnthropic;
  fake_dotenv.load_dotenv = (override: boolean = true): void => {};

  const previous_modules: Record<string, any> = {
    anthropic: sys.modules["anthropic"],
    dotenv: sys.modules["dotenv"],
  };
  const previous_cwd: string = process.cwd();
  const previous_model: string | undefined = process.env["MODEL_ID"];

  const spec: any = importlib_util.spec_from_file_location(
    "s07_skill_test",
    LESSON
  );
  // assert spec is not None and spec.loader is not None
  expect(spec !== null && spec.loader !== null).toBe(true);
  const module: any = importlib_util.module_from_spec(spec);

  sys.modules["anthropic"] = fake_anthropic;
  sys.modules["dotenv"] = fake_dotenv;
  try {
    os.chdir(workdir);
    process.env["MODEL_ID"] = "test-model";
    spec.loader.exec_module(module);
    return module;
  } finally {
    os.chdir(previous_cwd);
    if (previous_model === undefined) {
      delete process.env["MODEL_ID"];
    } else {
      process.env["MODEL_ID"] = previous_model;
    }
    for (const [name, previous] of Object.entries(previous_modules)) {
      if (previous === undefined || previous === null) {
        delete sys.modules[name];
      } else {
        sys.modules[name] = previous;
      }
    }
  }
}

// def test_catalog_stays_small_and_load_skill_returns_the_full_file() -> None:
test("test_catalog_stays_small_and_load_skill_returns_the_full_file", (): void => {
  tempfile.TemporaryDirectory((tmp: string): void => {
    const root: string = tmp;
    const skill_dir: string = path.join(root, "skills", "code-review");
    fs.mkdirSync(skill_dir, { recursive: true });
    // manifest = """---\n ... """
    const manifest: string = `---
name: code-review
description: |
  Review code for bugs,
  regressions, and missing tests.
---

# Code Review

UNIQUE_FULL_INSTRUCTION
`;
    fs.writeFileSync(path.join(skill_dir, "SKILL.md"), manifest);

    const lesson: any = load_lesson(root);

    expect(lesson.SKILL_LOADER.catalog()).toBe(
      "- code-review: Review code for bugs, regressions, and missing tests."
    );
    expect(lesson.SYSTEM).toContain("code-review");
    expect(lesson.SYSTEM).not.toContain("UNIQUE_FULL_INSTRUCTION");
    expect(lesson.SKILL_LOADER.load("code-review")).toBe(manifest);
    expect(lesson.TOOL_HANDLERS["load_skill"]("code-review")).toBe(manifest);
  });
});

// def test_s07_exposes_only_base_tools_and_load_skill() -> None:
test("test_s07_exposes_only_base_tools_and_load_skill", (): void => {
  tempfile.TemporaryDirectory((tmp: string): void => {
    const lesson: any = load_lesson(tmp);

    expect(lesson.TOOLS.map((tool: any) => tool["name"])).toEqual([
      "bash",
      "read_file",
      "write_file",
      "edit_file",
      "glob",
      "load_skill",
    ]);
  });
});
