# Manual HTTP checks

## ACA application checks

Open `aca.http` in VS Code with REST Client and click **Send Request** above
each request. `@acaBaseUrl` defaults to this pilot's deployed public ACA URL;
edit that nonsecret variable to test another deployment, without a trailing
slash. No `.env` settings or credentials are required for these four requests.

| Request | Expected result |
| --- | --- |
| `acaHealth` | HTTP 200 with `{"status":"healthy"}` |
| `acaReadiness` | HTTP 200 with `{"status":"ready"}` |
| `acaMissingToken` | HTTP 401 |
| `acaInvalidToken` | HTTP 401 |

These requests check the running API, readiness, and rejection of unauthenticated
traffic. They do not request model inference. A health response containing
`status=bootstrap` is not a running bot, even if its HTTP status is 200.
Readiness confirms application startup (including the Cosmos container check),
not current model availability or end-to-end Teams delivery.

Keep the invalid token deliberately invalid. **Do not substitute a provider
API key, bot client secret, Azure CLI token, or outbound Bot Framework token.**
`/api/messages` accepts inbound channel-authenticated activities; it is not an
OpenAI-compatible chat endpoint. Successful bot conversations and streaming
must be tested through Teams. Use the separate provider fixtures below for
direct inference checks. Do not disable production authentication to test ACA.
All four requests disable redirects.

## Provider API checks

These requests test Claude (including Azure), Gemini, and Azure OpenAI independently of Teams, ACA,
and Key Vault. `gemini.http` uses the application's **Gemini Developer API/key**
authentication. `gemini-vertex.http` separately preserves **project-based Vertex AI
with OAuth**. Claude and Azure OpenAI also use the application's API formats.
All requests are stateless.
They are manual checks, not part of `npm test`, and generation requests may incur
charges. No model version or credential is supplied by the repository.

## Setup

1. Use the VS Code **REST Client** extension (`humao.rest-client`, version 0.25 or
   newer). It is
   recommended by this workspace but is not installed automatically.
2. From the repository root, create the local environment file without replacing
   an existing one:

   ```powershell
   if (-not (Test-Path -LiteralPath '.env')) {
     Copy-Item -LiteralPath '.env.example' -Destination '.env'
   }
   ```

3. Enter your own API keys (or Vertex OAuth access token), explicit inference base URLs, and verified
   model/deployment names locally in the repository-root `.env`. Never paste keys into chat.
   This optional plaintext development file is separate from production Key Vault
   secrets; use it only if your organization's credential policy permits it.
4. Open the desired provider's `.http` file. Model-list requests are optional:
   listing may be unsupported on Azure Foundry even when inference works.
   REST Client resolves `{{$dotenv NAME}}` by searching the request's directory
   and then its parents for the nearest `.env`. With no nested `.env`, it uses
   the same root file as `npm run dev` and the VS Code application debugger.
5. Set `CLAUDE_MODEL` to the exact Claude deployment name/alias (it need not start
   with `claude-opus-`; verify the intended model in deployment details).
   Set `GEMINI_MODEL` to a model supporting `generateContent`, **without the
   `models/` prefix**. Set `AZURE_OPENAI_DEPLOYMENT` to the Azure deployment name,
   not a guessed catalog model name.
6. Send the generation request, then the streaming request, individually. Do not
   run all requests in a loop or automatically retry paid inference.

Do not create `tests\.env` or `tests\http\.env`: either would shadow the root file,
not merge with it. If you already have one, reconcile its values into the root
file locally before removing the duplicate. REST Client versions that support
environment-specific dotenv files may select `.env.<environment>` instead;
use **REST Client: Switch Environment** and choose **No Environment** for this
shared setup. Avoid environment-specific dotenv files in the request's parent
directories when using the shared root configuration.

The application remains in safe mock Playground mode by default. HTTP requests
do **not** honor `PROVIDER_MODE=mock`: clicking **Send Request** calls the real
provider and may incur charges. You do not need to enable live application mode
to run these independent checks. Save `.env` before sending; restart the local
application after changing its environment. `npm run dev` and the VS Code debug
configuration explicitly preload the saved root `.env` over inherited shell
values, so stale shell credentials do not override it. Production `npm start`
still uses injected environment variables and never loads this local file.

## Independent inference bases and native authentication

Use bases **without a trailing slash** in the shared root `.env`; REST Client
substitutes them literally. The app normalizes trailing slashes itself.

| File | Root dotenv base | Route appended | Authentication |
| --- | --- | --- | --- |
| `anthropic.http` | `ANTHROPIC_BASE_URL` | `/v1/messages` | `x-api-key: ANTHROPIC_API_KEY`, `anthropic-version: 2023-06-01` |
| `gemini.http` | `GEMINI_BASE_URL` | `/v1beta/models/{GEMINI_MODEL}:generateContent` or `:streamGenerateContent?alt=sse` | `x-goog-api-key: GEMINI_API_KEY` |
| `gemini-vertex.http` | `VERTEX_AI_BASE_URL` | `/v1/projects/{GOOGLE_CLOUD_PROJECT}/locations/{GOOGLE_CLOUD_LOCATION}/publishers/google/models/{GEMINI_MODEL}:generateContent` or `:streamGenerateContent?alt=sse` | `Authorization: Bearer GOOGLE_ACCESS_TOKEN` |
| `azure-openai.http` | `AZURE_OPENAI_BASE_URL` | `/chat/completions` | `api-key: AZURE_OPENAI_API_KEY` |

For the supplied Azure resource hostname, documented route-shape examples are:

```dotenv
ANTHROPIC_BASE_URL=https://aif-isaru66-mcap.services.ai.azure.com/anthropic
GEMINI_BASE_URL=https://generativelanguage.googleapis.com
VERTEX_AI_BASE_URL=https://aiplatform.googleapis.com
AZURE_OPENAI_BASE_URL=https://aif-isaru66-mcap.services.ai.azure.com/openai/v1
```

These examples do not verify reachability, keys, deployments, entitlement, or
quota. `https://aif-isaru66-mcap.services.ai.azure.com/api/projects/proj-default`
is a Foundry **project** endpoint, not inference. Do not use it as any base.
Do not append `/v1` to Claude or Vertex bases; the requests append their routes.
Azure OpenAI uses the v1 contract, not the older
`/openai/deployments/...` plus `api-version` API.

There is no gateway mode, custom-header configuration, or Entra token flow.
Each file uses only its configured base and its API's authentication contract.
The application's `ENABLED_PROVIDERS=claude` selects Claude alone;
`ENABLED_PROVIDERS=claude,gemini,azure-openai` selects all three. Absence preserves
`claude,gemini`; empty, duplicate, and unknown IDs are rejected. **Manual requests
do not honor ENABLED_PROVIDERS either:** select only the request you intend to send.

Anthropic pagination uses `has_more`, `last_id`, and the `after_id` query parameter.
If your Claude model is not on the first page, fetch subsequent pages before concluding it is
unavailable, when listing is supported. For Azure, use deployment details rather
than treating an unsupported model-list route as inference failure. A model-list
result alone does not prove generation quota or billing. Azure OpenAI has no
discovery request in these fixtures. The Vertex Gemini file also omits discovery;
use `geminiModels` in `gemini.http` for Developer API discovery instead.

## Gemini Developer API (API key)

Use `gemini.http` with `GEMINI_API_KEY`, `GEMINI_BASE_URL=https://generativelanguage.googleapis.com`,
and `GEMINI_MODEL` from the root `.env`. The key must permit the Generative
Language API, and its project must have the required API access, billing, and quota.
Send `geminiModels` first, then `geminiGenerate`, then `geminiStream`.
If listing returns `nextPageToken`, request the next page with `?pageToken=...`;
use a model supporting `generateContent`, omitting its `models/` prefix in `.env`.

An API key is sent as `x-goog-api-key`, not `Authorization: Bearer`.
Vertex's `ACCESS_TOKEN_TYPE_UNSUPPORTED` error means the supplied credential is
not a supported OAuth access token. Do not send this API key to the Vertex
project-based fixture or copy it into `GOOGLE_ACCESS_TOKEN`.

## Project-based Gemini (Vertex AI)

Add these settings to the shared root `.env`, using your example project/model:

```dotenv
VERTEX_AI_BASE_URL=https://aiplatform.googleapis.com
GOOGLE_CLOUD_PROJECT=isaru66gcp
GOOGLE_CLOUD_LOCATION=global
GEMINI_MODEL=gemini-3.8-flash
GOOGLE_ACCESS_TOKEN=
```

`GOOGLE_ACCESS_TOKEN` must contain a Google OAuth access token, **not** an AI
Studio/Gemini API key. Even though the supplied curl example names its variable
`GOOGLE_API_KEY`, the `Authorization: Bearer` flow requires an access token.
Obtain one using your authorized Google Cloud account, for example with
`gcloud auth print-access-token`, and place it locally in `.env`. Do not paste
tokens into chat or commit them. Tokens are short-lived and must be refreshed
when they expire. The caller needs access to this project, the Vertex AI API,
and the selected model; the example does not establish billing or entitlement.

`gemini-vertex.http` contains text generation, text streaming, and the supplied public
Cloud Storage image example. Streaming requests explicitly use `?alt=sse`.
`contents` is a JSON array, and image input uses the original JPEG `fileData`
URI. Model/location availability and access to the image must be valid.

**HTTP-only change:** the bot's Gemini adapter still uses `GEMINI_BASE_URL` and
`GEMINI_API_KEY` for the Gemini Developer API. Do not put a Vertex access token in
`GEMINI_API_KEY` or replace the app's base with this project endpoint. Vertex
runtime authentication and image support in the bot are not enabled by editing
this request file.

## Expected results

| Request | Check |
| --- | --- |
| Optional list models | If supported, HTTP 200 and a model list; no inference is requested |
| Anthropic generation | Nonempty text in `content`; inspect `stop_reason` and usage |
| Gemini generation | Nonempty answer text in `candidates[].content.parts[]`; inspect `finishReason`, safety feedback, and usage |
| Anthropic streaming | SSE events such as `content_block_delta`, followed by successful message completion |
| Gemini streaming | SSE `data:` chunks with candidates and a successful final finish reason |
| Azure OpenAI generation | Nonempty `choices[].message.content`; inspect `finish_reason` and usage |
| Azure OpenAI streaming | SSE `choices[].delta.content`, a successful finish reason, optional usage-only chunk, then `[DONE]` |

An HTTP 200 alone is not enough: refusal, safety blocking, an empty answer,
token-limit termination, or an in-stream error is not a completed answer.
The request caps are 256 output tokens for Claude and 2048 for Gemini and Azure
OpenAI. Azure requests use `max_completion_tokens`, explicitly disable storage
with `store: false`, and do not assume support for temperature.
Gemini thinking and Azure reasoning can consume the token budget, so a very low cap can leave no
visible answer. Inspect completion/usage before deliberately changing limits;
these caps are not monetary spending limits.

REST Client may buffer its display. Receiving provider SSE events does not prove
incremental display or Stop behavior in Teams. Cancelling the HTTP request also
does not guarantee provider computation or billing stops.

For 400 responses, check model ID, request fields, and model-specific limits.
For 401/403, check credentials, restrictions, workspace/project access, and billing.
For Gemini HTTP 402 `RESOURCE_EXHAUSTED` with "prepayment credits are depleted",
open [AI Studio projects](https://ai.studio/projects) and manage billing/prepaid
credits for the key's project. A successful model list does not establish an
available inference balance. Retry generation only after resolving billing.
For 404, check the selected model and endpoint. For 429, inspect quota/rate-limit
details and retry guidance instead of repeatedly sending requests.

## Credential handling

- Commit `.http` files and the root `.env.example` with empty credential
  placeholders, never the real root `.env`.
  The repository already ignores `.env`; ignoring a file does not encrypt it.
- Keys go in authentication headers, never URLs or JSON bodies.
- Only use synthetic, nonsensitive prompts.
- Treat request history, full-exchange previews, generated curl commands, and
  exports as sensitive because they can contain resolved credentials. Do not
  commit or share them.
- If plaintext `.env` storage is prohibited, use your approved local secret flow
  and change references to REST Client's `{{$processEnv NAME}}` instead.
- `tests` is excluded from the container build context. These files do not change
  ACA configuration or populate production secrets.

The automated `tests\http-files.test.ts` checks request structure offline and
never reads the real `.env` or calls a provider.

## References

- [REST Client variables](https://github.com/Huachao/vscode-restclient#system-variables)
- [REST Client parent-directory dotenv lookup](https://github.com/Huachao/vscode-restclient/blob/v0.25.0/src/utils/httpVariableProviders/systemVariableProvider.ts)
- [Anthropic API authentication](https://platform.claude.com/docs/en/api/overview)
- [Claude in Azure Foundry](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-claude)
- [Azure OpenAI v1 API](https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle)
- [Anthropic Messages](https://platform.claude.com/docs/en/api/messages/create)
- [Anthropic model listing](https://platform.claude.com/docs/en/api/models/list)
- [Gemini model listing](https://ai.google.dev/api/models)
- [Gemini GenerateContent and streaming](https://ai.google.dev/api/generate-content)
- [Vertex AI Gemini inference](https://cloud.google.com/vertex-ai/generative-ai/docs/model-reference/inference)
