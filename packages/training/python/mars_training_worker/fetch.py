"""Operator provisioning step (never run by the service): download one pinned snapshot.

    .venv/bin/python -m mars_training_worker.fetch REPO REVISION [CACHE_DIR]

REVISION must be an exact 40-hex commit. The training worker later reads this
cache with ``local_files_only=True`` and ``HF_HUB_OFFLINE=1``.
"""

from __future__ import annotations

import os
import re
import sys


def main(argv: list[str]) -> int:
    if len(argv) not in (2, 3) or not re.fullmatch(r"[0-9a-f]{40}", argv[1]):
        print(__doc__, file=sys.stderr)
        return 2
    from huggingface_hub import snapshot_download

    cache = argv[2] if len(argv) == 3 else os.path.expanduser("~/.cache/mars-training-hf")
    path = snapshot_download(repo_id=argv[0], revision=argv[1], cache_dir=cache)
    print(path)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
