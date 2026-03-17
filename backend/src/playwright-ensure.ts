/**
 * Ensure Playwright Chromium is installed before scraping.
 * Runs automatically at server startup; installs Chromium if missing.
 */

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

export function ensurePlaywrightChromium(): void {
  try {
    const { chromium } = require("playwright");
    const executablePath = chromium.executablePath();
    if (executablePath && fs.existsSync(executablePath)) {
      console.log("Playwright Chromium: already installed");
      return;
    }
  } catch {
    // executablePath() may throw if browser not installed
  }

  const backendDir = path.join(__dirname, "..");
  console.log("Playwright Chromium: installing (required for scraping)...");
  try {
    execSync("npx playwright install chromium", {
      cwd: backendDir,
      stdio: "inherit" as const,
    });
    console.log("Playwright Chromium: install complete");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Playwright Chromium is required to scrape listing photos but installation failed: ${msg}. ` +
        `Try running manually from the backend folder: npx playwright install chromium`
    );
  }
}
