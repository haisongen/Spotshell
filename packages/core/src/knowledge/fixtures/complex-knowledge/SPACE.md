---
schema_version: 1
id: 22222222-2222-4222-8222-222222222222
kind: knowledge
name: Release Diagnostics
description: Release safety guidance and supporting troubleshooting references.
when_to_use: Use while diagnosing a failed or degraded service release.
when_not_to_use: Do not use for database schema rollbacks.
tags:
  - release
  - diagnostics
guidance_files:
  - rules/service-safety.md
---

# Release Diagnostics

Use the supporting references only after identifying the affected service.

## Guidance

- Prefer read-only inspection before proposing a change.
- Stop when the target environment is ambiguous.

## References

- [Troubleshooting guide](references/troubleshooting.md)
