"""Stdlib-only worker tests (no torch): protocol framing and dataset parsing."""

import io
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

PYTHON_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PYTHON_DIR))

from mars_training_worker.fetch import main as fetch_main  # noqa: E402
from mars_training_worker.worker import WorkerFailure, _read_jsonl  # noqa: E402


def run_worker(stdin: str) -> tuple[int, list[dict]]:
    proc = subprocess.run(
        [sys.executable, "-m", "mars_training_worker"],
        cwd=PYTHON_DIR,
        input=stdin,
        capture_output=True,
        text=True,
        timeout=60,
        env={"PATH": os.environ.get("PATH", ""), "PYTHONDONTWRITEBYTECODE": "1"},
    )
    return proc.returncode, [json.loads(line) for line in proc.stdout.splitlines() if line.strip()]


class ProtocolTests(unittest.TestCase):
    def test_rejects_empty_stdin(self) -> None:
        code, messages = run_worker("")
        self.assertEqual(code, 2)
        self.assertEqual(messages, [{"type": "error", "code": "protocol_error", "message": "host closed stdin before start"}])

    def test_rejects_invalid_json_stdin(self) -> None:
        code, messages = run_worker("{not json\n")
        self.assertEqual(code, 2)
        self.assertEqual(messages[0]["code"], "protocol_error")
        self.assertIn("invalid JSON", messages[0]["message"])

    def test_rejects_wrong_first_message(self) -> None:
        code, messages = run_worker('{"type":"hello"}\n')
        self.assertEqual(code, 2)
        self.assertEqual(messages[0]["code"], "protocol_error")

    def test_rejects_unknown_protocol(self) -> None:
        code, messages = run_worker('{"type":"start","protocol":99}\n')
        self.assertEqual(code, 2)
        self.assertIn("unsupported protocol", messages[0]["message"])


class DatasetTests(unittest.TestCase):
    def write(self, text: str) -> str:
        handle = tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False, encoding="utf-8")
        handle.write(text)
        handle.close()
        self.addCleanup(os.unlink, handle.name)
        return handle.name

    def test_reads_conversational_rows(self) -> None:
        path = self.write('{"messages":[{"role":"user","content":"a"},{"role":"assistant","content":"b"}]}\n')
        self.assertEqual(_read_jsonl(path), [{"messages": [{"role": "user", "content": "a"}, {"role": "assistant", "content": "b"}]}])

    def test_rejects_bad_roles(self) -> None:
        path = self.write('{"messages":[{"role":"tool","content":"a"}]}\n')
        with self.assertRaises(WorkerFailure) as ctx:
            _read_jsonl(path)
        self.assertEqual(ctx.exception.code, "dataset_malformed")

    def test_rejects_invalid_json_line(self) -> None:
        path = self.write("{broken\n")
        with self.assertRaises(WorkerFailure) as ctx:
            _read_jsonl(path)
        self.assertEqual(ctx.exception.code, "dataset_malformed")
        self.assertIn("invalid JSON", str(ctx.exception))

    def test_rejects_empty_dataset(self) -> None:
        path = self.write("\n   \n")
        with self.assertRaises(WorkerFailure) as ctx:
            _read_jsonl(path)
        self.assertEqual(ctx.exception.code, "dataset_malformed")
        self.assertIn("no examples", str(ctx.exception))

    def test_fixture_files_parse(self) -> None:
        fixtures = PYTHON_DIR.parent / "fixtures" / "synthetic"
        self.assertEqual(len(_read_jsonl(str(fixtures / "train.jsonl"))), 9)
        self.assertEqual(len(_read_jsonl(str(fixtures / "validation.jsonl"))), 3)


class FetchTests(unittest.TestCase):
    def test_rejects_non_40_hex_revision_and_wrong_arity(self) -> None:
        self.assertEqual(fetch_main([]), 2)
        self.assertEqual(fetch_main(["org/model", "main"]), 2)
        self.assertEqual(fetch_main(["org/model", "a" * 39]), 2)
        self.assertEqual(fetch_main(["org/model", "a" * 40, "/tmp/c", "extra"]), 2)


class WatchdogTests(unittest.TestCase):
    # The child atomically publishes its pid file only after _start_watchdog has captured the host
    # as its parent, so the host cannot exit before the watchdog records it or read a partial file.
    def test_orphaned_worker_exits_even_if_cleaner_cannot_start(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            pid_file = Path(root) / "worker.pid"
            pid_tmp = Path(root) / "worker.pid.tmp"
            worker = (
                "import os, sys, time\n"
                f"sys.path.insert(0, {str(PYTHON_DIR)!r})\n"
                "from mars_training_worker import worker\n"
                "def broken(_):\n    raise OSError('no processes')\n"
                "worker._spawn_scratch_cleaner = broken\n"
                f"worker._start_watchdog(None, {root!r})\n"
                f"with open({str(pid_tmp)!r}, 'w', encoding='utf-8') as f: f.write(str(os.getpid()))\n"
                f"os.replace({str(pid_tmp)!r}, {str(pid_file)!r})\n"
                "time.sleep(60)\n"
            )
            host = (
                "import subprocess, sys, time\n"
                f"subprocess.Popen([sys.executable, '-c', {worker!r}], start_new_session=True)\n"
                f"while not __import__('os').path.exists({str(pid_file)!r}): time.sleep(0.05)\n"
            )
            subprocess.run([sys.executable, "-c", host], timeout=30, check=True)
            pid = int(pid_file.read_text(encoding="utf-8"))
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                try:
                    os.kill(pid, 0)
                except ProcessLookupError:
                    break
                time.sleep(0.1)
            with self.assertRaises(ProcessLookupError):
                os.kill(pid, 0)

    def test_orphaned_worker_removes_scratch_and_exits(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            scratch = Path(root) / "job"
            scratch.mkdir()
            (scratch / "train.jsonl").write_text("{}\n", encoding="utf-8")
            pid_file = Path(root) / "worker.pid"
            pid_tmp = Path(root) / "worker.pid.tmp"
            worker = (
                "import os, sys, time\n"
                f"sys.path.insert(0, {str(PYTHON_DIR)!r})\n"
                "from mars_training_worker.worker import _start_watchdog\n"
                f"_start_watchdog(None, {str(scratch)!r})\n"
                f"with open({str(pid_tmp)!r}, 'w', encoding='utf-8') as f: f.write(str(os.getpid()))\n"
                f"os.replace({str(pid_tmp)!r}, {str(pid_file)!r})\n"
                "time.sleep(60)\n"
            )
            host = (
                "import subprocess, sys, time\n"
                f"subprocess.Popen([sys.executable, '-c', {worker!r}], start_new_session=True)\n"
                f"while not __import__('os').path.exists({str(pid_file)!r}): time.sleep(0.05)\n"
            )
            subprocess.run([sys.executable, "-c", host], timeout=30, check=True)
            deadline = time.monotonic() + 10
            while scratch.exists() and time.monotonic() < deadline:
                time.sleep(0.1)
            self.assertFalse(scratch.exists())
            pid = int(pid_file.read_text(encoding="utf-8"))
            while time.monotonic() < deadline:
                try:
                    os.kill(pid, 0)
                except ProcessLookupError:
                    break
                time.sleep(0.1)
            with self.assertRaises(ProcessLookupError):
                os.kill(pid, 0)

    def test_boolean_and_non_finite_deadline_do_not_kill_worker(self) -> None:
        # True is a subclass of int in Python; it must not be treated as a 1-second deadline.
        script = (
            "import sys, time\n"
            f"sys.path.insert(0, {str(PYTHON_DIR)!r})\n"
            "from mars_training_worker.worker import _start_watchdog\n"
            "_start_watchdog(True)\n"
            "_start_watchdog(float('nan'))\n"
            "time.sleep(1.2)\n"
            "print('alive')\n"
        )
        proc = subprocess.run(
            [sys.executable, "-c", script],
            capture_output=True,
            text=True,
            timeout=10,
        )
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(proc.stdout.strip(), "alive")

if __name__ == "__main__":
    unittest.main()
