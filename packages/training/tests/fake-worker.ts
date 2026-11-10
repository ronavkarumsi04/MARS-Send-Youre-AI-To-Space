/**
 * Offline stand-in for `python -m mars_training_worker` (no torch, no model).
 * argv: <mode> [--probe]. Modes: ok | error | hang | garbage | bad-config |
 * cuda | stale-pins. `hang` forks a grandchild into the same process group and
 * records both pids so tests can prove the whole group is killed.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const mode = process.argv[2] ?? "ok";
const isProbe = process.argv.includes("--probe");
const send = (message: unknown) =>
  process.stdout.write(`${JSON.stringify(message)}\n`);

const versions = {
  python: "3.12.16",
  torch: mode === "stale-pins" ? "2.0.0+cpu" : "2.15.0+cpu",
  transformers: "5.22.1",
  trl: "1.17.1",
  peft: "0.21.2",
  datasets: "5.1.0",
  accelerate: "1.15.0",
  bitsandbytes: mode === "cuda" ? "0.49.0" : null,
  cuda_available: mode === "cuda",
  cuda_devices: mode === "cuda" ? ["Synthetic GPU"] : [],
};

if (isProbe) {
  send({ type: "probe", versions, cpu_count: 8 });
  process.exit(0);
}

const input = await new Response(Bun.stdin.stream()).text();
const start = JSON.parse(input.split("\n")[0] ?? "{}");
send({ type: "ready", versions });
console.error("fake worker: started");

if (mode === "error") {
  send({ type: "error", code: "worker_error", message: "synthetic failure" });
  process.exit(1);
}
if (mode === "garbage") {
  process.stdout.write("this is not json\n");
  await Bun.sleep(60_000);
}
if (mode === "hang") {
  const child = Bun.spawn(["sleep", "600"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  // Also persist next to the scratch dir (workRoot/<job>.pids.json), which survives its removal.
  const jobDir = path.dirname(start.output_dir);
  writeFileSync(
    path.join(
      path.dirname(path.dirname(jobDir)),
      `${path.basename(jobDir)}.pids.json`,
    ),
    JSON.stringify({ worker: process.pid, grandchild: child.pid }),
  );
  send({ type: "progress", step: 1, loss: 9.5 });
  await Bun.sleep(600_000);
}

send({ type: "progress", step: 1, loss: 2.5 });
send({ type: "progress", step: 2, loss: 2.25 });
const adapterDir = path.join(start.output_dir, "adapter");
mkdirSync(adapterDir, { recursive: true });
const header = new TextEncoder().encode(
  JSON.stringify({
    "base_model.model.lora_A.weight": {
      dtype: "F32",
      shape: [1, 1],
      data_offsets: [0, 4],
    },
  }),
);
const weights = new Uint8Array(8 + header.byteLength + 4);
new DataView(weights.buffer).setBigUint64(0, BigInt(header.byteLength), true);
weights.set(header, 8);
writeFileSync(path.join(adapterDir, "adapter_model.safetensors"), weights);
writeFileSync(
  path.join(adapterDir, "adapter_config.json"),
  JSON.stringify({
    peft_type: "LORA",
    base_model_name_or_path:
      mode === "bad-config" ? "someone/else" : start.base.repo,
    revision: start.base.revision,
    r: start.lora.r,
  }),
);
send({
  type: "done",
  files: ["adapter_model.safetensors", "adapter_config.json"],
  metrics: {
    global_steps: start.sft.max_steps,
    train_loss: 2.375,
    eval_loss: 2.4,
    train_seconds: 0.01,
    trainable_params: 16,
    total_params: 1000,
    train_examples: 9,
    validation_examples: 3,
    device: mode === "cuda" ? "cuda" : "cpu",
  },
  reload: {
    loaded: true,
    max_abs_logit_diff_vs_trained: 0,
    max_abs_logit_diff_vs_base: 0.01,
    prompt_tokens: 4,
    generated_tokens: 2,
    generated_text: "synthetic",
  },
});
