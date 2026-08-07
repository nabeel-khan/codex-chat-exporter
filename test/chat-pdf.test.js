"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { extractConversation, normalizeActivityText } = require("../chat-pdf");

test("extracts reasoning, terminal commands, code edits, and matching results", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-pdf-activity-test-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const session = path.join(tempRoot, "session.jsonl");
  const records = [
    { timestamp: "2026-01-01T00:00:00Z", type: "event_msg", payload: { type: "user_message", message: "Fix it" } },
    { timestamp: "2026-01-01T00:00:01Z", type: "event_msg", payload: { type: "agent_reasoning", text: "Inspect the failing test first." } },
    { timestamp: "2026-01-01T00:00:02Z", type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "npm test" }), call_id: "terminal-1" } },
    { timestamp: "2026-01-01T00:00:03Z", type: "response_item", payload: { type: "function_call_output", call_id: "terminal-1", output: "Process exited with code 1" } },
    { timestamp: "2026-01-01T00:00:04Z", type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", input: "*** Begin Patch\n*** Update File: app.js\n@@\n-old\n+new\n*** End Patch", call_id: "edit-1" } },
    { timestamp: "2026-01-01T00:00:05Z", type: "response_item", payload: { type: "custom_tool_call_output", call_id: "edit-1", output: "Done!" } },
    { timestamp: "2026-01-01T00:00:06Z", type: "event_msg", payload: { type: "agent_message", message: "Fixed." } },
    { timestamp: "2026-01-01T00:00:07Z", type: "response_item", payload: { type: "reasoning", encrypted_content: "not-exported" } },
  ];
  await fs.writeFile(session, `${records.map(JSON.stringify).join("\n")}\n`);

  const transcript = await extractConversation(session);
  assert.equal(transcript.visibleMessages, 2);
  assert.equal(transcript.reasoningEntries, 1);
  assert.equal(transcript.terminalCommands, 1);
  assert.equal(transcript.codeEdits, 1);
  assert.equal(transcript.toolResults, 2);
  assert.deepEqual(
    transcript.messages.map((message) => message.kind),
    ["user", "reasoning", "terminal", "terminal_result", "code", "code_result", "assistant"],
  );
  assert.match(transcript.messages.find((message) => message.kind === "terminal").text, /npm test/);
  assert.match(transcript.messages.find((message) => message.kind === "code").text, /\+new/);
  assert.doesNotMatch(JSON.stringify(transcript), /not-exported/);
});

test("omits large encoded binary blobs from readable activity", () => {
  const cleaned = normalizeActivityText(`image=data:image/png;base64,${"A".repeat(1200)}`);
  assert.match(cleaned, /binary data omitted/);
  assert.ok(cleaned.length < 200);
});

test("decodes patches and text results from the exec wrapper", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-pdf-wrapper-test-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const session = path.join(tempRoot, "session.jsonl");
  const patch = "*** Begin Patch\n*** Update File: app.js\n@@\n-old\n+new\n*** End Patch";
  const wrapper = `const patch = ${JSON.stringify(patch)};\ntext(await tools.apply_patch(patch));`;
  const output = JSON.stringify([{ type: "input_text", text: "Script completed\nOutput:\nDone" }]);
  const records = [
    { timestamp: "2026-01-01T00:00:00Z", type: "response_item", payload: { type: "custom_tool_call", name: "exec", input: wrapper, call_id: "exec-1" } },
    { timestamp: "2026-01-01T00:00:01Z", type: "response_item", payload: { type: "custom_tool_call_output", call_id: "exec-1", output } },
  ];
  await fs.writeFile(session, `${records.map(JSON.stringify).join("\n")}\n`);

  const transcript = await extractConversation(session);
  assert.equal(transcript.codeEdits, 1);
  assert.equal(transcript.toolResults, 1);
  assert.equal(transcript.messages[0].text, patch);
  assert.equal(transcript.messages[1].text, "Script completed\nOutput:\nDone");
});
