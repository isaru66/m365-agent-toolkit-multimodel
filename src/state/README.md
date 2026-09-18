# Conversation state

Import `MemoryConversationStore` or `CosmosConversationStore` from `./state/index.js`.
Both implement `ConversationStore` from the shared core contracts and execute the
same transitions. Memory is an **explicit local/test mode**, not a production
fallback when Cosmos is unavailable.

```ts
const store = new CosmosConversationStore(
  cosmosClient.database(databaseId).container(containerId),
  { leaseDurationMs: 120_000 },
);
// Local only:
const localStore = new MemoryConversationStore();
```

Named exports are available from `src/state/index.ts`. The object form
`new CosmosConversationStore({ container, ...options })` is also supported.

The runtime supplies the authenticated `@azure/cosmos` 4.10.1 client/container
(for example using `@azure/identity` managed identity credentials). This layer
does not construct credentials, provision resources, log content, or call any
provider. For tests, supply `{ persistence, clock }` instead of `{ container }`;
`ConversationPersistence` exposes read/create/ETag-conditional replace.

## Storage and expiry

- Cosmos container partition key: **`/id`**. Each conversation is a single document,
  with SHA-256 id derived from the JSON tuple `[tenantId, userId, conversationId]`.
  Raw scope identifiers are not stored. Activity ids are also hashed.
- Enable container TTL. Every document has `ttl: 86400` (seconds). Cosmos TTL is
  eventual physical cleanup, relative to Cosmos's last-modified timestamp. Writes
  may postpone document cleanup; they **never extend an exchange's logical expiry**.
- Application timestamps are JavaScript Unix **milliseconds**. A successful
  completion creates an exchange with `expiresAt = createdAt + 86400000`.
  Every mutation prunes **both** histories, excluding `expiresAt <= now`, before
  returning any history from `begin`. At most the latest 20 exchanges per provider
  survive. Read-only `selection` returns only a provider, never stored content.
- Selection lives with the document: it may be forgotten after an idle document
  expires in Cosmos. Memory has no background physical TTL worker; it enforces the
  same logical history, marker, and lease expiry rules.

## Ownership and retry semantics

`begin` reserves a 120,000ms lease atomically and records a fixed-24-hour dedup
marker. Renew every **10 seconds** while generating/delivering, and abort provider
work and further delivery if `renew` returns false. Clock synchronization across
replicas is required. An expired lease cannot be renewed or completed. After a
worker disappears, another activity may acquire once its lease expires.

Only the owning non-expired lease can `complete`; call this only after successful
generation and delivery, never for truncated/failed/partial responses. `release`
does not store an exchange and preserves its activity marker. A selection change
while leased returns `busy`; no implicit provider is selected. `reset` clears both
histories and selection, increments the generation, invalidates the lease, and
preserves recent activity markers. Late completions, renewals, and releases cannot
change a newer lease.

Dedup retains the latest 256 acquired activity ids by default, each for at most
24 hours from acquisition. Completed, failed, released, reset, and expired-lease
activities all remain deduplicated while their markers survive. This is a bounded
replay window, not indefinite exactly-once processing. Busy/unselected requests
are not acquired and therefore do not consume a marker. The currently active
lease's activity is also checked even if its marker has expired.

Cosmos creates detect HTTP 409; replacements use `IfMatch` ETags and detect HTTP
412 (or 404 if TTL deleted the previously read document). Each conflict causes a
fresh read, clock sample, and transition, with five retries after the first attempt
by default. Retry exhaustion throws `ConversationConflictRetriesExceededError`.
Only read-404 is treated as absence. Authentication, throttling, transport, and
other errors propagate; there is no broad silent catch or memory fallback.

Options: `clock`, `leaseDurationMs`, `maxDedupEntries`, `maxConflictRetries`.
The Azure SDK's own configured transport retries are separate from the bounded
state-conflict retries. Conditional commits lost to a network error are not
silently retried here; runtime error handling should stop delivery and let the
lease expire if ownership cannot be established.
