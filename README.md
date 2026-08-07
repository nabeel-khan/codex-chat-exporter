# Codex Chat Exporter

Export local Codex session history into project-organized, exact JSONL records and optional Markdown, HTML, and PDF transcripts.

This is an independent community project and is not affiliated with or endorsed by OpenAI.

## Why this exists

Codex stores local sessions as detailed JSONL event logs. Those files are authoritative but inconvenient to browse, print, or hand off. Codex Chat Exporter preserves every selected JSONL file exactly while optionally creating readable, per-session Markdown, standalone HTML, and PDF transcripts beside it.

The transcript formats include visible user and Codex messages, recorded reasoning summaries, terminal commands and results, and patch/code-edit activity in chronological order.

## Features

- Preserves every selected session as an exact JSONL copy.
- Groups sessions by working-directory project and indexed session title.
- Generates optional Markdown transcripts with `--md`.
- Generates optional standalone HTML transcripts with `--html`.
- Generates optional styled PDF transcripts with `--pdf`.
- Supports every transcript format in one run with `--md --html --pdf`.
- Converts JSONL files from previous exports even when their original Codex sessions are gone.
- Supports project filtering, custom source and destination paths, and dry runs.
- Avoids rewriting identical JSONL files and usable generated transcripts.
- Never modifies the source Codex session directory.

> [!WARNING]
> Codex sessions can contain prompts, source code, file paths, terminal output, credentials, personal data, and other sensitive information. This tool does not redact exports. Review every file before sharing it or committing it to a repository.

## Requirements

- Node.js 22 or newer
- npm
- Optional: the `sqlite3` command-line tool, used to read the newest session titles from Codex's local state database

The exporter works without `sqlite3`; it falls back to Codex's JSONL title index and then to the first user message.

## Install from source

Clone the repository and install its dependency:

```bash
git clone https://github.com/nabeel-khan/codex-chat-exporter.git
cd codex-chat-exporter
npm ci
```

To make the preferred `codex-chat-export` command and the compatibility alias `export-codex-chats` available from any directory:

```bash
npm link
```

## Quick start

Preview an export without writing files:

```bash
npm run export -- --dry-run --output ./exports
```

Export exact JSONL copies only:

```bash
npm run export -- --output ./exports
```

Export JSONL and Markdown:

```bash
npm run export -- --md --output ./exports
```

Export JSONL and standalone HTML:

```bash
npm run export -- --html --output ./exports
```

Export JSONL and PDF:

```bash
npm run export -- --pdf --output ./exports
```

Export all four formats:

```bash
npm run export -- --md --html --pdf --output ./exports
```

Export one project (matching is case-insensitive and exact):

```bash
npm run export -- --project my-project --md --html --pdf --output ./exports
```

If you used `npm link`, replace `npm run export -- --` in these examples with `codex-chat-export`.

## Command-line options

```text
Usage:
  codex-chat-export [options]

Options:
  --source <path>  Session directory (default: ~/.codex/sessions)
  --index <path>   Codex title index (default: ~/.codex/session_index.jsonl)
  --state <path>   Codex state database (default: ~/.codex/state_5.sqlite)
  --output <path>  Export directory (default: current working directory)
  --project <name> Export only this project (case-insensitive exact match)
  --md             Also generate readable Markdown transcripts
  --html           Also generate standalone HTML transcripts
  --pdf            Also generate readable PDF transcripts
  --dry-run        Show what would happen without writing files
  --help, -h       Show help
```

Using an explicit output directory is recommended. The repository ignores `exports/` and `sessions/`, but another destination may be tracked by Git.

## Output

```text
exports/
  Project-Name/
    Session-Title.jsonl
    Session-Title.md   # with --md
    Session-Title.html # with --html
    Session-Title.pdf  # with --pdf
```

Project names come from each session's working directory. Titles are resolved in this order:

1. Codex's read-only state database
2. `~/.codex/session_index.jsonl`
3. The first user message
4. An untitled-session fallback

Names are sanitized for cross-platform filesystems. When two sessions resolve to the same project and title, later files receive a short session-ID suffix.

Running the exporter again updates outputs when their source JSONL changes and leaves identical JSONL files and current, usable transcripts alone. Omitting `--md`, `--html`, or `--pdf` never deletes or modifies existing transcript files. JSONL is the authoritative source record; Markdown, HTML, and PDF are readable representations and omit encrypted internal reasoning.

## Local conversion pipeline

All conversions happen from JSONL files in the local `--output` directory:

1. Current Codex session JSONL files are copied or updated in `<output>/<Project>/<Session>.jsonl`.
2. The exporter discovers JSONL files already present in that same project/title layout, including previous exports.
3. Requested Markdown, HTML, and PDF transcripts are generated beside those local JSONL files.

This means a previously exported session remains convertible after its Codex project or original session has been deleted. Reuse the directory containing the old export and request the missing format:

```bash
npm run export -- --html --output /path/to/existing-export
```

The exporter processes both current sessions and older JSONL files already in that output directory. If the Codex source directory itself no longer exists, conversion still works as long as at least one transcript format is requested and compatible JSONL exports exist under `--output`.

## Active and archived sessions

The default source is `~/.codex/sessions`, which contains active local sessions. The exporter scans one source tree per run and does not automatically combine active and archived sessions.

To export archived sessions separately, provide Codex's archived-session directory explicitly:

```bash
npm run export -- --source ~/.codex/archived_sessions --md --output ./archived-exports
```

## Scope and limitations

- Processing happens locally; the exporter itself does not upload session data or send telemetry.
- Markdown, HTML, and PDF output are not redaction or sanitization boundaries.
- The exporter does not download cloud-only Codex tasks or ordinary ChatGPT web conversations.
- It does not import sessions into Codex, recreate Codex UI state, or modify the originals.
- HTML output is a standalone transcript with no scripts or external assets; the exporter does not create an aggregate HTML index, searchable archive, or machine-readable manifest.
- It notes image attachments but does not extract them into separate files.
- The local Codex storage format may evolve. Please report sessions that cannot be parsed using a synthetic or redacted example.
- A PDF can omit unsupported glyphs or represent them as Unicode code-point labels. The adjacent JSONL remains unchanged.

## Related projects

This project focuses on exact JSONL preservation and individual Markdown, HTML, or PDF transcripts organized by readable project and session titles.

For a self-contained migration archive with combined active/archived discovery, a local HTML metadata index, a manifest, and short archive paths, see [Codex Project Chat Exporter](https://github.com/Ann-Diana/codex-project-chat-exporter).

## Development

```bash
npm ci
npm test
npm pack --dry-run
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [SECURITY.md](SECURITY.md) for private vulnerability reporting.

## License

Licensed under the [MIT License](LICENSE).
