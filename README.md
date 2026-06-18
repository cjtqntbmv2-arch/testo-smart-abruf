# testo Smart Connect API Documentation Snapshot

[![Version](https://img.shields.io/badge/version-0.5.0-blue.svg)](VERSION)
[![API Version](https://img.shields.io/badge/api-v3-orange.svg)](testo-smart-connect-api/CLAUDE.md)

A curated, AI-readable offline snapshot of the official **testo Smart Connect API** documentation.

This repository serves as a localized, high-fidelity knowledge source. It enables AI coding assistants, agents, and developers to query, understand, and integrate with the testo Smart Connect API without having to fetch the documentation from upstream endpoints repeatedly.

## 📂 Repository Structure

- [CLAUDE.md](CLAUDE.md) — Root index and repository guidelines.
- [testo-smart-connect-api/](testo-smart-connect-api/) — The core documentation directory.
  - [CLAUDE.md](testo-smart-connect-api/CLAUDE.md) — Documentation index routing to specific resources.
  - `01-overview.md` to `09-limit-values.md` — Topic-focused documentation files.
  - `_assets/` — Shared resources including the OpenAPI spec (`openapi.json`) and the glossary (`glossary.md`).

## 🚀 Key API Concepts at a Glance

1. **Base URL**: `https://data-api.<region>.smartconnect.testo.com` where `<region>` is `eu`, `am`, or `ap`.
2. **Authentication**: Uses the custom header `x-custom-api-key`.
3. **Async Pattern**: All data retrieval endpoints follow a POST-poll-GET-download pattern:
   - `POST /v.../resource` to submit a data request.
   - `GET /v.../resource/{request_uuid}` to poll for completion.
   - Download the generated file (CSV, JSON, PARQUET, etc.) once the state is `Completed`.

## 🛠 Usage & Updates

Each snapshot file maintains its original `source_url` and `snapshot_date` in its YAML frontmatter. This metadata allows automated tools or subagents to check for upstream updates and safely refresh the local documentation snapshots while preserving terminology consistency defined in the [Glossary](testo-smart-connect-api/_assets/glossary.md).
