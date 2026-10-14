"""Install the Python and web dependencies for a local True Eye checkout."""

from __future__ import annotations

import os
import shutil
import subprocess
import venv
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
VENV_DIR = ROOT / ".venv"


def run(command: list[str], *, cwd: Path = ROOT) -> None:
    print("+", " ".join(command), flush=True)
    subprocess.run(command, cwd=cwd, check=True)


def main() -> None:
    npm = shutil.which("npm")
    if npm is None:
        raise SystemExit("npm was not found. Install Node.js (which includes npm), then run this script again.")

    if os.name == "nt":
        python = VENV_DIR / "Scripts" / "python.exe"
    else:
        python = VENV_DIR / "bin" / "python"

    if not python.exists():
        print(f"Creating Python environment at {VENV_DIR}", flush=True)
        venv.EnvBuilder(with_pip=True).create(VENV_DIR)

    run([str(python), "-m", "pip", "install", "-r", str(ROOT / "requirements.txt")])
    run([npm, "ci"], cwd=ROOT / "web")
    print("All Python and frontend dependencies are installed.", flush=True)


if __name__ == "__main__":
    main()
