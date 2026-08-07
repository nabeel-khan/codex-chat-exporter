# Contributing

Thanks for helping improve Codex Chat Exporter.

## Before opening an issue

- Search existing issues for the same behavior or proposal.
- Do not attach real session exports unless you have carefully redacted them.
- Report security vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

Bug reports are most useful when they include the operating system, Node.js version, command used, expected behavior, actual behavior, and a minimal synthetic JSONL example when parsing is involved.

## Local development

Requirements:

- Node.js 22 or newer
- npm

Set up and verify the project:

```bash
npm ci
npm test
npm pack --dry-run
```

The project uses CommonJS and Node's built-in test runner. Keep changes focused, preserve the exact-copy guarantee for JSONL exports, and add or update tests for observable behavior.

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Make a focused change with tests and documentation where appropriate.
3. Run the verification commands above.
4. Confirm that no session exports, credentials, personal data, or generated PDFs are included.
5. Open a pull request explaining the problem, the approach, and any compatibility or privacy implications.

By contributing, you agree that your contributions are licensed under the repository's MIT License.
