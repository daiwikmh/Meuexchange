import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.WHITEPAPER_PORT ?? 4399);
const URL = `http://localhost:${PORT}/whitepaper/`;
const OUTPUT = "public/whitepaper.pdf";
const PRINT_TIMEOUT_MS = 120_000;

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser"
];

function findChrome() {
  const found = CHROME_CANDIDATES.find((path) => path && existsSync(path));
  if (!found) {
    throw new Error(
      `No Chrome or Chromium found. Set CHROME_PATH to a binary that supports --print-to-pdf.\nLooked in:\n${CHROME_CANDIDATES.filter(Boolean).join("\n")}`
    );
  }
  return found;
}

function build() {
  const result = spawnSync("npx", ["astro", "build"], { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`astro build failed with status ${result.status}`);
}

async function waitForServer(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(URL)).ok) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Preview server did not answer ${URL} within ${timeoutMs}ms`);
}

/** Chrome lingers after writing the file, so judge it by its output and stop it. */
async function print(chrome: string, profile: string) {
  if (existsSync(OUTPUT)) unlinkSync(OUTPUT);

  const child = spawn(
    chrome,
    [
      "--headless",
      "--disable-gpu",
      "--no-sandbox",
      "--no-first-run",
      "--no-pdf-header-footer",
      "--virtual-time-budget=10000",
      `--user-data-dir=${profile}`,
      `--print-to-pdf=${OUTPUT}`,
      URL
    ],
    { stdio: "ignore", detached: true }
  );

  try {
    const deadline = Date.now() + PRINT_TIMEOUT_MS;
    let lastSize = -1;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (!existsSync(OUTPUT)) continue;
      const size = statSync(OUTPUT).size;
      if (size > 0 && size === lastSize) return;
      lastSize = size;
    }
    throw new Error(`Chrome did not finish writing ${OUTPUT} within ${PRINT_TIMEOUT_MS}ms`);
  } finally {
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
}

async function main() {
  const chrome = findChrome();

  console.log("==> Building the static site");
  build();

  console.log(`==> Serving dist/ on :${PORT}`);
  const preview = spawn("npx", ["astro", "preview", "--port", String(PORT)], {
    stdio: "ignore",
    detached: true
  });

  const profile = mkdtempSync(join(tmpdir(), "meu-whitepaper-"));

  try {
    await waitForServer();
    console.log(`==> Printing ${URL}`);
    await print(chrome, profile);
  } finally {
    if (preview.pid) {
      try {
        process.kill(-preview.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    rmSync(profile, { recursive: true, force: true });
  }

  copyFileSync(OUTPUT, "dist/whitepaper.pdf");

  const kb = Math.round(statSync(OUTPUT).size / 1024);
  console.log(`\n${OUTPUT} — ${kb} kB (also copied to dist/whitepaper.pdf)`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
