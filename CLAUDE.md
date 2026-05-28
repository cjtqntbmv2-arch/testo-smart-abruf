# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Documentation-only repository: a curated, AI-readable snapshot of the **testo Smart Connect API** docs, structured so an agent can answer questions about the API without re-fetching upstream. No source code, no build / lint / test tooling. The single subdirectory `testo-smart-connect-api/` holds everything.

## Start here

For any task about the API itself (endpoints, async pattern, authentication, OData, schemas, limit values, migration from Saveris 2), read [testo-smart-connect-api/CLAUDE.md](testo-smart-connect-api/CLAUDE.md) first — it is the documentation index and routes to the right file. Do not duplicate its content here.

## Editing safety rails

- Every `.md` file (except the inner index and `_assets/glossary.md`) carries YAML frontmatter with `source_url`, `snapshot_date`, and `source_chunks`. This frontmatter is load-bearing for re-snapshotting — preserve it on every edit. Mechanics are described in the inner index's "How this directory was built" section.
- [testo-smart-connect-api/_assets/glossary.md](testo-smart-connect-api/_assets/glossary.md) is the single source of truth for terminology (endpoint names, async status enum, header casing). A cross-consistency reviewer greps for violations — match its spellings exactly.
- **Do not invent** endpoint paths, status enum values, header names, or schema fields. If a fact is not in an existing snapshot file with a `source_chunks` reference, re-fetch from upstream rather than writing it from memory.
