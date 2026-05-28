---
source_url: https://developers.testo.dev/smart-connect-api/auth_and_security/
snapshot_date: 2026-05-19
source_chunks:
  - testo-smart-connect-api-auth::https://developers.testo.dev/smart-connect-api/auth_and_security/
---

# Authentication

The Smart Connect API uses **API key authentication**. To access any
endpoint, you first generate an API key through the **API Key
Management** section of the Smart Connect web UI and then include it in
the header of every request.

## Generating an API key

Follow these steps to create a new API key:

1. Open the Smart Connect home page at
   `https://data-api.<region>.smartconnect.testo.com` (replace
   `<region>` with `eu`, `am`, or `ap`).
2. Click your **email address** in the top-right corner of the home
   page.
3. In the user-email dropdown menu, click **API Key Management**.

   > **Note:** If the API Key Management section is not displayed, you
   > first need to purchase the corresponding add-on via the
   > **Subscription Portal**. Once done, the section will become visible
   > in your Smart Connect home page.
4. In the **Key Name** field, enter a descriptive name for your key
   (for example, `Production API Key`). Select an expiration period from
   the dropdown menu. The **maximum expiration period is one year**.
5. Click the **+ Generate** button to create the API key.
6. The newly created API key is shown in a yellowish-orange box. Click
   the **Copy** button and store the key in a secure location — it is
   **only shown once**.
7. Once you have safely stored the key, click **"Got it, key has been
   saved"** to confirm.
8. In your API client, replace any old `Authorization: Bearer ...`
   header with `x-custom-api-key: <your_key>`.

### Key expiration and renewal

API keys have a limited lifetime based on the expiration period chosen
at generation time; the maximum is one year. Generate a replacement key
from API Key Management **before** the current one expires — once a key
expires, any request using it is rejected.

## Using the API key

Send the key in the `x-custom-api-key` header on every request.
Requests without a valid `x-custom-api-key` header are rejected with
`401 Unauthorized`.

The header looks like this:

```http
POST /v3/devices/properties HTTP/1.1
Host: data-api.<region>.smartconnect.testo.com
Content-Type: application/json
x-custom-api-key: your-api-key-here
```

Full curl example:

```bash
curl -X POST 'https://data-api.<region>.smartconnect.testo.com/v3/devices/properties' \
  -H 'Content-Type: application/json' \
  -H 'x-custom-api-key: your-api-key-here' \
  -d '{}'
```

## Security best practices

The following practices are recommended for handling Smart Connect API
keys:

- **Store keys securely.** Never expose API keys in client-side code,
  public repositories, or shared documents. Prefer environment variables
  or a dedicated secret manager.
- **Rotate keys periodically.** Even before expiration, rotate your keys
  regularly as a security measure.
- **Use separate keys per environment.** Generate distinct API keys for
  development, staging, and production environments so a single key
  compromise has a limited blast radius and individual keys can be
  revoked independently.
- **Revoke unused keys.** If an API key is no longer needed, revoke it
  to reduce the risk of unauthorized access.

## Authentication flow

The end-to-end flow has two phases:

1. **API key generation (one-time setup).** The customer opens the
   Smart Connect home page, navigates to **API Key Management**, enters
   a key name and expiration period, and clicks **+ Generate**. Smart
   Connect displays the API key once; the customer copies it and stores
   it securely.
2. **Using the API key.** For every API request, the client sends the
   key in the `x-custom-api-key` header. The Smart Connect API
   validates the key and returns the response data.

## What next

- See [Concepts](03-async-pattern.md) for the asynchronous request
  pattern used by most endpoints.
- See [OData Filtering](04-odata-filtering.md) for how to constrain
  result sets with `$filter`, `$select`, and `$orderby`.
- See the [API Reference](05-endpoints/README.md) for endpoint details.
