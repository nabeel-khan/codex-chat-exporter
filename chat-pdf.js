"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const readline = require("node:readline");

let pdfRuntime;

function extractResponseText(payload) {
  if (!Array.isArray(payload?.content)) return "";
  return payload.content
    .filter((item) => item && ["input_text", "output_text", "text"].includes(item.type))
    .map((item) => item.text)
    .filter((text) => typeof text === "string")
    .join("\n");
}

function looksLikeInjectedContext(text) {
  return /<environment_context>|<permissions instructions>|<app-context>|<skills_instructions>|^# AGENTS\.md instructions/m.test(text);
}

function normalizeTranscriptText(text) {
  return String(text ?? "")
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "    ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/^```[^\n]*$/gm, "")
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, label, url) => `${label || "Image"} [image: ${url}]`)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function normalizeActivityText(text) {
  return String(text ?? "")
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "    ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/data:[^;\s]+;base64,[A-Za-z0-9+/=\r\n]{200,}/g, "[binary data omitted; see adjacent JSONL]")
    .replace(/[A-Za-z0-9+/]{1000,}={0,2}/g, "[large encoded data omitted; see adjacent JSONL]")
    .trim();
}

function attachmentNote(payload) {
  const imageCount =
    (Array.isArray(payload?.images) ? payload.images.length : 0) +
    (Array.isArray(payload?.local_images) ? payload.local_images.length : 0);
  return imageCount > 0 ? `[${imageCount} image attachment${imageCount === 1 ? "" : "s"}]` : "";
}

function buildMessage(kind, text, timestamp, phase, attachments = "", sequence = 0, toolName) {
  const combined = [text, attachments].filter(Boolean).join("\n\n");
  const normalized = ["terminal", "terminal_result", "code", "code_result"].includes(kind)
    ? normalizeActivityText(combined)
    : normalizeTranscriptText(combined);
  if (!normalized) return undefined;
  return { kind, role: kind, text: normalized, timestamp, phase, sequence, toolName };
}

function formatToolValue(value) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") return JSON.stringify(value, null, 2);

  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2);
  } catch {
    return trimmed;
  }
}

function extractTextBlocks(value) {
  const blocks = Array.isArray(value) ? value : Array.isArray(value?.content) ? value.content : undefined;
  if (!blocks) return undefined;
  const texts = blocks
    .filter((block) => block && ["text", "input_text", "output_text"].includes(block.type))
    .map((block) => block.text)
    .filter((text) => typeof text === "string");
  return texts.length > 0 ? texts.join("\n") : undefined;
}

function formatToolOutput(value) {
  if (typeof value !== "string") {
    return extractTextBlocks(value) || formatToolValue(value);
  }
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed);
    return extractTextBlocks(parsed) || formatToolValue(parsed);
  } catch {
    return trimmed;
  }
}

function formatToolInput(name, value, kind) {
  const input = formatToolValue(value);
  if (kind !== "code" || String(name).toLowerCase() !== "exec") return input;

  const quotedPatch = input.match(/\bconst\s+patch\s*=\s*("(?:\\.|[^"\\])*")\s*;/s);
  if (quotedPatch) {
    try {
      return JSON.parse(quotedPatch[1]);
    } catch {
      // Keep the wrapper source when its string literal is not valid JSON syntax.
    }
  }
  return input;
}

function classifyToolCall(name, input) {
  const normalizedName = String(name || "").toLowerCase();
  const text = String(input || "");

  if (normalizedName === "apply_patch" || /tools\.(?:apply_patch|applyPatch)\s*\(/.test(text)) {
    return "code";
  }
  if (
    normalizedName === "exec_command" ||
    normalizedName === "write_stdin" ||
    (normalizedName === "exec" && /tools\.(?:exec_command|write_stdin)\s*\(/.test(text))
  ) {
    return "terminal";
  }
  return undefined;
}

async function extractConversation(filePath) {
  const eventMessages = [];
  const responseMessages = [];
  const activityMessages = [];
  const trackedCalls = new Map();
  let sequence = 0;
  let reasoningEntries = 0;
  let terminalCommands = 0;
  let codeEdits = 0;
  let toolResults = 0;

  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of lines) {
    sequence += 1;
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    const payload = record.payload || {};
    if (record.type === "event_msg" && payload.type === "user_message") {
      const message = buildMessage(
        "user",
        payload.message,
        record.timestamp,
        payload.phase,
        attachmentNote(payload),
        sequence,
      );
      if (message) eventMessages.push(message);
    } else if (record.type === "event_msg" && payload.type === "agent_message") {
      const message = buildMessage("assistant", payload.message, record.timestamp, payload.phase, "", sequence);
      if (message) eventMessages.push(message);
    } else if (record.type === "event_msg" && payload.type === "agent_reasoning") {
      const message = buildMessage("reasoning", payload.text, record.timestamp, payload.phase, "", sequence);
      if (message) {
        activityMessages.push(message);
        reasoningEntries += 1;
      }
    }

    if (record.type === "response_item" && payload.type === "message") {
      const text = extractResponseText(payload);
      if (
        (payload.role === "user" || payload.role === "assistant") &&
        text &&
        !(payload.role === "user" && looksLikeInjectedContext(text))
      ) {
        const message = buildMessage(payload.role, text, record.timestamp, payload.phase, "", sequence);
        if (message) responseMessages.push(message);
      }
    }

    if (record.type === "response_item" && ["function_call", "custom_tool_call"].includes(payload.type)) {
      const rawInput = payload.type === "function_call" ? payload.arguments : payload.input;
      const kind = classifyToolCall(payload.name, rawInput);
      if (kind) {
        const input = formatToolInput(payload.name, rawInput, kind);
        const message = buildMessage(
          kind,
          input,
          record.timestamp,
          payload.phase,
          "",
          sequence,
          payload.name,
        );
        if (message) {
          activityMessages.push(message);
          if (kind === "terminal") terminalCommands += 1;
          if (kind === "code") codeEdits += 1;
          if (payload.call_id) trackedCalls.set(payload.call_id, { kind, name: payload.name });
        }
      }
    } else if (
      record.type === "response_item" &&
      ["function_call_output", "custom_tool_call_output"].includes(payload.type)
    ) {
      const tracked = trackedCalls.get(payload.call_id);
      if (tracked) {
        const message = buildMessage(
          `${tracked.kind}_result`,
          formatToolOutput(payload.output),
          record.timestamp,
          payload.phase,
          "",
          sequence,
          tracked.name,
        );
        if (message) {
          activityMessages.push(message);
          toolResults += 1;
        }
      }
    }
  }

  const visibleMessages = eventMessages.length > 0 ? eventMessages : responseMessages;
  const messages = [...visibleMessages, ...activityMessages]
    .sort((left, right) => left.sequence - right.sequence);

  return {
    messages,
    visibleMessages: visibleMessages.length,
    reasoningEntries,
    terminalCommands,
    codeEdits,
    toolResults,
  };
}

function findTranscriptFont() {
  const candidates = [
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "C:\\Windows\\Fonts\\arial.ttf",
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function configurePdfMake() {
  if (pdfRuntime) return pdfRuntime;

  let pdfmake;
  try {
    pdfmake = require("pdfmake");
  } catch (error) {
    if (error.code === "MODULE_NOT_FOUND") {
      throw new Error("The pdfmake dependency is missing. Run `npm install` in the exporter directory.");
    }
    throw error;
  }

  const pdfmakeRoot = path.dirname(require.resolve("pdfmake/package.json"));
  const robotoRoot = path.join(pdfmakeRoot, "fonts", "Roboto");
  const roboto = {
    normal: path.join(robotoRoot, "Roboto-Regular.ttf"),
    bold: path.join(robotoRoot, "Roboto-Medium.ttf"),
    italics: path.join(robotoRoot, "Roboto-Italic.ttf"),
    bolditalics: path.join(robotoRoot, "Roboto-MediumItalic.ttf"),
  };
  const transcriptFont = findTranscriptFont() || roboto.normal;
  const allowedFiles = new Set([...Object.values(roboto), transcriptFont].map((file) => path.resolve(file)));

  pdfmake.setFonts({
    Roboto: roboto,
    Transcript: {
      normal: transcriptFont,
      bold: transcriptFont,
      italics: transcriptFont,
      bolditalics: transcriptFont,
    },
  });
  pdfmake.setUrlAccessPolicy(() => false);
  pdfmake.setLocalAccessPolicy((file) => allowedFiles.has(path.resolve(file)));

  let font;
  try {
    const fontkit = require("fontkit");
    font = fontkit.openSync(transcriptFont);
  } catch {
    font = undefined;
  }

  const glyphCache = new Map();
  function safeText(value) {
    const text = String(value ?? "");
    if (!font) return text;
    let result = "";
    for (const character of text) {
      const codePoint = character.codePointAt(0);
      if (character === "\n" || codePoint === 0xfe0f || codePoint === 0x200d) {
        result += character === "\n" ? character : "";
        continue;
      }
      let replacement = glyphCache.get(codePoint);
      if (replacement === undefined) {
        replacement = font.hasGlyphForCodePoint(codePoint)
          ? character
          : `[U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}]`;
        glyphCache.set(codePoint, replacement);
      }
      result += replacement;
    }
    return result;
  }

  pdfRuntime = { pdfmake, safeText };
  return pdfRuntime;
}

function formatTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "")} UTC`;
}

function messageCard(message, safeText) {
  const variants = {
    user: { label: "YOU", fill: "#EFF6FF", accent: "#2563EB", bodyStyle: "messageBody" },
    assistant: { label: "CODEX", fill: "#F8FAFC", accent: "#64748B", bodyStyle: "messageBody" },
    reasoning: { label: "REASONING SUMMARY", fill: "#FFFBEB", accent: "#D97706", bodyStyle: "reasoningBody" },
    terminal: { label: "TERMINAL COMMAND", fill: "#ECFDF5", accent: "#059669", bodyStyle: "activityBody" },
    terminal_result: { label: "TERMINAL RESULT", fill: "#F0FDFA", accent: "#0F766E", bodyStyle: "activityBody" },
    code: { label: "CODE EDIT", fill: "#F5F3FF", accent: "#7C3AED", bodyStyle: "activityBody" },
    code_result: { label: "EDIT RESULT", fill: "#FAF5FF", accent: "#9333EA", bodyStyle: "activityBody" },
  };
  const variant = variants[message.kind] || variants.assistant;
  const label = message.toolName ? `${variant.label} - ${message.toolName}` : variant.label;
  const fillColor = variant.fill;
  const accentColor = variant.accent;
  const timestamp = formatTimestamp(message.timestamp);

  return {
    style: "messageCard",
    table: {
      widths: [4, "*"],
      headerRows: 1,
      body: [
        [
          { text: "", fillColor: accentColor },
          {
            fillColor,
            margin: [10, 7, 10, 2],
            columns: [
              { text: label, style: "messageLabel", color: accentColor },
              { text: timestamp, style: "timestamp", alignment: "right" },
            ],
          },
        ],
        [
          { text: "", fillColor: accentColor },
          {
            text: safeText(message.text),
            style: variant.bodyStyle,
            fillColor,
            margin: [10, 2, 10, 9],
          },
        ],
      ],
    },
    layout: {
      hLineWidth: () => 0,
      vLineWidth: () => 0,
      paddingLeft: () => 0,
      paddingRight: () => 0,
      paddingTop: () => 0,
      paddingBottom: () => 0,
    },
    margin: [0, 0, 0, 10],
  };
}

function buildDocumentDefinition(session, transcript, safeText) {
  const title = safeText(session.title);
  const project = safeText(session.project);
  const entryCount = transcript.messages.length;
  const footerLabel = `${project} / ${title}`;
  const compactFooterLabel = footerLabel.length > 80 ? `${footerLabel.slice(0, 77)}...` : footerLabel;
  const content = [
    { text: "CODEX CHAT EXPORT", style: "eyebrow" },
    { text: title, style: "title" },
    {
      table: {
        widths: [90, "*"],
        body: [
          [{ text: "Project", style: "metaLabel" }, { text: project, style: "metaValue" }],
          [{ text: "Session ID", style: "metaLabel" }, { text: safeText(session.sessionId || "Unknown"), style: "metaValue" }],
          [{ text: "Created", style: "metaLabel" }, { text: formatTimestamp(session.createdAt) || "Unknown", style: "metaValue" }],
          [{ text: "Working folder", style: "metaLabel" }, { text: safeText(session.cwd || "Unknown"), style: "metaValue" }],
          [{ text: "Source", style: "metaLabel" }, { text: safeText(path.basename(session.source)), style: "metaValue" }],
        ],
      },
      layout: {
        hLineColor: () => "#E2E8F0",
        vLineColor: () => "#E2E8F0",
        hLineWidth: () => 0.5,
        vLineWidth: () => 0.5,
        paddingLeft: () => 7,
        paddingRight: () => 7,
        paddingTop: () => 5,
        paddingBottom: () => 5,
      },
      margin: [0, 10, 0, 22],
    },
    {
      columns: [
        { text: "Conversation", style: "sectionTitle" },
        {
          text: `${entryCount} transcript entr${entryCount === 1 ? "y" : "ies"}`,
          style: "count",
          alignment: "right",
        },
      ],
      margin: [0, 0, 0, 5],
    },
    {
      text: `Includes ${transcript.visibleMessages} visible message${transcript.visibleMessages === 1 ? "" : "s"}, ${transcript.reasoningEntries} recorded reasoning summar${transcript.reasoningEntries === 1 ? "y" : "ies"}, ${transcript.terminalCommands} terminal command${transcript.terminalCommands === 1 ? "" : "s"}, ${transcript.codeEdits} code edit${transcript.codeEdits === 1 ? "" : "s"}, and ${transcript.toolResults} matching result${transcript.toolResults === 1 ? "" : "s"}. Encrypted internal reasoning is not decrypted. The adjacent JSONL preserves the complete session.`,
      style: "note",
      margin: [0, 0, 0, 14],
    },
  ];

  if (transcript.messages.length === 0) {
    content.push({
      text: "No readable conversation or activity entries were recorded for this session.",
      style: "empty",
      margin: [0, 8, 0, 0],
    });
  } else {
    content.push(...transcript.messages.map((message) => messageCard(message, safeText)));
  }

  return {
    pageSize: "LETTER",
    pageMargins: [48, 48, 48, 46],
    info: {
      title,
      author: "Codex chat exporter",
      subject: `Codex chat transcript for ${project}`,
      keywords: "Codex, chat, transcript",
    },
    defaultStyle: {
      font: "Roboto",
      fontSize: 9.5,
      color: "#1E293B",
      lineHeight: 1.2,
    },
    styles: {
      eyebrow: { fontSize: 8, bold: true, color: "#2563EB", characterSpacing: 1.1 },
      title: { font: "Transcript", fontSize: 22, bold: true, color: "#0F172A", lineHeight: 1.05, margin: [0, 7, 0, 0] },
      sectionTitle: { fontSize: 13, bold: true, color: "#0F172A" },
      count: { fontSize: 8.5, color: "#64748B" },
      note: { fontSize: 8, color: "#64748B", italics: true, lineHeight: 1.2 },
      metaLabel: { fontSize: 8, bold: true, color: "#475569", fillColor: "#F8FAFC" },
      metaValue: { font: "Transcript", fontSize: 8.5, color: "#1E293B" },
      messageLabel: { fontSize: 7.5, bold: true, characterSpacing: 0.7 },
      timestamp: { fontSize: 7, color: "#64748B" },
      messageBody: { font: "Transcript", fontSize: 9.2, color: "#172033", lineHeight: 1.22 },
      reasoningBody: { font: "Transcript", fontSize: 8.8, color: "#78350F", lineHeight: 1.22, italics: true },
      activityBody: { font: "Transcript", fontSize: 8.2, color: "#172033", lineHeight: 1.18 },
      empty: { fontSize: 10, color: "#64748B", italics: true },
      messageCard: {},
    },
    pageBreakBefore: (currentNode) =>
      currentNode.style === "messageCard" && currentNode.startPosition?.verticalRatio > 0.82,
    footer: (currentPage, pageCount) => ({
      columns: [
        { text: compactFooterLabel, font: "Transcript", width: "*", noWrap: true },
        { text: `Page ${currentPage} of ${pageCount}`, width: "auto", alignment: "right" },
      ],
      font: "Roboto",
      fontSize: 7,
      color: "#94A3B8",
      margin: [48, 14, 48, 0],
    }),
    content,
  };
}

async function generateChatPdf(session, destination, existingTranscript) {
  const transcript = existingTranscript || await extractConversation(session.source);
  const { pdfmake, safeText } = configurePdfMake();
  const definition = buildDocumentDefinition(session, transcript, safeText);
  const tempDestination = `${destination}.tmp-${process.pid}-${Date.now()}`;

  try {
    await pdfmake.createPdf(definition).write(tempDestination);
    await fsp.rename(tempDestination, destination);
  } catch (error) {
    await fsp.rm(tempDestination, { force: true }).catch(() => {});
    throw error;
  }

  return {
    messages: transcript.messages.length,
    reasoningEntries: transcript.reasoningEntries,
    terminalCommands: transcript.terminalCommands,
    codeEdits: transcript.codeEdits,
    toolResults: transcript.toolResults,
  };
}

async function isUsablePdf(filePath) {
  let handle;
  try {
    handle = await fsp.open(filePath, "r");
    const header = Buffer.alloc(5);
    const { bytesRead } = await handle.read(header, 0, 5, 0);
    return bytesRead === 5 && header.toString("ascii") === "%PDF-";
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  } finally {
    await handle?.close();
  }
}

module.exports = {
  buildDocumentDefinition,
  extractConversation,
  generateChatPdf,
  isUsablePdf,
  normalizeActivityText,
  normalizeTranscriptText,
};
