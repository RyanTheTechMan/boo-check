#!/usr/bin/env node
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, opendir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";

const supportedExtensions = new Map([
  [".jpg", ".jpg"],
  [".jpeg", ".jpg"],
  [".png", ".png"],
  [".gif", ".gif"],
  [".webp", ".webp"],
  [".mp4", ".mp4"],
  [".webm", ".webm"]
]);

const zipUint32Max = 0xffffffff;
const crc32Table = makeCrc32Table();

const usage = `Usage:
  node scripts/prepare-blombooru-import.mjs <input-dir> <output-dir> [options]

Options:
  --hash md5|sha256       Filename hash algorithm. Defaults to md5.
  --manifest <path>       Manifest output path. Defaults to <output-dir>/blombooru-import-manifest.json.
  --zip <path>            Also create a zip archive containing the flattened output files.
  --clean                 Remove the output directory before writing it.
  --quiet                 Disable progress bars and zip command output.
  --help                  Show this help.

Examples:
  node scripts/prepare-blombooru-import.mjs ~/Pictures/raw ./blombooru-flat
  node scripts/prepare-blombooru-import.mjs ~/Pictures/raw ./blombooru-flat --zip ./blombooru-import.zip
  node scripts/prepare-blombooru-import.mjs ~/Pictures/raw ./blombooru-flat --hash sha256
`;

class ProgressBar {
  constructor(label, { enabled = true, total = undefined } = {}) {
    this.label = label;
    this.enabled = enabled && Boolean(process.stderr.isTTY);
    this.total = total;
    this.current = 0;
    this.startedAt = Date.now();
    this.lastRenderedAt = 0;
  }

  update(current, { counts: nextCounts } = {}) {
    this.current = current;
    this.render(nextCounts);
  }

  increment({ counts: nextCounts } = {}) {
    this.current += 1;
    this.render(nextCounts);
  }

  finish(message) {
    if (!this.enabled) return;
    this.current = this.total ?? this.current;
    this.render(undefined, true);
    process.stderr.write(`\n${this.label}: ${message ?? "done"}\n`);
  }

  render(nextCounts, force = false) {
    if (!this.enabled) return;

    const now = Date.now();
    if (!force && now - this.lastRenderedAt < 80) return;
    this.lastRenderedAt = now;

    const width = 28;
    const elapsed = formatDuration(now - this.startedAt);
    let line;

    if (this.total === undefined) {
      line = `${this.label}: ${this.current} file${this.current === 1 ? "" : "s"} scanned | ${elapsed}`;
    } else {
      const ratio = this.total > 0 ? this.current / this.total : 1;
      const filled = Math.round(width * Math.min(1, ratio));
      const bar = `${"#".repeat(filled)}${"-".repeat(width - filled)}`;
      const percent = Math.round(ratio * 100).toString().padStart(3, " ");
      const status = nextCounts
        ? ` copied ${nextCounts.copied}, dupes ${nextCounts.duplicates}, skipped ${nextCounts.unsupported}, errors ${nextCounts.errors}`
        : "";
      line = `${this.label}: [${bar}] ${percent}% ${this.current}/${this.total}${status} | ${elapsed}`;
    }

    process.stderr.write(`\r${line.slice(0, process.stderr.columns ? process.stderr.columns - 1 : 120)}`);
  }
}

const args = process.argv.slice(2);

if (args.includes("--help") || args.length < 2) {
  console.log(usage.trim());
  process.exit(args.includes("--help") ? 0 : 1);
}

const positional = [];
const options = {
  hash: "md5",
  clean: false,
  manifest: undefined,
  zip: undefined,
  quiet: false
};

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];

  if (arg === "--hash") {
    options.hash = requireValue(args, ++i, "--hash");
  } else if (arg === "--manifest") {
    options.manifest = requireValue(args, ++i, "--manifest");
  } else if (arg === "--zip") {
    options.zip = requireValue(args, ++i, "--zip");
  } else if (arg === "--clean") {
    options.clean = true;
  } else if (arg === "--quiet") {
    options.quiet = true;
  } else if (arg.startsWith("--")) {
    throw new Error(`Unknown option: ${arg}`);
  } else {
    positional.push(arg);
  }
}

if (positional.length !== 2) {
  throw new Error("Expected exactly <input-dir> and <output-dir>.");
}

if (!["md5", "sha256"].includes(options.hash)) {
  throw new Error("--hash must be md5 or sha256.");
}

const inputDir = resolve(process.cwd(), positional[0]);
const outputDir = resolve(process.cwd(), positional[1]);
const manifestPath = resolve(process.cwd(), options.manifest ?? resolve(outputDir, "blombooru-import-manifest.json"));
const zipPath = options.zip ? resolve(process.cwd(), options.zip) : undefined;

await assertDirectory(inputDir, "Input directory");

if (inputDir === outputDir) {
  throw new Error("Input and output directories must be different.");
}

if (zipPath && isPathInside(zipPath, outputDir)) {
  throw new Error("--zip output must not be inside the flattened output directory.");
}

if (options.clean) {
  await rm(outputDir, { recursive: true, force: true });
}

await mkdir(outputDir, { recursive: true });
await mkdir(dirname(manifestPath), { recursive: true });
if (zipPath) await mkdir(dirname(zipPath), { recursive: true });

const manifest = {
  generatedAt: new Date().toISOString(),
  sourceRoot: inputDir,
  outputRoot: outputDir,
  hashAlgorithm: options.hash,
  supportedExtensions: Array.from(supportedExtensions.keys()),
  entries: []
};

const seenHashes = new Map();
const counts = {
  copied: 0,
  duplicates: 0,
  unsupported: 0,
  errors: 0
};

const sourceFiles = [];
const scanProgress = new ProgressBar("Scanning", { enabled: !options.quiet });

for await (const sourcePath of walkFiles(inputDir, outputDir)) {
  sourceFiles.push(sourcePath);
  scanProgress.update(sourceFiles.length);
}

scanProgress.finish(`${sourceFiles.length} file${sourceFiles.length === 1 ? "" : "s"} found`);

const processProgress = new ProgressBar("Processing", {
  enabled: !options.quiet,
  total: sourceFiles.length
});

for (const sourcePath of sourceFiles) {
  const originalRelativePath = relative(inputDir, sourcePath);
  const canonicalExtension = supportedExtensions.get(extname(sourcePath).toLowerCase());

  if (!canonicalExtension) {
    counts.unsupported += 1;
    manifest.entries.push({
      status: "unsupported",
      source: originalRelativePath,
      reason: "Unsupported by Blombooru archive import"
    });
    processProgress.increment({ counts });
    continue;
  }

  try {
    const fileHash = await hashFile(sourcePath, options.hash);
    const duplicateOf = seenHashes.get(fileHash);

    if (duplicateOf) {
      counts.duplicates += 1;
      manifest.entries.push({
        status: "duplicate",
        source: originalRelativePath,
        hash: fileHash,
        duplicateOf
      });
      processProgress.increment({ counts });
      continue;
    }

    const outputName = `${fileHash}${canonicalExtension}`;
    const targetPath = resolve(outputDir, outputName);
    await copyFile(sourcePath, targetPath);
    seenHashes.set(fileHash, outputName);
    counts.copied += 1;

    manifest.entries.push({
      status: "copied",
      source: originalRelativePath,
      output: outputName,
      hash: fileHash
    });
  } catch (error) {
    counts.errors += 1;
    manifest.entries.push({
      status: "error",
      source: originalRelativePath,
      reason: error instanceof Error ? error.message : String(error)
    });
  }

  processProgress.increment({ counts });
}

processProgress.finish();

manifest.counts = counts;

await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

if (zipPath && counts.copied > 0) {
  await rm(zipPath, { force: true });
  const copiedFiles = manifest.entries
    .filter((entry) => entry.status === "copied")
    .map((entry) => entry.output);
  await createZipArchive({
    sourceDir: outputDir,
    zipPath,
    files: copiedFiles,
    quiet: options.quiet
  });
}

console.log(`Prepared ${counts.copied} file${counts.copied === 1 ? "" : "s"} in ${outputDir}`);
console.log(`Skipped ${counts.duplicates} duplicate${counts.duplicates === 1 ? "" : "s"} and ${counts.unsupported} unsupported file${counts.unsupported === 1 ? "" : "s"}.`);
if (counts.errors) console.log(`Encountered ${counts.errors} error${counts.errors === 1 ? "" : "s"}; see manifest.`);
console.log(`Manifest: ${manifestPath}`);
if (zipPath && counts.copied > 0) console.log(`Zip: ${zipPath}`);
if (zipPath && counts.copied === 0) console.log("Zip skipped because no supported media files were copied.");

async function* walkFiles(directory, skipDirectory) {
  const dir = await opendir(directory);

  for await (const entry of dir) {
    const entryPath = resolve(directory, entry.name);

    if (entry.isDirectory()) {
      if (entryPath === skipDirectory || isPathInside(entryPath, skipDirectory)) continue;
      yield* walkFiles(entryPath, skipDirectory);
    } else if (entry.isFile()) {
      yield entryPath;
    }
  }
}

async function hashFile(path, algorithm) {
  return await new Promise((resolvePromise, reject) => {
    const hash = createHash(algorithm);
    const stream = createReadStream(path);

    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolvePromise(hash.digest("hex")));
  });
}

async function createZipArchive({ sourceDir, zipPath, files, quiet }) {
  if (!quiet) console.log("Creating zip archive...");

  const zipProgress = new ProgressBar("Zipping", {
    enabled: !quiet,
    total: files.length
  });

  const output = createWriteStream(zipPath);
  const centralDirectory = [];
  let offset = 0;

  try {
    for (const name of files) {
      const sourcePath = resolve(sourceDir, name);
      const fileStats = await stat(sourcePath);

      if (fileStats.size > zipUint32Max) {
        throw new Error(`Cannot zip ${name}: files larger than 4 GiB require Zip64, which this script does not write.`);
      }

      const crc = await crc32File(sourcePath);
      const nameBuffer = Buffer.from(name, "utf8");
      const { time, date } = dosDateTime(fileStats.mtime);
      const localOffset = offset;
      const localHeader = Buffer.alloc(30 + nameBuffer.length);

      localHeader.writeUInt32LE(0x04034b50, 0);
      localHeader.writeUInt16LE(20, 4);
      localHeader.writeUInt16LE(0x0800, 6);
      localHeader.writeUInt16LE(0, 8);
      localHeader.writeUInt16LE(time, 10);
      localHeader.writeUInt16LE(date, 12);
      localHeader.writeUInt32LE(crc, 14);
      localHeader.writeUInt32LE(fileStats.size, 18);
      localHeader.writeUInt32LE(fileStats.size, 22);
      localHeader.writeUInt16LE(nameBuffer.length, 26);
      localHeader.writeUInt16LE(0, 28);
      nameBuffer.copy(localHeader, 30);

      await writeChunk(output, localHeader);
      offset += localHeader.length;

      for await (const chunk of createReadStream(sourcePath)) {
        await writeChunk(output, chunk);
        offset += chunk.length;
      }

      centralDirectory.push({
        nameBuffer,
        crc,
        size: fileStats.size,
        time,
        date,
        offset: localOffset
      });

      if (offset > zipUint32Max) {
        throw new Error("Zip archive exceeded 4 GiB. Split the import into smaller archives.");
      }

      zipProgress.increment();
    }

    const centralStart = offset;

    for (const entry of centralDirectory) {
      const centralHeader = Buffer.alloc(46 + entry.nameBuffer.length);

      centralHeader.writeUInt32LE(0x02014b50, 0);
      centralHeader.writeUInt16LE(20, 4);
      centralHeader.writeUInt16LE(20, 6);
      centralHeader.writeUInt16LE(0x0800, 8);
      centralHeader.writeUInt16LE(0, 10);
      centralHeader.writeUInt16LE(entry.time, 12);
      centralHeader.writeUInt16LE(entry.date, 14);
      centralHeader.writeUInt32LE(entry.crc, 16);
      centralHeader.writeUInt32LE(entry.size, 20);
      centralHeader.writeUInt32LE(entry.size, 24);
      centralHeader.writeUInt16LE(entry.nameBuffer.length, 28);
      centralHeader.writeUInt16LE(0, 30);
      centralHeader.writeUInt16LE(0, 32);
      centralHeader.writeUInt16LE(0, 34);
      centralHeader.writeUInt16LE(0, 36);
      centralHeader.writeUInt32LE(0, 38);
      centralHeader.writeUInt32LE(entry.offset, 42);
      entry.nameBuffer.copy(centralHeader, 46);

      await writeChunk(output, centralHeader);
      offset += centralHeader.length;
    }

    const centralSize = offset - centralStart;

    if (centralDirectory.length > 0xffff) {
      throw new Error("Zip archive has too many files. Split the import into smaller archives.");
    }

    if (centralStart > zipUint32Max || centralSize > zipUint32Max) {
      throw new Error("Zip archive exceeded 4 GiB. Split the import into smaller archives.");
    }

    const endRecord = Buffer.alloc(22);
    endRecord.writeUInt32LE(0x06054b50, 0);
    endRecord.writeUInt16LE(0, 4);
    endRecord.writeUInt16LE(0, 6);
    endRecord.writeUInt16LE(centralDirectory.length, 8);
    endRecord.writeUInt16LE(centralDirectory.length, 10);
    endRecord.writeUInt32LE(centralSize, 12);
    endRecord.writeUInt32LE(centralStart, 16);
    endRecord.writeUInt16LE(0, 20);

    await writeChunk(output, endRecord);
    await finishWritable(output);
    zipProgress.finish();
  } catch (error) {
    output.destroy();
    await rm(zipPath, { force: true });
    throw error;
  }
}

async function writeChunk(stream, chunk) {
  if (!stream.write(chunk)) {
    await once(stream, "drain");
  }
}

async function finishWritable(stream) {
  stream.end();
  await Promise.race([
    once(stream, "finish"),
    once(stream, "error").then(([error]) => {
      throw error;
    })
  ]);
}

async function crc32File(path) {
  let crc = 0xffffffff;

  for await (const chunk of createReadStream(path)) {
    for (const byte of chunk) {
      crc = crc32Table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function makeCrc32Table() {
  const table = new Uint32Array(256);

  for (let i = 0; i < table.length; i += 1) {
    let value = i;

    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }

    table[i] = value >>> 0;
  }

  return table;
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = Math.floor(date.getSeconds() / 2);

  return {
    time: (hours << 11) | (minutes << 5) | seconds,
    date: ((year - 1980) << 9) | (month << 5) | day
  };
}

async function assertDirectory(path, label) {
  let stats;

  try {
    stats = await stat(path);
  } catch {
    throw new Error(`${label} does not exist: ${path}`);
  }

  if (!stats.isDirectory()) {
    throw new Error(`${label} is not a directory: ${path}`);
  }
}

function isPathInside(candidate, parent) {
  const rel = relative(parent, candidate);
  return Boolean(rel) && !rel.startsWith("..") && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function requireValue(values, index, flag) {
  const value = values[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${rest.toString().padStart(2, "0")}`;
}
