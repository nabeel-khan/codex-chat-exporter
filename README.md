# Export Codex Chats

Export local Codex session history into project-organized JSONL backups and optional, readable PDF transcripts.

This is an independent community project and is not affiliated with or endorsed by OpenAI.

## Features

- Preserves each selected session as an exact JSONL copy.
- Groups sessions by working-directory project and indexed session title.
- Generates optional PDF transcripts with messages, recorded reasoning summaries, terminal activity, and code edits.
- Supports project filtering, custom source and destination paths, and dry runs.
- Avoids rewriting identical JSONL files and valid PDFs.
- Never modifies the source Codex session directory.

> [!WARNING]
> Codex sessions can contain prompts, source code, file paths, terminal output, credentials, personal data, and other sensitive information. This tool does not redact exports. Review every file before sharing it or committing it to a repository.

## Requirements

- Node.js 22 or newer
- npm
- Optional: the `sqlite3` command-line tool, used to read the newest session titles from Codex's local state database

The exporter works without `sqlite3`; it falls back to Codex's JSONL title index and then to the first user message.

## Install from source

After cloning the repository:

```bash
npm ci
```

To make the `export-codex-chats` command available from any directory, you can also run:

```bash
npm link
```

## Quick start

Preview an export without writing files:

```bash
npm run export -- --dry-run --output ./exports
```

Export all sessions as JSONL:

```bash
npm run export -- --output ./exports
```

Export JSONL and PDF transcripts:

```bash
npm run export -- --pdf --output ./exports
```

Export one project (matching is case-insensitive and exact):

```bash
npm run export -- --project my-project --pdf --output ./exports
```

If you used `npm link`, replace `npm run export -- --` in these examples with `export-codex-chats`.

## Command-line options

```text
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
  --help, -h       Show help
```

Using an explicit output directory is recommended. The repository ignores `exports/` and `sessions/`, but another destination may be tracked by Git.

## Output

```text
exports/
  Project-Name/
    Session-Title.jsonl
    Session-Title.pdf
```

Project names come from each session's working directory. Titles are resolved in this order:

1. Codex's read-only state database
2. `~/.codex/session_index.jsonl`
3. The first user message
4. An untitled-session fallback

Names are sanitized for cross-platform filesystems. When two sessions resolve to the same project and title, later files receive a short session-ID suffix.

Running the exporter again updates changed JSONL files and leaves identical files alone. Omitting `--pdf` never deletes or modifies existing PDFs. JSONL is the authoritative source record; PDFs are a readable representation and omit encrypted internal reasoning.

## Privacy and limitations

- Processing happens locally; the exporter itself does not upload session data.
- PDF output is not a redaction or sanitization boundary.
- The local Codex storage format may evolve. Please report sessions that the exporter cannot parse, using a synthetic or redacted example.
- A PDF can omit unsupported glyphs or represent them as Unicode code-point labels. The adjacent JSONL remains unchanged.

## Development

```bash
npm ci
npm test
npm pack --dry-run
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [SECURITY.md](SECURITY.md) for private vulnerability reporting.

## License

Licensed under the [MIT License](LICENSE).
