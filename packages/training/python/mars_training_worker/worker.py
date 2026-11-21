"""One bounded SFT job: read a start message, train a LoRA/QLoRA adapter, prove it reloads.

Protocol: newline-delimited JSON. The host writes exactly one ``start`` message
on stdin; the worker writes ``ready``, ``progress``, ``log`` and finally ``done``
or ``error`` on the protocol channel. Library output (tqdm, warnings, C-level
prints) is redirected to stderr so the channel stays clean. The worker never
installs packages and never touches the network: it loads the base model and
tokenizer from a pre-populated Hugging Face cache at the exact revision named in
the start message with ``local_files_only=True``; the host additionally sets
``HF_HUB_OFFLINE=1``.
"""

from __future__ import annotations

import json
import math
import os
import platform
import signal
import sys
import threading
import time
from pathlib import Path
from typing import Any, TextIO

from . import PROTOCOL_VERSION

ADAPTER_FILES = ("adapter_model.safetensors", "adapter_config.json")
MAX_TEXT = 2000


class WorkerFailure(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _channel() -> TextIO:
    """Keep the original stdout for the protocol and point fd 1 at stderr."""
    channel = os.fdopen(os.dup(1), "w", encoding="utf-8", buffering=1)
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    return channel


def _send(channel: TextIO, message: dict[str, Any]) -> None:
    channel.write(json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n")
    channel.flush()


def _optional_version(name: str) -> str | None:
    from importlib.metadata import PackageNotFoundError, version

    try:
        return version(name)
    except PackageNotFoundError:
        return None


def _versions() -> dict[str, Any]:
    import accelerate
    import datasets
    import peft
    import torch
    import transformers
    import trl

    return {
        "python": platform.python_version(),
        "torch": torch.__version__,
        "transformers": transformers.__version__,
        "trl": trl.__version__,
        "peft": peft.__version__,
        "datasets": datasets.__version__,
        "accelerate": accelerate.__version__,
        "bitsandbytes": _optional_version("bitsandbytes"),
        "cuda_available": bool(torch.cuda.is_available()),
        "cuda_devices": [torch.cuda.get_device_name(i) for i in range(torch.cuda.device_count())],
    }


def probe() -> int:
    channel = _channel()
    _send(channel, {"type": "probe", "versions": _versions(), "cpu_count": os.cpu_count() or 1})
    return 0


def _read_jsonl(path: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with open(path, encoding="utf-8") as handle:
        for number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as error:
                raise WorkerFailure(
                    "dataset_malformed", f"{Path(path).name}:{number} invalid JSON: {error.msg}"
                ) from None
            messages = row.get("messages") if isinstance(row, dict) else None
            if not isinstance(messages, list) or not messages:
                raise WorkerFailure("dataset_malformed", f"{Path(path).name}:{number} has no messages")
            for message in messages:
                if (
                    not isinstance(message, dict)
                    or message.get("role") not in ("system", "user", "assistant")
                    or not isinstance(message.get("content"), str)
                ):
                    raise WorkerFailure("dataset_malformed", f"{Path(path).name}:{number} bad message")
            rows.append({"messages": [{"role": m["role"], "content": m["content"]} for m in messages]})
    if not rows:
        raise WorkerFailure("dataset_malformed", f"{Path(path).name} has no examples")
    return rows


def _require(start: dict[str, Any], key: str) -> Any:
    if key not in start:
        raise WorkerFailure("protocol_error", f"start message is missing {key}")
    return start[key]


def _train(start: dict[str, Any], channel: TextIO) -> dict[str, Any]:
    import torch
    from peft import LoraConfig, PeftModel
    from transformers import AutoModelForCausalLM, AutoTokenizer, TrainerCallback
    from datasets import Dataset
    from trl import SFTConfig, SFTTrainer

    method = _require(start, "method")
    base = _require(start, "base")
    tokenizer_ref = _require(start, "tokenizer")
    lora = _require(start, "lora")
    sft = _require(start, "sft")
    cache_dir = _require(start, "hf_cache_dir")
    output_dir = Path(_require(start, "output_dir"))
    cuda = bool(torch.cuda.is_available())

    if method == "qlora":
        if not cuda:
            raise WorkerFailure("cuda_required", "QLoRA needs a CUDA device; none is available")
        try:
            import bitsandbytes  # noqa: F401
        except ImportError:
            raise WorkerFailure("bitsandbytes_missing", "QLoRA needs bitsandbytes in the pinned environment") from None
    elif method != "lora":
        raise WorkerFailure("protocol_error", f"unknown method {method!r}")

    torch.manual_seed(int(sft["seed"]))
    load = {"revision": base["revision"], "cache_dir": cache_dir, "local_files_only": True}
    tokenizer = AutoTokenizer.from_pretrained(
        tokenizer_ref["repo"], revision=tokenizer_ref["revision"], cache_dir=cache_dir, local_files_only=True
    )
    tokenizer.chat_template = Path(_require(start, "chat_template_path")).read_text(encoding="utf-8")
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    def load_base() -> Any:
        kwargs: dict[str, Any] = dict(load)
        if method == "qlora":
            from transformers import BitsAndBytesConfig

            kwargs["quantization_config"] = BitsAndBytesConfig(
                load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_compute_dtype=torch.bfloat16
            )
            kwargs["device_map"] = {"": 0}
        else:
            kwargs["dtype"] = torch.float32
        return AutoModelForCausalLM.from_pretrained(base["repo"], **kwargs)

    model = load_base()
    if method == "qlora":
        from peft import prepare_model_for_kbit_training

        model = prepare_model_for_kbit_training(model)

    train_rows = _read_jsonl(_require(start, "train_path"))
    validation_rows = _read_jsonl(_require(start, "validation_path"))
    peft_config = LoraConfig(
        task_type="CAUSAL_LM",
        r=int(lora["r"]),
        lora_alpha=int(lora["alpha"]),
        lora_dropout=float(lora["dropout"]),
        target_modules=lora["target_modules"],
    )
    work_dir = output_dir / "trainer"
    args = SFTConfig(
        output_dir=str(work_dir),
        max_steps=int(sft["max_steps"]),
        learning_rate=float(sft["learning_rate"]),
        per_device_train_batch_size=int(sft["per_device_train_batch_size"]),
        per_device_eval_batch_size=int(sft["per_device_train_batch_size"]),
        gradient_accumulation_steps=int(sft["gradient_accumulation_steps"]),
        max_length=int(sft["max_length"]),
        seed=int(sft["seed"]),
        data_seed=int(sft["seed"]),
        use_cpu=not cuda,
        bf16=False,
        fp16=False,
        logging_steps=1,
        save_strategy="no",
        eval_strategy="no",
        report_to=[],
        dataloader_num_workers=0,
        disable_tqdm=True,
    )

    class Progress(TrainerCallback):
        def on_log(self, _args: Any, state: Any, _control: Any, logs: Any = None, **_: Any) -> None:
            if logs and "loss" in logs:
                _send(channel, {"type": "progress", "step": int(state.global_step), "loss": float(logs["loss"])})

    trainer = SFTTrainer(
        model=model,
        args=args,
        train_dataset=Dataset.from_list(train_rows),
        eval_dataset=Dataset.from_list(validation_rows),
        processing_class=tokenizer,
        peft_config=peft_config,
        callbacks=[Progress()],
    )
    trainable = sum(p.numel() for p in trainer.model.parameters() if p.requires_grad)
    total = sum(p.numel() for p in trainer.model.parameters())
    started = time.monotonic()
    train_output = trainer.train()
    train_seconds = time.monotonic() - started
    eval_metrics = trainer.evaluate()

    adapter_dir = output_dir / "adapter"
    trainer.model.save_pretrained(str(adapter_dir), safe_serialization=True)
    config_path = adapter_dir / "adapter_config.json"
    adapter_config = json.loads(config_path.read_text(encoding="utf-8"))
    # PEFT records a local snapshot path and no revision; pin both to the exact base.
    adapter_config["base_model_name_or_path"] = base["repo"]
    adapter_config["revision"] = base["revision"]
    config_path.write_text(json.dumps(adapter_config, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    # Reload proof: fresh base + saved adapter must reproduce the trained model and differ from the base.
    probe_messages = validation_rows[0]["messages"]
    prompt_messages = probe_messages[:-1] if probe_messages[-1]["role"] == "assistant" else probe_messages
    prompt_ids = tokenizer.apply_chat_template(
        prompt_messages, add_generation_prompt=True, return_tensors="pt", return_dict=True
    )["input_ids"]
    prompt_ids = prompt_ids[:, -int(sft["max_length"]) :]
    trained = trainer.model.eval()
    device = next(trained.parameters()).device
    prompt_ids = prompt_ids.to(device)
    with torch.no_grad():
        trained_logits = trained(input_ids=prompt_ids).logits.float().cpu()
    del trainer, trained, model
    fresh_base = load_base()
    if method != "qlora":
        fresh_base = fresh_base.to(device)
    fresh_base = fresh_base.eval()
    with torch.no_grad():
        base_logits = fresh_base(input_ids=prompt_ids).logits.float().cpu()
    reloaded = PeftModel.from_pretrained(fresh_base, str(adapter_dir)).eval()
    with torch.no_grad():
        reloaded_logits = reloaded(input_ids=prompt_ids).logits.float().cpu()
        generated = reloaded.generate(
            input_ids=prompt_ids,
            attention_mask=torch.ones_like(prompt_ids),
            max_new_tokens=int(_require(start, "generation")["max_new_tokens"]),
            do_sample=False,
            pad_token_id=tokenizer.pad_token_id,
        )
    new_tokens = generated[0, prompt_ids.shape[1] :]
    return {
        "files": list(ADAPTER_FILES),
        "metrics": {
            "global_steps": int(train_output.global_step),
            "train_loss": float(train_output.training_loss),
            "eval_loss": float(eval_metrics["eval_loss"]) if "eval_loss" in eval_metrics else None,
            "train_seconds": round(train_seconds, 3),
            "trainable_params": int(trainable),
            "total_params": int(total),
            "train_examples": len(train_rows),
            "validation_examples": len(validation_rows),
            "device": "cuda" if cuda else "cpu",
        },
        "reload": {
            "loaded": True,
            "max_abs_logit_diff_vs_trained": float((reloaded_logits - trained_logits).abs().max()),
            "max_abs_logit_diff_vs_base": float((reloaded_logits - base_logits).abs().max()),
            "prompt_tokens": int(prompt_ids.shape[1]),
            "generated_tokens": int(new_tokens.shape[0]),
            "generated_text": tokenizer.decode(new_tokens, skip_special_tokens=True)[:MAX_TEXT],
        },
    }


_CLEANER = """
import os, shutil, sys, time
pid, scratch = int(sys.argv[1]), sys.argv[2]
for _ in range(600):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        break
    time.sleep(0.05)
shutil.rmtree(scratch, ignore_errors=True)
"""


def _spawn_scratch_cleaner(scratch_dir: str) -> None:
    """Remove scratch only after this worker's group is dead, so no writer races the delete.

    The cleaner runs in its own session so the group kill does not reach it.
    """
    import subprocess

    subprocess.Popen(
        [sys.executable, "-c", _CLEANER, str(os.getpid()), scratch_dir],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
        close_fds=True,
    )


def _start_watchdog(deadline_seconds: Any, scratch_dir: Any = None) -> None:
    """Backstop for the host's kill: exit (with our process group) if the host dies or the deadline passes.

    If the host died, nobody else will clean this job's scratch dir, so remove it first.
    """
    parent = os.getppid()
    limit = (
        time.monotonic() + float(deadline_seconds)
        if not isinstance(deadline_seconds, bool)
        and isinstance(deadline_seconds, (int, float))
        and math.isfinite(deadline_seconds)
        and deadline_seconds > 0
        else None
    )

    def watch() -> None:
        while True:
            time.sleep(0.5)
            orphaned = os.getppid() != parent
            if orphaned or (limit is not None and time.monotonic() > limit):
                try:
                    if orphaned and isinstance(scratch_dir, str) and scratch_dir:
                        _spawn_scratch_cleaner(scratch_dir)
                except Exception:  # noqa: BLE001 - cleanup is best effort; the kill below is not
                    pass
                finally:
                    if os.getpgrp() == os.getpid():
                        os.killpg(os.getpid(), signal.SIGKILL)
                    os._exit(3)

    threading.Thread(target=watch, name="mars-watchdog", daemon=True).start()


def run() -> int:
    channel = _channel()
    try:
        line = sys.stdin.readline()
        if not line:
            raise WorkerFailure("protocol_error", "host closed stdin before start")
        try:
            start = json.loads(line)
        except json.JSONDecodeError as error:
            raise WorkerFailure("protocol_error", f"invalid JSON from host: {error.msg}") from None
        if not isinstance(start, dict) or start.get("type") != "start":
            raise WorkerFailure("protocol_error", "first message must be start")
        if start.get("protocol") != PROTOCOL_VERSION:
            raise WorkerFailure("protocol_error", f"unsupported protocol {start.get('protocol')!r}")
        _start_watchdog(start.get("watchdog_deadline_seconds"), start.get("scratch_dir"))
        _send(channel, {"type": "ready", "versions": _versions()})
        result = _train(start, channel)
        _send(channel, {"type": "done", **result})
        return 0
    except WorkerFailure as failure:
        _send(channel, {"type": "error", "code": failure.code, "message": str(failure)[:MAX_TEXT]})
        return 2
    except Exception as error:  # noqa: BLE001 - report every failure on the channel
        _send(channel, {"type": "error", "code": "worker_error", "message": f"{type(error).__name__}: {error}"[:MAX_TEXT]})
        return 1
