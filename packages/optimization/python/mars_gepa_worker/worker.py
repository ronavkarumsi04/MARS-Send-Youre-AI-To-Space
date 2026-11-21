"""Worker entry point: pin check, handshake, brokered gepa.optimize, result."""

from __future__ import annotations

import contextlib
import sys
import traceback
from datetime import datetime, timezone
from importlib import metadata
from typing import Any, TextIO

from .adapter import BrokeredAdapter
from .protocol import Broker, Channel, HostAbort, ProtocolError
from .scrub import bounded

REQUIRED_START_KEYS = (
    "expected",
    "seed_candidate",
    "train",
    "validation",
    "max_metric_calls",
    "reflection_minibatch_size",
    "seed",
    "repeats",
    "budget",
    "max_feedback_chars",
    "max_records_per_component",
)

EXIT_OK = 0
EXIT_PROTOCOL = 2
EXIT_PIN_MISMATCH = 3
EXIT_ABORTED = 4
EXIT_GEPA_ERROR = 5


def installed_versions() -> tuple[str, str]:
    try:
        gepa_version = metadata.version("gepa")
    except metadata.PackageNotFoundError:
        gepa_version = "missing"
    info = sys.version_info
    return gepa_version, f"{info.major}.{info.minor}.{info.micro}"


def check_pins(expected: dict[str, Any]) -> str | None:
    gepa_version, python_version = installed_versions()
    problems = []
    if gepa_version != expected.get("gepa_version"):
        problems.append(f"gepa {gepa_version} != pinned {expected.get('gepa_version')}")
    prefix = str(expected.get("python_version_prefix", ""))
    if not python_version.startswith(prefix + "."):
        problems.append(f"python {python_version} does not match pinned {prefix}.x")
    return "; ".join(problems) or None


class _ChannelLogger:
    def __init__(self, channel: Channel) -> None:
        self._channel = channel

    def log(self, message: str) -> None:
        self._channel.send({"type": "log", "message": bounded(str(message), 2000)})


class _CandidateEmitter:
    def __init__(self, channel: Channel) -> None:
        self._channel = channel

    def on_valset_evaluated(self, event: dict[str, Any]) -> None:
        parents = list(event.get("parent_ids") or [])
        parent_idx = int(parents[0]) if parents and parents[0] is not None else None
        self._channel.send(
            {
                "type": "candidate",
                "candidate_idx": int(event["candidate_idx"]),
                "parent_idx": parent_idx,
                "components": dict(event["candidate"]),
                "validation_mean_score": event.get("average_score"),
            }
        )


def _require_int(message: dict[str, Any], key: str, *, minimum: int | None = None) -> int:
    value = message.get(key)
    if isinstance(value, bool) or not isinstance(value, int):
        raise ProtocolError(f"start.{key} must be an integer, got {value!r}")
    if minimum is not None and value < minimum:
        raise ProtocolError(f"start.{key} must be >= {minimum}, got {value!r}")
    return value


def _validate_start(message: dict[str, Any]) -> None:
    if message.get("type") != "start":
        raise ProtocolError(f"expected start, got {message.get('type')!r}")
    missing = [key for key in REQUIRED_START_KEYS if key not in message]
    if missing:
        raise ProtocolError(f"start message missing {missing}")
    if not isinstance(message["expected"], dict):
        raise ProtocolError("start.expected must be an object")
    if not isinstance(message["seed_candidate"], dict) or not all(
        isinstance(k, str) and isinstance(v, str) for k, v in message["seed_candidate"].items()
    ):
        raise ProtocolError("start.seed_candidate must be a string-to-string object")
    if not isinstance(message["budget"], dict):
        raise ProtocolError("start.budget must be an object")
    _require_int(message, "max_metric_calls", minimum=1)
    _require_int(message, "reflection_minibatch_size", minimum=1)
    _require_int(message, "seed")
    _require_int(message, "repeats", minimum=1)
    _require_int(message, "max_feedback_chars", minimum=1)
    _require_int(message, "max_records_per_component", minimum=1)
    for split in ("train", "validation"):
        items = message[split]
        if not isinstance(items, list):
            raise ProtocolError(f"start.{split} must be a list")
        for item in items:
            if not isinstance(item, dict) or not isinstance(item.get("instance_id"), str):
                raise ProtocolError(f"start.{split} entries must be objects with string 'instance_id'")
            if item.get("split") != split:
                raise ProtocolError(
                    f"instance {item.get('instance_id')!r} listed under {split} with split {item.get('split')!r}"
                )


def run(stdin: TextIO, stdout: TextIO, stderr: TextIO) -> int:
    channel = Channel(stdin, stdout)
    try:
        start = channel.receive()
        _validate_start(start)
    except ProtocolError as error:
        channel.send({"type": "error", "code": "protocol_error", "message": str(error)})
        return EXIT_PROTOCOL

    problem = check_pins(start["expected"])
    gepa_version, python_version = installed_versions()
    if problem is not None:
        channel.send({"type": "error", "code": "pin_mismatch", "message": problem})
        return EXIT_PIN_MISMATCH

    channel.send({"type": "ready", "gepa_version": gepa_version, "python_version": python_version})
    broker = Broker(channel)
    created_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    adapter = BrokeredAdapter(
        broker,
        repeats=int(start["repeats"]),
        budget=start["budget"],
        created_at=created_at,
        max_feedback_chars=int(start["max_feedback_chars"]),
        max_records_per_component=int(start["max_records_per_component"]),
    )

    def reflection_lm(prompt: Any) -> str:
        if isinstance(prompt, str):
            text = prompt
        else:
            text = "\n\n".join(
                str(part.get("content", part)) if isinstance(part, dict) else str(part)
                for part in prompt
            )
        reply = broker.request({"type": "reflect", "prompt": text}, "reflect_result")
        if "text" not in reply or not isinstance(reply["text"], str):
            raise ProtocolError("reflect_result missing string 'text'")
        return reply["text"]

    try:
        import gepa

        # GEPA prints progress through its logger; stdout is the protocol channel,
        # so anything else that prints is diverted to stderr.
        with contextlib.redirect_stdout(stderr):
            result = gepa.optimize(
                seed_candidate=dict(start["seed_candidate"]),
                trainset=list(start["train"]),
                valset=list(start["validation"]),
                adapter=adapter,
                reflection_lm=reflection_lm,
                max_metric_calls=int(start["max_metric_calls"]),
                reflection_minibatch_size=int(start["reflection_minibatch_size"]),
                candidate_selection_strategy="pareto",
                seed=int(start["seed"]),
                raise_on_exception=True,
                track_best_outputs=False,
                display_progress_bar=False,
                use_wandb=False,
                use_mlflow=False,
                logger=_ChannelLogger(channel),
                callbacks=[_CandidateEmitter(channel)],
            )
    except HostAbort:
        return EXIT_ABORTED
    except ProtocolError as error:
        channel.send({"type": "error", "code": "protocol_error", "message": str(error)})
        return EXIT_PROTOCOL
    except Exception:  # noqa: BLE001 - reported to the host, which owns the policy
        channel.send(
            {"type": "error", "code": "gepa_error", "message": bounded(traceback.format_exc(), 4000)}
        )
        return EXIT_GEPA_ERROR

    channel.send(
        {
            "type": "done",
            "result": {
                "candidates": [dict(candidate) for candidate in result.candidates],
                "parents": [list(parents) for parents in result.parents],
                "val_aggregate_scores": [float(score) for score in result.val_aggregate_scores],
                "best_idx": int(result.best_idx),
                "total_metric_calls": result.total_metric_calls,
            },
        }
    )
    return EXIT_OK
