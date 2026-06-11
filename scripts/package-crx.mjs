import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = resolve(rootDir, "dist");
const releaseDir = resolve(rootDir, "release");
const keyPath = resolve(releaseDir, "boo-check.pem");
const packageJson = JSON.parse(readFileSync(resolve(rootDir, "package.json"), "utf8"));

const browserCandidates = [
  process.env.CHROME_BIN,
  process.env.CHROMIUM_BIN,
  process.env.BRAVE_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
  "brave-browser",
  "brave",
  "microsoft-edge"
].filter(Boolean);

function findBrowser() {
  for (const candidate of browserCandidates) {
    try {
      execFileSync(candidate, ["--version"], { stdio: "ignore" });
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }

  throw new Error(
    "Could not find Chrome, Chromium, Brave, or Edge. Set CHROME_BIN to a Chromium-based browser binary."
  );
}

execFileSync("npm", ["run", "build"], { cwd: rootDir, stdio: "inherit" });

const manifestPath = resolve(distDir, "manifest.json");

if (!existsSync(manifestPath)) {
  throw new Error("Build did not produce dist/manifest.json.");
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

if (manifest.version !== packageJson.version) {
  throw new Error(
    `package.json version (${packageJson.version}) does not match manifest version (${manifest.version}).`
  );
}

mkdirSync(releaseDir, { recursive: true });

if (!existsSync(keyPath)) {
  execFileSync("openssl", ["genrsa", "-out", keyPath, "2048"], { stdio: "inherit" });
  console.log(`Created private key ${keyPath}`);
}

const browserPath = findBrowser();
const generatedCrxPath = resolve(rootDir, "dist.crx");
const crxPath = resolve(releaseDir, `${packageJson.name}-${manifest.version}.crx`);

rmSync(generatedCrxPath, { force: true });
rmSync(crxPath, { force: true });

execFileSync(
  browserPath,
  [`--pack-extension=${distDir}`, `--pack-extension-key=${keyPath}`],
  { cwd: rootDir, stdio: "inherit" }
);

if (!existsSync(generatedCrxPath)) {
  throw new Error(`Expected ${generatedCrxPath} to be created.`);
}

renameSync(generatedCrxPath, crxPath);

console.log(`Created ${crxPath}`);
console.log(`Keep ${keyPath} private and reuse it for future CRX builds.`);
