import sys

from .worker import probe, run

if __name__ == "__main__":
    if sys.argv[1:] == ["--probe"]:
        sys.exit(probe())
    sys.exit(run())
