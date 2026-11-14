"""Ledger service entry point."""

import os

DEFAULT_PORT = 8080
DEFAULT_HOST = "0.0.0.0"


def bind_address() -> str:
    port = int(os.environ.get("LEDGER_PORT", DEFAULT_PORT))
    return f"{DEFAULT_HOST}:{port}"
