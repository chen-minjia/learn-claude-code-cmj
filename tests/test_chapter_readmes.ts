import * as py_compile from "py_compile"; // Python: import py_compile —— 无对应库,占位表达编译校验
import * as path from "path"; // Python: from pathlib import Path
import * as fs from "fs";
import { glob } from "glob";

// ROOT = Path(__file__).resolve().parents[1]
const ROOT: string = path.resolve(__dirname, "..");
// CHAPTERS = sorted(ROOT.glob("s[0-9][0-9]_*"))
const CHAPTERS: string[] = glob.sync(path.join(ROOT, "s[0-9][0-9]_*")).sort();

// def test_every_chapter_uses_english_as_the_default_readme() -> None:
test("test_every_chapter_uses_english_as_the_default_readme", (): void => {
  expect(CHAPTERS.length).toBe(17);

  for (const chapter of CHAPTERS) {
    expect(fs.statSync(path.join(chapter, "README.md")).isFile()).toBe(true);
    expect(fs.statSync(path.join(chapter, "README.zh.md")).isFile()).toBe(true);
    expect(fs.statSync(path.join(chapter, "README.ja.md")).isFile()).toBe(true);
    expect(fs.existsSync(path.join(chapter, "README.en.md"))).toBe(false);
  }
});

// def test_every_chapter_has_the_same_language_navigation() -> None:
test("test_every_chapter_has_the_same_language_navigation", (): void => {
  const expected: string =
    "[English](README.md) · [中文](README.zh.md) · " +
    "[日本語](README.ja.md)";

  for (const chapter of CHAPTERS) {
    for (const filename of ["README.md", "README.zh.md", "README.ja.md"]) {
      const lines: string[] = fs
        .readFileSync(path.join(chapter, filename), "utf-8")
        .split(/\r?\n/);
      expect(lines[2]).toBe(expected);
    }
  }
});

// def test_every_chapter_script_compiles_on_python_311() -> None:
test("test_every_chapter_script_compiles_on_python_311", (): void => {
  for (const chapter of CHAPTERS) {
    const _ = py_compile.compile(String(path.join(chapter, "code.py")), {
      doraise: true,
    });
  }
});
