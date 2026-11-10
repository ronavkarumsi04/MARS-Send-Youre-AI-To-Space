import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Runtime pins for the SFT worker venv (`python/requirements.lock`). The
 * worker reports its installed versions in `ready`/`probe`; validate refuses a
 * venv whose versions differ. TRL and PEFT match the audited source revisions
 * in sources/manifest.json (v1.17.1 / v0.21.2).
 */
export const TRAINING_PINS = {
  python_version_prefix: "3.12.",
  torch: "2.15.0",
  transformers: "5.22.1",
  trl: "1.17.1",
  peft: "0.21.2",
  datasets: "5.1.0",
  accelerate: "1.15.0",
  trl_source_revision: "44809ba3f3a136f3d62859ee981fee2506bce5c9",
  peft_source_revision: "eaa35c777c7b554a2a3639ac9c79bb690f39a57",
} as const;

export const PACKAGE_DIR = path.resolve(import.meta.dir, "..");
export const PYTHON_DIR = path.join(PACKAGE_DIR, "python");
export const WORKER_MODULE = "mars_training_worker";

export function defaultWorkerPython(): string {
  return path.join(PYTHON_DIR, ".venv", "bin", "python");
}

export function workerAvailable(pythonPath = defaultWorkerPython()): boolean {
  return existsSync(pythonPath);
}

/** Hugging Face cache the worker reads offline; populated ahead of time by `python -m mars_training_worker.fetch`. */
export function defaultHfCacheDir(): string {
  return (
    process.env.MARS_TRAINING_HF_CACHE ??
    path.join(homedir(), ".cache", "mars-training-hf")
  );
}

export const WORKER_SETUP_HINT =
  "Training worker venv missing. Run: cd packages/training/python && uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python --only-binary :all: --index-strategy unsafe-best-match -r requirements.lock";
