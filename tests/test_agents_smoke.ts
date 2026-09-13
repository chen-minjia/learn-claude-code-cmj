// from __future__ import annotations
// (TS 无需此声明,仅作对照保留)

import * as path from "path";
import { glob } from "glob"; // Python: from pathlib import Path + Path.glob 的近似替代
// Python: import py_compile —— TS 无对应,这里用占位符表达"编译校验"语义
import * as py_compile from "py_compile"; // 无对应库,重可读性

// import pytest —— TS 无 pytest,使用等价的测试框架写法(如 jest/vitest)
// 这里以注释形式保留参数化测试语义

// ROOT = Path(__file__).resolve().parents[1]
const ROOT: string = path.resolve(__dirname, "..");
// AGENTS_DIR = ROOT / "agents"
const AGENTS_DIR: string = path.join(ROOT, "agents");
// AGENT_FILES = sorted(path for path in AGENTS_DIR.glob("*.py") if path.name != "__init__.py")
const AGENT_FILES: string[] = glob
  .sync(path.join(AGENTS_DIR, "*.py"))
  .filter((p) => path.basename(p) !== "__init__.py")
  .sort();
// AGENT_IDS = [path.name for path in AGENT_FILES]
const AGENT_IDS: string[] = AGENT_FILES.map((p) => path.basename(p));

// @pytest.mark.parametrize("agent_path", AGENT_FILES, ids=AGENT_IDS)
// def test_agent_scripts_compile(agent_path: Path) -> None:
//     _ = py_compile.compile(str(agent_path), doraise=True)
describe.each(AGENT_FILES.map((agent_path, i) => [AGENT_IDS[i], agent_path]))(
  "test_agent_scripts_compile",
  (_id: string, agent_path: string) => {
    test(`compiles ${_id}`, (): void => {
      const _ = py_compile.compile(String(agent_path), { doraise: true });
    });
  }
);

// def test_agent_scripts_exist() -> None:
//     assert AGENT_FILES, "expected at least one agent script"
test("test_agent_scripts_exist", (): void => {
  expect(AGENT_FILES.length).toBeTruthy(); // "expected at least one agent script"
});
