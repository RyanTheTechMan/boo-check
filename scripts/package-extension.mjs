import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = resolve(rootDir, "dist");
const releaseDir = resolve(rootDir, "release");
const packageJson = JSON.parse(readFileSync(resolve(rootDir, "package.json"), "utf8"));

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

const zipPath = resolve(releaseDir, `${packageJson.name}-${manifest.version}.zip`);

rmSync(zipPath, { force: true });

execFileSync("zip", ["-r", "-X", zipPath, "."], {
  cwd: distDir,
  stdio: "inherit"
});

console.log(`Created ${zipPath}`);
