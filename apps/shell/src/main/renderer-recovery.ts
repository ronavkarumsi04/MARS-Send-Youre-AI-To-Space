export const RENDERER_RECOVERY_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>MARS recovery</title></head>
<body><main><h1>MARS could not restore its window</h1>
<p>The renderer stopped repeatedly. Quit and reopen MARS to try again.</p>
</main></body></html>`;

export function createRendererRecovery(options: {
  reload(): void;
  showRecovery(): void;
  log(reason: string): void;
  isClosing(): boolean;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  let reloads: number[] = [];
  let failed = false;
  return (reason: string) => {
    if (options.isClosing() || reason === "clean-exit" || failed) return;
    options.log(reason);
    const time = now();
    reloads = reloads.filter((at) => time - at < 60_000);
    if (reloads.length >= 3) {
      failed = true;
      options.showRecovery();
      return;
    }
    reloads = [...reloads, time];
    options.reload();
  };
}
