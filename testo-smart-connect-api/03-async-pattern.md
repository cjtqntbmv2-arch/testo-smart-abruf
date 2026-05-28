---
source_url: https://developers.testo.dev/smart-connect-api/concepts/
snapshot_date: 2026-05-19
source_chunks:
  - testo-sc-concepts
---

# Async Request/Response Pattern

The data-bearing endpoints of the testo Smart Connect API are asynchronous: a
client submits a request, polls for status, and finally downloads the result
file. This page explains the pattern, the request status values, the lifetime
of the download URLs, and the polling discipline a client should follow.

For credentials and headers used on every call, see
[Authentication](02-authentication.md). For server-side filtering of the
submitted payload, see [OData Filtering](04-odata-filtering.md). For
per-endpoint paths and request bodies, see [API Reference](05-endpoints/README.md).

## Why async?

The asynchronous flow is more complex than a single request/response round
trip, but the client is **not blocked** while the backend prepares the data,
and the API can return arbitrarily large result sets. The source lists two
explicit advantages:

1. **No Time Constraints.** Processing can take as long as needed without
   concern for HTTP timeouts.
2. **Larger Data Sets.** There is no practical limit on the size of data
   returned, because results are delivered as downloadable files instead of
   in the HTTP response body.

This pattern is the right fit when any of the following applies:

- The query spans a **larger date range** that the backend cannot prepare
  inside an HTTP request budget.
- The query targets **many devices** or many measuring objects at once.
- The desired output is a **file-format payload** (`CSV`, `ORC`, `PARQUET`,
  `AVRO`, `JSON`, `TEXTFILE`) rather than an inline JSON body.

## The three-step flow: Submit, Poll, Download

The source illustrates the flow with a sequence diagram. The same flow as a
numbered prose walkthrough:

1. **Client submits the request.** The client sends a `POST` to the
   asynchronous endpoint (for example `POST /v3/devices/status`) with the
   time range, `result_file_format`, and any filter parameters in the body.
2. **API accepts and queues.** The POST endpoint hands the work off to the
   backend, which starts data preparation and immediately returns a request
   identifier.
3. **API responds with `Submitted`.** The POST endpoint replies to the client
   with status `` `Submitted` `` and a `request_uuid`. The HTTP call returns
   quickly — no preparation has happened on the response path.
4. **Client waits, then polls.** After waiting a few seconds, the client
   sends `GET /v3/devices/status/{request_uuid}` — i.e. the `request_uuid`
   travels in the **URL path** of the GET endpoint, not in the body.
5. **API reports progress.** The GET endpoint checks the backend and replies
   with `` `In Progress` ``. The client keeps polling on an interval (see
   [Polling discipline](#polling-discipline-rate-limits-and-retries) below).
6. **Backend finishes preparation.** Once the file(s) are ready, the next
   poll returns `` `Completed` `` together with one or more pre-signed
   download URLs in the response body.
7. **Client downloads the file(s).** The client fetches each URL directly
   from the backend storage (not through the API gateway) and receives the
   prepared result file.

A few details worth flagging up front:

- The POST endpoint and the GET endpoint always come as a pair — see
  "Asynchronous endpoint pair" in the [glossary](_assets/glossary.md). The
  endpoint paths for each pair are listed in [API Reference](05-endpoints/README.md).
- The `request_uuid` is the only handle the client has on its in-flight
  request. Persist it before exiting the submit step.
- The download URLs are delivered **in the `Completed` response**, not in the
  `Submitted` response.

## Request status values

The status field in the GET response takes one of the following values
(render exactly as shown, in inline code, with the spacing in
`` `In Progress` ``):

| Status          | Meaning                                                                                  |
|-----------------|------------------------------------------------------------------------------------------|
| `Submitted`     | The request has been received and queued for processing.                                 |
| `In Progress`   | The backend is actively preparing your data.                                             |
| `Completed`     | Processing is finished. Download URLs are available in the response.                     |
| `Failed`        | Terminal error status. The request did not complete and no download URLs are available.  |

The `concepts/` page documents `Submitted`, `In Progress`, and `Completed`
explicitly. `Failed` is part of the canonical status set for this
documentation set; the `concepts/` page does not describe it in detail.
`TODO: source unavailable` — the exact failure-cause shape (error code,
message field) is not specified in `concepts/`; check the OpenAPI schema in
the [API Reference](05-endpoints/README.md) for the response body of the
relevant GET endpoint.

## Download URLs

When the GET endpoint returns `` `Completed` ``, the response body contains
one or more **pre-signed download URLs** that point directly at the prepared
file(s). The client downloads each URL itself; the URL is not proxied
through the API.

**Validity window.** The `concepts/` page describes these URLs as
"temporary" and instructs clients to "download your files promptly after
receiving a `Completed` status" but does **not** state an exact lifetime in
the concepts page itself. The examples pages of the source documentation
indicate a validity window of approximately **1 hour**. Treat 1 hour as the
working assumption and download immediately on `Completed`; if you need the
file later, re-poll a fresh request rather than relying on URL freshness.
`TODO: source unavailable` — `concepts/` itself does not give a numeric
expiry.

**Multiple downloads of the same URL.** While the URL is still valid, you
may download the file multiple times. The source explicitly states:

> If you require the same data multiple times you can cache the URL and
> download the file multiple times. This avoids unnecessary API calls on
> our side.

## Deduplication

Pre-signed download URLs can be fetched more than once and the same
`request_uuid` may be re-polled. Records inside the returned files carry a
`uuid` field that uniquely identifies each record; clients that ingest the
same payload more than once (for example after a transient network failure)
should deduplicate on that record-level `uuid`. Do not confuse the
record-level `uuid` with the request-level `request_uuid` — see the
[glossary](_assets/glossary.md).

`TODO: source unavailable` — the `concepts/` page does not give an explicit
at-least-once or exactly-once guarantee statement; the recommendation to
dedupe on the record `uuid` is the safe default and matches the field's
presence in the result schemas.

## Polling discipline: rate limits and retries

### Polling cadence

The source's only quantitative guidance is: **"Wait at least a few seconds
between requests. Polling too aggressively wastes quota and adds unnecessary
load on the API."** It also says to set a maximum number of retries or a
total timeout so a stalled request cannot hang the client forever.

A practical, conservative polling loop with exponential backoff — start at
2 s, double up to a 30 s cap, give up after roughly 5 minutes of total
elapsed time. These numbers are **conservative defaults** chosen by this
documentation; the source only specifies "a few seconds" and "a maximum
number of retries or a total timeout".

```bash
#!/usr/bin/env bash
# Submit, then poll with exponential backoff capped at 30s.
REGION="eu"
BASE="https://data-api.${REGION}.smartconnect.testo.com"

resp=$(curl -sS -X POST "${BASE}/v3/devices/status" \
  -H "Content-Type: application/json" \
  -H "x-custom-api-key: your-api-key-here" \
  --data @request.json)

request_uuid=$(echo "$resp" | jq -r '.request_uuid')

delay=2          # seconds
max_delay=30
deadline=$(( $(date +%s) + 300 ))   # 5 minutes total

while :; do
  status_body=$(curl -sS \
    -H "x-custom-api-key: your-api-key-here" \
    "${BASE}/v3/devices/status/${request_uuid}")
  status=$(echo "$status_body" | jq -r '.status')

  case "$status" in
    Completed) echo "$status_body" | jq -r '.download_urls[]'; break ;;
    Failed)    echo "request failed" >&2; exit 1 ;;
  esac

  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "polling timeout" >&2
    exit 1
  fi

  sleep "$delay"
  delay=$(( delay * 2 ))
  [ "$delay" -gt "$max_delay" ] && delay=$max_delay
done
```

The Python equivalent in pseudo-code:

```python
# Conservative defaults; see note above.
delay = 2          # seconds, doubled each iteration
max_delay = 30     # cap
total_budget = 300 # 5 minutes total

uuid = submit_request(body).request_uuid
deadline = now() + total_budget

while now() < deadline:
    resp = get_status(uuid)
    if resp.status == "Completed":
        return resp.download_urls
    if resp.status == "Failed":
        raise RequestFailed(resp)
    sleep(delay)
    delay = min(delay * 2, max_delay)

raise PollingTimeout(uuid)
```

### 429 (Too Many Requests) handling

If the API returns HTTP `429`:

1. If the response carries a `Retry-After` header, **respect it** — wait
   that many seconds (or until the indicated HTTP date) before retrying.
2. Otherwise, fall back to the exponential-backoff schedule above and retry
   up to **3 times** before surfacing the error to the caller.
3. A `429` on the GET (poll) endpoint should never be treated as a request
   failure — keep the `request_uuid` and resume polling after the backoff.

`TODO: source unavailable` — the `concepts/` page does not publish
quantitative rate-limit numbers (RPS, daily quota, burst capacity), nor does
it document a `Retry-After` header explicitly. The handling above is the
standard HTTP-client convention and is safe to apply.

### Network / 5xx retries

For 5xx responses or transport-level errors during polling, retry the GET
on the next backoff tick using the same `request_uuid`. Submission (the
POST) should be retried with care: if you do not know whether the POST
reached the backend, expect that re-submitting will create a second
`request_uuid` for the same logical work and that record-level
deduplication on `uuid` will be needed downstream.

## Best practices

Distilled from the source and the patterns above:

- **Persist `request_uuid` immediately** after submit, before you do
  anything else. It is the only handle that lets you resume polling, retry
  a download, or correlate logs with a server-side request.
- **Cache the download URL while it is valid** (treat ≈ 1 hour as the
  working assumption per the examples page note). The source explicitly
  endorses re-downloading from the same URL when you need the same data
  again — it avoids unnecessary submit/poll cycles.
- **Structure the client as submit → poll → download.** Each phase is its
  own concern: submission validates the request shape, polling owns the
  retry/backoff loop, and download owns the file I/O. Mixing them produces
  clients that block on HTTP and time out.
- **Always set a polling timeout.** The source insists on a maximum number
  of retries or a total wall-clock budget so a stuck request cannot hang
  the client forever.
- **Download promptly on `Completed`.** Pre-signed URLs are temporary.
  Read the file as soon as the status flips, then cache the bytes locally
  if you need them again.
- **Deduplicate ingested records on the record-level `uuid`** so that
  retries, manual re-runs, and overlapping date ranges never duplicate
  rows downstream.
