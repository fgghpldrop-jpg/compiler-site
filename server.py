#!/usr/bin/env python3
"""Local dev server: static files + real dotnet build/run API."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
PROJECT = ROOT / "project"
PORT = int(os.environ.get("PORT", "8765"))
HOST = os.environ.get("HOST", "127.0.0.1")
WORK_FILE = "Program.cs"
CSPROJ = "Compiler.csproj"
BUILD_CONFIG = os.environ.get("BUILD_CONFIG", "Release")
BUILD_DIR = PROJECT / "bin" / BUILD_CONFIG / "net8.0"
COMPILER_DLL = BUILD_DIR / "Compiler.dll"
BUILD_ARGS = [
    "build", CSPROJ, "-c", BUILD_CONFIG,
    "--no-restore", "-v", "q", "/nologo", "/m:1",
]

_last_run_proc: subprocess.Popen[str] | None = None


def _subprocess_flags() -> int:
    return getattr(subprocess, "CREATE_NO_WINDOW", 0)


def stop_running_program() -> None:
    """Terminate tracked program and any stale Compiler.exe locks."""
    global _last_run_proc
    if _last_run_proc is not None and _last_run_proc.poll() is None:
        _last_run_proc.kill()
        try:
            _last_run_proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass
    _last_run_proc = None
    kill_stale_compiler()


def kill_stale_compiler() -> None:
    """Stop lingering Compiler.exe on Windows (legacy apphost builds)."""
    if sys.platform != "win32":
        return
    flags = _subprocess_flags()
    subprocess.run(
        ["taskkill", "/F", "/IM", "Compiler.exe"],
        capture_output=True,
        creationflags=flags,
    )


def stdin_for_program(source: str) -> tuple[str | None, list[str]]:
    """Feed Console.ReadLine() prompts so interactive programs finish."""
    count = len(re.findall(r"Console\.ReadLine\s*\(", source, flags=re.IGNORECASE))
    if count == 0:
        return None, []
    values = [str((i % 5) + 1) for i in range(count)]
    return "\n".join(values) + "\n", values


def split_assignment_tail(tail: str) -> list[tuple[str, str]]:
    """Split x=1, y=2, b=0,198 into pairs (comma decimals allowed in values)."""
    parts = re.split(r",\s*(?=[a-zA-Z_][a-zA-Z0-9_]*\s*=)", tail)
    pairs: list[tuple[str, str]] = []
    for part in parts:
        if "=" not in part:
            continue
        name, value = part.split("=", 1)
        pairs.append((name.strip(), value.strip()))
    return pairs


def find_assignment_tail(line: str) -> str:
    """Skip Console.Write prompts; keep the last block of assignments."""
    matches = list(re.finditer(r"[a-zA-Z_][a-zA-Z0-9_]*\s*=", line))
    if not matches:
        return line

    best_tail = line
    best_score = -1
    ident = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]*$")

    for m in matches:
        tail = line[m.start() :]
        pairs = split_assignment_tail(tail)
        score = sum(1 for name, value in pairs if ident.match(name) and "=" not in value)
        if score > best_score:
            best_score = score
            best_tail = tail

    return best_tail


def extract_var_pairs(line: str) -> list[tuple[str, str]]:
    """Pull key=value pairs from a Console.WriteLine-style line."""
    tail = find_assignment_tail(line)
    return split_assignment_tail(tail)


def format_program_output(raw: str, stdin_values: list[str] | None = None) -> dict:
    """Turn raw stdout into structured blocks for the UI."""
    blocks: list[dict] = []
    for line in raw.splitlines():
        text = line.strip()
        if not text:
            continue
        pairs = extract_var_pairs(text)
        if pairs:
            blocks.append({
                "type": "vars",
                "vars": {name: value for name, value in pairs},
            })
        else:
            blocks.append({"type": "text", "text": text})

    stdin_note = None
    if stdin_values:
        stdin_note = "автоввод: " + ", ".join(stdin_values)

    return {
        "raw": raw,
        "blocks": blocks,
        "stdinNote": stdin_note,
    }


def prepare_csharp(content: str) -> str:
    """Fix common typos so student snippets compile."""
    fixed = content.replace("\r\n", "\n")

    fixed = re.sub(r"\.Writeline\s*\(", ".WriteLine(", fixed, flags=re.IGNORECASE)
    fixed = re.sub(r"\bconsole\.", "Console.", fixed, flags=re.IGNORECASE)
    fixed = re.sub(r"\bmath\.", "Math.", fixed, flags=re.IGNORECASE)

    uses_console = re.search(r"\bConsole\.", fixed)
    uses_math = re.search(r"\bMath\.", fixed)
    if uses_console and not re.search(r"using\s+System\s*;", fixed):
        fixed = "using System;\n\n" + fixed.lstrip()
    if uses_math and not re.search(r"using\s+System\s*;", fixed):
        fixed = "using System;\n\n" + fixed.lstrip()

    return fixed


def resolve_project_path(rel_path: str) -> Path | None:
    if rel_path.replace("\\", "/").strip() != WORK_FILE:
        return None
    target = (PROJECT / WORK_FILE).resolve()
    try:
        target.relative_to(PROJECT.resolve())
    except ValueError:
        return None
    return target


def list_project_files() -> list[dict]:
    path = PROJECT / WORK_FILE
    if not path.is_file():
        return []
    return [{"path": WORK_FILE, "name": WORK_FILE, "language": "csharp"}]


def language_for(suffix: str) -> str:
    mapping = {".cs": "csharp", ".json": "json", ".csproj": "xml"}
    return mapping.get(suffix.lower(), "text")


def read_json_body(handler: SimpleHTTPRequestHandler) -> dict | list | None:
    length = int(handler.headers.get("Content-Length", 0))
    if length <= 0:
        return None
    raw = handler.rfile.read(length)
    return json.loads(raw.decode("utf-8"))


def json_response(handler: SimpleHTTPRequestHandler, payload: dict | list, status: int = 200) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler._cors()
    handler.end_headers()
    handler.wfile.write(body)


def classify_line(line: str) -> str:
    lower = line.lower()
    if re.search(r"error\(s\)|: error |ошибок:\s*[1-9]|: error cs", lower):
        return "error"
    if re.search(r"warning\(s\)|: warning |предупреждени[йя]:\s*[1-9]|: warning cs", lower):
        return "warn"
    if "build succeeded" in lower or "сборка успешно" in lower:
        return "success"
    if "build failed" in lower or "сбой сборки" in lower:
        return "error"
    if line.strip().startswith("PS ") or "dotnet " in lower:
        return "info"
    if lower.startswith("status: ok"):
        return "success"
    return "dim"


def parse_diagnostics(output: str) -> tuple[int, int]:
    errors = 0
    warnings = 0
    err_match = re.search(r"(\d+)\s+Error\(s\)", output, re.IGNORECASE)
    warn_match = re.search(r"(\d+)\s+Warning\(s\)", output, re.IGNORECASE)
    if not err_match:
        err_match = re.search(r"Ошибок:\s*(\d+)", output, re.IGNORECASE)
    if not warn_match:
        warn_match = re.search(r"Предупреждени[йя]:\s*(\d+)", output, re.IGNORECASE)
    if err_match:
        errors = int(err_match.group(1))
    if warn_match:
        warnings = int(warn_match.group(1))
    return errors, warnings


DIAGNOSTIC_RE = re.compile(
    r"(?:(?P<file>Program\.cs)|(?P<path>[^(\s]+))\((?P<line>\d+),(?P<col>\d+)\):\s*"
    r"(?P<sev>error|warning)\s+(?P<code>CS\d+):\s*(?P<message>.+?)(?:\s*\[[^\]]+\])?\s*$",
    re.IGNORECASE,
)


def extract_diagnostics(output: str) -> list[dict]:
    items: list[dict] = []
    seen: set[tuple] = set()
    for raw in output.splitlines():
        match = DIAGNOSTIC_RE.search(raw.strip())
        if not match:
            continue
        item = {
            "file": match.group("file") or Path(match.group("path") or WORK_FILE).name,
            "line": int(match.group("line")),
            "column": int(match.group("col")),
            "severity": match.group("sev").lower(),
            "code": match.group("code").upper(),
            "message": match.group("message").strip(),
            "raw": raw.strip(),
        }
        key = (item["line"], item["column"], item["code"], item["message"])
        if key in seen:
            continue
        seen.add(key)
        items.append(item)
    return items


def dedupe_lines(lines: list[dict]) -> list[dict]:
    seen: set[str] = set()
    out: list[dict] = []
    for line in lines:
        key = line.get("text", "")
        if key in seen:
            continue
        seen.add(key)
        out.append(line)
    return out


def format_diagnostic(item: dict) -> str:
    return (
        f"{item['file']}({item['line']},{item['column']}): "
        f"{item['severity']} {item['code']}: {item['message']}"
    )


def run_dotnet(args: list[str], *, kind: str = "build") -> dict:
    if not (PROJECT / CSPROJ).exists():
        return {
            "success": False,
            "exitCode": 1,
            "lines": [
                {"text": f"{CSPROJ} not found in project/", "cls": "error"},
                {"text": "Install .NET SDK 8+ and ensure project files exist.", "cls": "dim"},
            ],
            "errors": 1,
            "warnings": 0,
            "diagnostics": [],
        }

    cmd = ["dotnet", *args]
    prompt = f"PS C:\\Projects\\Compiler> {' '.join(cmd)}"

    if kind in ("build", "run"):
        stop_running_program()

    flags = _subprocess_flags()
    try:
        proc = subprocess.run(
            cmd,
            cwd=PROJECT,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=120,
            creationflags=flags,
        )
    except FileNotFoundError:
        return {
            "success": False,
            "exitCode": 127,
            "lines": [
                {"text": prompt, "cls": "info"},
                {"text": "dotnet CLI not found. Install .NET SDK 8+: https://dotnet.microsoft.com/download", "cls": "error"},
            ],
            "errors": 1,
            "warnings": 0,
            "diagnostics": [],
        }
    except subprocess.TimeoutExpired:
        return {
            "success": False,
            "exitCode": -1,
            "lines": [
                {"text": prompt, "cls": "info"},
                {"text": "Build timed out after 120 seconds.", "cls": "error"},
            ],
            "errors": 1,
            "warnings": 0,
            "diagnostics": [],
        }

    combined = (proc.stdout or "") + (proc.stderr or "")
    stdout = (proc.stdout or "").strip()
    diagnostics = extract_diagnostics(combined)
    lines = [{"text": prompt, "cls": "info"}]
    program_output = ""

    if diagnostics:
        lines.append({"text": "", "cls": "dim"})
        lines.append({"text": "── Ошибки компиляции ──", "cls": "section"})
        for item in diagnostics:
            lines.append({"text": format_diagnostic(item), "cls": item["severity"]})
        lines.append({"text": "", "cls": "dim"})
    elif kind == "build":
        if proc.returncode == 0:
            lines.append({"text": "✓ Сборка успешна", "cls": "success"})
        else:
            seen_raw: set[str] = set()
            for raw in combined.splitlines():
                text = raw.strip()
                if not text or text in seen_raw:
                    continue
                seen_raw.add(text)
                lines.append({"text": text, "cls": classify_line(text)})
    elif kind == "run":
        program_output = stdout
        lines.append({"text": "", "cls": "dim"})
        lines.append({"text": "═══ Результат программы ═══", "cls": "output-header"})
        if program_output:
            for raw in stdout.splitlines():
                lines.append({"text": raw, "cls": "output"})
        else:
            lines.append({"text": "(нет вывода — добавьте Console.WriteLine(...))", "cls": "dim"})
        lines.append({"text": "═══════════════════════════", "cls": "output-header"})
    else:
        for raw in combined.splitlines():
            if raw.strip():
                lines.append({"text": raw, "cls": classify_line(raw)})

    errors, warnings = parse_diagnostics(combined)
    if not errors and diagnostics:
        errors = sum(1 for d in diagnostics if d["severity"] == "error")
    if not warnings and diagnostics:
        warnings = sum(1 for d in diagnostics if d["severity"] == "warning")
    if proc.returncode != 0 and errors == 0 and not diagnostics:
        errors = 1

    return {
        "success": proc.returncode == 0,
        "exitCode": proc.returncode,
        "lines": dedupe_lines(lines),
        "errors": errors,
        "warnings": warnings,
        "diagnostics": diagnostics,
        "programOutput": program_output,
    }


def build_project() -> dict:
    """Build with one automatic retry when output DLL is locked."""
    result = run_dotnet(BUILD_ARGS, kind="build")
    combined = " ".join(line.get("text", "") for line in result.get("lines", []))
    if result["success"]:
        return result
    locked = "MSB302" in combined or "being used by another process" in combined
    if not locked:
        return result
    stop_running_program()
    time.sleep(0.4)
    retry = run_dotnet(BUILD_ARGS, kind="build")
    if retry["success"]:
        retry["lines"] = [
            {"text": "Предыдущий процесс остановлен, повторная сборка...", "cls": "warn"},
            *retry["lines"],
        ]
    return retry


def run_program() -> dict:
    """Run Compiler.dll via dotnet exec with auto stdin for ReadLine prompts."""
    global _last_run_proc
    stop_running_program()

    if not COMPILER_DLL.is_file():
        return {
            "success": False,
            "exitCode": 1,
            "lines": [
                {"text": f"{COMPILER_DLL.name} not found. Build the project first.", "cls": "error"},
            ],
            "errors": 1,
            "warnings": 0,
            "diagnostics": [],
            "programOutput": "",
        }

    source_path = PROJECT / WORK_FILE
    try:
        source = source_path.read_text(encoding="utf-8")
    except OSError as exc:
        return {
            "success": False,
            "exitCode": 1,
            "lines": [{"text": str(exc), "cls": "error"}],
            "errors": 1,
            "warnings": 0,
            "diagnostics": [],
            "programOutput": "",
        }

    stdin_data, stdin_values = stdin_for_program(source)
    prompt = f"PS C:\\Projects\\Compiler> dotnet exec {COMPILER_DLL.name}"
    flags = _subprocess_flags()

    try:
        _last_run_proc = subprocess.Popen(
            ["dotnet", "exec", str(COMPILER_DLL)],
            cwd=BUILD_DIR,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=flags,
        )
        stdout, stderr = _last_run_proc.communicate(input=stdin_data, timeout=30)
        exit_code = _last_run_proc.returncode
        _last_run_proc = None
    except subprocess.TimeoutExpired:
        stop_running_program()
        return {
            "success": False,
            "exitCode": -1,
            "lines": [
                {"text": prompt, "cls": "info"},
                {"text": "Программа превысила лимит 30 с (возможно, бесконечный цикл). Остановлена.", "cls": "error"},
            ],
            "errors": 1,
            "warnings": 0,
            "diagnostics": [],
            "programOutput": None,
        }
    except FileNotFoundError:
        return {
            "success": False,
            "exitCode": 127,
            "lines": [{"text": "dotnet CLI could not start the program.", "cls": "error"}],
            "errors": 1,
            "warnings": 0,
            "diagnostics": [],
            "programOutput": None,
        }

    stdout = (stdout or "").strip()
    stderr = (stderr or "").strip()
    lines = [{"text": prompt, "cls": "info"}]
    formatted = format_program_output(stdout, stdin_values) if stdout else None

    if stderr:
        lines.append({"text": "", "cls": "dim"})
        for raw in stderr.splitlines():
            lines.append({"text": raw, "cls": "warn"})

    lines.append({"text": "", "cls": "dim"})
    lines.append({"text": "── Результат программы (см. панель OUTPUT) ──", "cls": "output-header"})
    if formatted and formatted["blocks"]:
        for i, block in enumerate(formatted["blocks"], 1):
            if block["type"] == "vars":
                summary = ", ".join(f"{k}={v}" for k, v in block["vars"].items())
                lines.append({"text": f"  [{i}] {summary}", "cls": "output"})
            else:
                lines.append({"text": f"  [{i}] {block['text']}", "cls": "output"})
    elif stdout:
        for raw in stdout.splitlines():
            lines.append({"text": raw, "cls": "output"})
    else:
        lines.append({"text": "(нет вывода — добавьте Console.WriteLine(...))", "cls": "dim"})

    if formatted and formatted.get("stdinNote"):
        lines.append({"text": formatted["stdinNote"], "cls": "dim"})

    return {
        "success": exit_code == 0,
        "exitCode": exit_code,
        "lines": lines,
        "errors": 0 if exit_code == 0 else 1,
        "warnings": 0,
        "diagnostics": [],
        "programOutput": formatted,
    }


def _api_error(message: str) -> dict:
    return {
        "success": False,
        "exitCode": 1,
        "lines": [{"text": message, "cls": "error"}],
        "errors": 1,
        "warnings": 0,
        "diagnostics": [],
        "programOutput": None,
    }


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, format: str, *args) -> None:
        sys.stderr.write("[%s] %s - %s\n" % (self.log_date_time_string(), self.address_string(), format % args))

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self._cors()
        self.end_headers()

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_POST(self) -> None:
        path = urlparse(self.path).path

        if path == "/api/file":
            data = read_json_body(self)
            if not isinstance(data, dict):
                json_response(self, {"success": False, "error": "Invalid JSON body"}, 400)
                return
            rel_path = str(data.get("path", ""))
            content = data.get("content")
            if content is None:
                json_response(self, {"success": False, "error": "Missing content"}, 400)
                return
            target = resolve_project_path(rel_path)
            if target is None:
                json_response(self, {"success": False, "error": "Only Program.cs is editable"}, 400)
                return
            try:
                target.parent.mkdir(parents=True, exist_ok=True)
                prepared = prepare_csharp(content)
                target.write_text(prepared, encoding="utf-8", newline="\n")
            except OSError as exc:
                json_response(self, {"success": False, "error": str(exc)}, 500)
                return
            json_response(
                self,
                {
                    "success": True,
                    "path": rel_path.replace("\\", "/"),
                    "content": prepared,
                    "corrected": prepared != content,
                },
            )
            return

        if path == "/api/save":
            data = read_json_body(self)
            if not isinstance(data, dict) or not isinstance(data.get("files"), list):
                json_response(self, {"success": False, "error": "Expected { files: [...] }"}, 400)
                return
            saved = []
            for item in data["files"]:
                rel_path = str(item.get("path", ""))
                content = item.get("content")
                if content is None:
                    continue
                target = resolve_project_path(rel_path)
                if target is None:
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                prepared = prepare_csharp(content)
                target.write_text(prepared, encoding="utf-8", newline="\n")
                saved.append(rel_path.replace("\\", "/"))
            json_response(self, {"success": True, "saved": saved})
            return

        if path == "/api/build":
            try:
                payload = build_project()
            except Exception as exc:
                payload = _api_error(str(exc))
        elif path == "/api/run":
            try:
                build = build_project()
                if not build["success"]:
                    payload = build
                else:
                    run_result = run_program()
                    payload = {
                        "success": run_result["success"],
                        "exitCode": run_result["exitCode"],
                        "lines": build["lines"] + run_result["lines"],
                        "errors": build["errors"] + run_result["errors"],
                        "warnings": build["warnings"] + run_result["warnings"],
                        "diagnostics": build.get("diagnostics", []) + run_result.get("diagnostics", []),
                        "programOutput": run_result.get("programOutput", ""),
                    }
            except Exception as exc:
                payload = _api_error(str(exc))
        elif path == "/api/stop":
            stop_running_program()
            payload = {"success": True}
        else:
            self.send_error(404, "Not Found")
            return

        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/api/files":
            json_response(self, {"files": list_project_files()})
            return

        if path == "/api/file":
            from urllib.parse import parse_qs

            qs = parse_qs(parsed.query)
            rel_path = qs.get("path", [""])[0]
            target = resolve_project_path(rel_path)
            if target is None or not target.is_file():
                json_response(self, {"success": False, "error": "File not found"}, 404)
                return
            try:
                content = target.read_text(encoding="utf-8")
            except OSError as exc:
                json_response(self, {"success": False, "error": str(exc)}, 500)
                return
            json_response(
                self,
                {
                    "success": True,
                    "path": rel_path.replace("\\", "/"),
                    "name": target.name,
                    "language": language_for(target.suffix),
                    "content": content,
                },
            )
            return

        if path == "/api/health":
            dotnet_ok = False
            version = None
            try:
                proc = subprocess.run(
                    ["dotnet", "--version"],
                    capture_output=True,
                    text=True,
                    timeout=10,
                )
                dotnet_ok = proc.returncode == 0
                version = (proc.stdout or "").strip()
            except (FileNotFoundError, subprocess.TimeoutExpired):
                pass

            body = json.dumps(
                {
                    "ok": True,
                    "dotnet": dotnet_ok,
                    "dotnetVersion": version,
                    "project": str(PROJECT),
                },
                ensure_ascii=False,
            ).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self._cors()
            self.end_headers()
            self.wfile.write(body)
            return

        super().do_GET()


def main() -> None:
    os.chdir(ROOT)
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Serving at http://{HOST}:{PORT}")
    print(f"Project:  {PROJECT}")
    print(f"Build:    {BUILD_CONFIG}")
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        stop_running_program()
        server.server_close()


if __name__ == "__main__":
    main()
