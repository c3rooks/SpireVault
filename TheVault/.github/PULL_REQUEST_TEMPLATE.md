## What changed

<!-- One or two sentences. -->

## Why

<!-- The problem, in plain English. Link to an issue if there is one. -->

## How to verify

```bash
swift test
swift build -c release
.build/release/vault doctor
.build/release/vault scan --save-dir <some-path>
.build/release/vault stats
```

## Checklist

- [ ] Tests added or updated
- [ ] CHANGELOG updated under `## [Unreleased]`
- [ ] No new dependencies introduced
- [ ] Vault still never writes to the STS2 save folder
- [ ] CSV column order unchanged (or new columns appended at the end)
