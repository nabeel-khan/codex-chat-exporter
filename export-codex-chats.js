#!/usr/bin/env node

"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { generateChatPdf, isUsablePdf } = require("./chat-pdf");

const UUID_AT_END = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const execFileAsync = promisify(execFile);

function printHelp() {
  console.log(`Export Codex sessions into project/title folders.

Usage:
  export-codex-chats [options]

Options:
  --source <path>  Session directory (default: ~/.codex/sessions)
  --index <path>   Codex title index (default: ~/.codex/session_index.jsonl)
  --state <path>   Codex state database (default: ~/.codex/state_5.sqlite)
  --output <path>  Export directory (default: current working directory)
  --project <name> Export only this project (case-insensitive exact match)
  --pdf            Also generate readable PDF transcripts
  --dry-run        Show what would happen without writing files
  --help, -h       Show this help

Output layout:
  <output>/<Project-Name>/<Session-Title>.jsonl
  <output>/<Project-Name>/<Session-Title>.pdf  (with --pdf)
`);
}

function parseArgs(argv) {
  const home = os.homedir();
  const options = {
    source: path.join(home, ".codex", "sessions"),
    index: path.join(home, ".codex", "session_index.jsonl"),
    state: path.join(home, ".codex", "state_5.sqlite"),
    output: process.cwd(),
    project: undefined,
    pdf: false,
    dryRun: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--pdf") {
      options.pdf = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--source" || arg === "--index" || arg === "--state" || arg === "--output" || arg === "--project") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      options[arg.slice(2)] = arg === "--project" ? value.trim() : path.resolve(value);
      if (arg === "--project" && !options.project) {
        throw new Error("--project requires a non-empty name");
      }
      i += 1;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  options.source = path.resolve(options.source);
  options.index = path.resolve(options.index);
  options.state = path.resolve(options.state);
  options.output = path.resolve(options.output);
  return options;
}

function truncateUtf8(value, maxBytes) {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;

  let result = "";
  for (const character of value) {
    if (Buffer.byteLength(result + character, "utf8") > maxBytes) break;
    result += character;
  }
  return result;
}

function sanitizeSegment(value, fallback, maxBytes = 180) {
  let result = String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[\\/:*?"<>|]+/g, " - ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/(?:\s+-)+$/g, "")
    .replace(/[. ]+$/g, "");

  if (!result || result === "." || result === "..") result = fallback;
  if (WINDOWS_RESERVED_NAME.test(result)) result = `_${result}`;

  result = truncateUtf8(result, maxBytes).replace(/[. ]+$/g, "");
  return result || fallback;
}

function sessionIdFromFilename(filePath) {
  return path.basename(filePath).match(UUID_AT_END)?.[1];
}

function shortSessionId(sessionId, filePath) {
  if (sessionId) return sessionId.replaceAll("-", "").slice(-12);
  return path.basename(filePath, ".jsonl").slice(-12);
}

function projectNameFromCwd(cwd) {
  if (!cwd || typeof cwd !== "string") return "Unknown-Project";

  const parts = cwd.replace(/[\\/]+$/g, "").split(/[\\/]/).filter(Boolean);
  const basename = parts.at(-1);
  if (!basename) return "Root";
  return sanitizeSegment(basename, "Unknown-Project", 100);
}

function titleFromMessage(message) {
  if (typeof message !== "string") return undefined;

  const cleaned = message
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/^\s{0,3}(?:#{1,6}|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) return undefined;
  return truncateUtf8(cleaned, 100);
}

function userMessageFromRecord(record) {
  const payload = record?.payload;
  if (!payload || typeof payload !== "object") return undefined;

  if (
    record.type === "event_msg" &&
    payload.type === "user_message" &&
    typeof payload.message === "string"
  ) {
    return payload.message;
  }

  if (record.type === "response_item" && payload.role === "user" && Array.isArray(payload.content)) {
    return payload.content
      .filter((item) => item && (item.type === "input_text" || item.type === "text"))
      .map((item) => item.text)
      .filter((item) => typeof item === "string")
      .join("\n");
  }

  return undefined;
}

async function loadTitleIndex(indexPath) {
  const titles = new Map();
  let stream;

  try {
    stream = fs.createReadStream(indexPath, { encoding: "utf8" });
    await new Promise((resolve, reject) => {
      stream.once("open", resolve);
      stream.once("error", reject);
    });
  } catch (error) {
    if (error.code === "ENOENT") return titles;
    throw error;
  }

  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (typeof entry.id === "string" && typeof entry.thread_name === "string" && entry.thread_name.trim()) {
        // session_index.jsonl is an append-only log; the last name wins.
        titles.set(entry.id, entry.thread_name.trim());
      }
    } catch {
      // A partially written last line should not prevent the remaining sessions from exporting.
    }
  }

  return titles;
}

async function loadStateTitles(statePath) {
  const titles = new Map();
  try {
    const { stdout } = await execFileAsync(
      "sqlite3",
      [
        "-readonly",
        "-json",
        statePath,
        "SELECT id, title FROM threads WHERE id IS NOT NULL AND trim(title) <> '';",
      ],
      { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
    );
    const rows = stdout.trim() ? JSON.parse(stdout) : [];
    for (const row of rows) {
      if (typeof row.id === "string" && typeof row.title === "string" && row.title.trim()) {
        titles.set(row.id, row.title.trim());
      }
    }
  } catch {
    // The database and sqlite3 CLI are optional; session_index/user messages remain available.
  }
  return titles;
}

async function loadTitles(indexPath, statePath) {
  const [stateTitles, indexTitles] = await Promise.all([
    loadStateTitles(statePath),
    loadTitleIndex(indexPath),
  ]);
  // The JSONL index is append-only and may contain a rename newer than the database snapshot.
  for (const [id, title] of indexTitles) stateTitles.set(id, title);
  return stateTitles;
}

async function findJsonlFiles(root) {
  const results = [];

  async function visit(directory) {
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        results.push(entryPath);
      }
    }
  }

  await visit(root);
  return results;
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function inspectSession(filePath, titleIndex) {
  const filenameId = sessionIdFromFilename(filePath);
  const indexedTitle = filenameId ? titleIndex.get(filenameId) : undefined;
  let fallbackMeta;
  let matchingMeta;
  let firstUserMessage;

  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    if (record.type === "session_meta" && record.payload && typeof record.payload === "object") {
      fallbackMeta ??= record.payload;
      const recordId = record.payload.id || record.payload.session_id;
      if (!filenameId || recordId === filenameId) matchingMeta = record.payload;
    }

    if (!firstUserMessage) {
      firstUserMessage = userMessageFromRecord(record);
    }

    if ((matchingMeta || (!filenameId && fallbackMeta)) && (indexedTitle || firstUserMessage)) break;
  }

  const meta = matchingMeta || fallbackMeta || {};
  const sessionId = filenameId || meta.id || meta.session_id;
  const rawTitle =
    indexedTitle ||
    (sessionId ? titleIndex.get(sessionId) : undefined) ||
    titleFromMessage(firstUserMessage) ||
    `Untitled session ${shortSessionId(sessionId, filePath)}`;

  return {
    source: filePath,
    sessionId,
    cwd: meta.cwd,
    createdAt: meta.timestamp,
    project: projectNameFromCwd(meta.cwd),
    title: sanitizeSegment(rawTitle, `Untitled session ${shortSessionId(sessionId, filePath)}`),
  };
}

function isSameOrInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function assignDestinations(sessions, outputRoot) {
  const groups = new Map();
  const positions = new Map();
  const usedDestinations = new Set();

  for (const session of sessions) {
    const key = `${session.project.toLocaleLowerCase()}\0${session.title.toLocaleLowerCase()}`;
    const group = groups.get(key) || [];
    group.push(session);
    groups.set(key, group);
  }

  for (const [key, group] of groups) {
    group.sort((a, b) => a.source.localeCompare(b.source));
    group.forEach((session, index) => positions.set(session, { key, index, size: group.length }));
  }

  for (const session of [...sessions].sort((a, b) => a.source.localeCompare(b.source))) {
    const position = positions.get(session);
    const idSuffix = ` -- ${shortSessionId(session.sessionId, session.source)}`;
    let suffix = position.index === 0 ? "" : idSuffix;
    let candidate = `${truncateUtf8(session.title, 180 - Buffer.byteLength(suffix))}${suffix}`;
    let destinationKey = `${session.project.toLocaleLowerCase()}\0${candidate.toLocaleLowerCase()}`;
    let counter = 2;

    while (usedDestinations.has(destinationKey)) {
      suffix = `${idSuffix}-${counter}`;
      candidate = `${truncateUtf8(session.title, 180 - Buffer.byteLength(suffix))}${suffix}`;
      destinationKey = `${session.project.toLocaleLowerCase()}\0${candidate.toLocaleLowerCase()}`;
      counter += 1;
    }

    usedDestinations.add(destinationKey);
    session.destination = path.join(outputRoot, session.project, `${candidate}.jsonl`);
    session.pdfDestination = path.join(outputRoot, session.project, `${candidate}.pdf`);
    session.hadCollision = position.size > 1 || counter > 2;
  }

  return sessions;
}

async function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function filesAreEqual(left, right) {
  try {
    const [leftStat, rightStat] = await Promise.all([fsp.stat(left), fsp.stat(right)]);
    if (leftStat.size !== rightStat.size) return false;
    const [leftHash, rightHash] = await Promise.all([hashFile(left), hashFile(right)]);
    return leftHash === rightHash;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function exportSessions(options) {
  const source = path.resolve(options.source);
  const output = path.resolve(options.output);

  if (isSameOrInside(output, source)) {
    throw new Error("The output directory cannot be the session source or a folder inside it.");
  }

  const sourceStat = await fsp.stat(source).catch((error) => {
    if (error.code === "ENOENT") throw new Error(`Session directory does not exist: ${source}`);
    throw error;
  });
  if (!sourceStat.isDirectory()) throw new Error(`Session source is not a directory: ${source}`);

  const statePath = options.state || path.join(path.dirname(options.index), "state_5.sqlite");
  const [sourceFiles, titleIndex] = await Promise.all([
    findJsonlFiles(source),
    loadTitles(options.index, statePath),
  ]);
  const allSessions = await mapWithConcurrency(sourceFiles, 16, (file) => inspectSession(file, titleIndex));
  const availableProjects = [...new Set(allSessions.map((session) => session.project))]
    .sort((left, right) => left.localeCompare(right));
  const requestedProject = options.project?.toLocaleLowerCase();
  const sessions = requestedProject
    ? allSessions.filter((session) => session.project.toLocaleLowerCase() === requestedProject)
    : allSessions;

  if (requestedProject && sessions.length === 0) {
    throw new Error(
      `Project "${options.project}" was not found. Available projects: ${availableProjects.join(", ") || "none"}`,
    );
  }

  assignDestinations(sessions, output);

  const result = {
    found: sessions.length,
    scanned: allSessions.length,
    copied: 0,
    unchanged: 0,
    pdfsGenerated: 0,
    pdfsUnchanged: 0,
    pdfErrors: [],
    projects: new Set(sessions.map((session) => session.project)).size,
    collisions: sessions.filter((session) => session.hadCollision).length,
    sessions,
  };

  if (options.dryRun) return result;

  for (let index = 0; index < sessions.length; index += 1) {
    const session = sessions[index];
    options.onProgress?.({ index: index + 1, total: sessions.length, session });
    await fsp.mkdir(path.dirname(session.destination), { recursive: true });
    const jsonlUnchanged = await filesAreEqual(session.source, session.destination);
    if (jsonlUnchanged) {
      result.unchanged += 1;
    } else {
      await fsp.copyFile(session.source, session.destination);
      result.copied += 1;
    }

    if (options.pdf) {
      if (jsonlUnchanged && await isUsablePdf(session.pdfDestination)) {
        result.pdfsUnchanged += 1;
      } else {
        try {
          await generateChatPdf(session, session.pdfDestination);
          result.pdfsGenerated += 1;
        } catch (error) {
          result.pdfErrors.push({ source: session.source, message: error.message });
        }
      }
    }
  }

  return result;
}

async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`Error: ${error.message}\n`);
    printHelp();
    process.exitCode = 1;
    return;
  }

  if (options.help) {
    printHelp();
    return;
  }

  try {
    if (!options.dryRun) {
      options.onProgress = ({ index, total, session }) => {
        const destination = options.pdf ? session.pdfDestination : session.destination;
        const label = `${session.project}/${path.basename(destination)}`;
        process.stdout.write(`\r[${index}/${total}] ${truncateUtf8(label, 90).padEnd(90)}`);
      };
    }
    const result = await exportSessions(options);
    if (!options.dryRun) process.stdout.write("\n");
    const action = options.dryRun ? "Would export" : "Exported";
    console.log(`${action} ${result.found} session${result.found === 1 ? "" : "s"} across ${result.projects} project${result.projects === 1 ? "" : "s"}.`);
    if (!options.dryRun) {
      console.log(`JSONL copied/updated: ${result.copied}; unchanged: ${result.unchanged}.`);
      if (options.pdf) {
        console.log(`PDFs generated: ${result.pdfsGenerated}; unchanged: ${result.pdfsUnchanged}.`);
      } else {
        console.log("PDF export: skipped (enable with --pdf).");
      }
      if (options.pdf && result.pdfErrors.length > 0) {
        console.error(`PDF generation failed for ${result.pdfErrors.length} session${result.pdfErrors.length === 1 ? "" : "s"}:`);
        for (const failure of result.pdfErrors.slice(0, 5)) {
          console.error(`- ${path.basename(failure.source)}: ${failure.message}`);
        }
        process.exitCode = 1;
      }
    } else {
      console.log(`PDF export: ${options.pdf ? "enabled" : "disabled"}.`);
    }
    if (result.collisions > 0) {
      console.log(`${result.collisions} sessions shared a sanitized project/title; later duplicates received a session-ID suffix.`);
    }
    console.log(`Output: ${options.output}`);
  } catch (error) {
    console.error(`Export failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  assignDestinations,
  exportSessions,
  loadTitleIndex,
  loadStateTitles,
  parseArgs,
  projectNameFromCwd,
  sanitizeSegment,
  titleFromMessage,
};

if (require.main === module) {
  main();
}
