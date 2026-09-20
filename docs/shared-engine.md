# One repair engine, two execution locations

`src/engine/index.ts` is the public entry point for the internal TypeScript library. Both the native server and browser worker import it. Matching, speech normalization, history indexes, directory traversal, validation policy, help-tree discovery and learned metadata have one implementation. The library's types live inside `src/engine`; it imports no Node, browser, network or terminal APIs.

The default remains server execution: `npm start` or `npm run dev`. Use `TERMAI_ENGINE=client npm start` (or `npm run dev`) for the previous experimental execution path. This setting chooses where the same library runs; it does not change its matching policy. The WebSocket hello message announces the choice to the frontend, without an additional request.

## Adapters

- `server/suggestions.ts` supplies the native host and delegates to the library. `server/discovery.ts` supplies native help/script facts and probe-pool capacity. The small server validation/path modules are compatibility exports, not separate algorithms.
- `src/suggestion-worker.ts` uses the same public entry point with `RemoteHost`, preserving fact batching, context prefetch, directory freshness checks and retries.
- Each `Discovery` instance owns a session's learned metadata. `forHost()` binds operations to a particular repair, so overlapping work cannot accidentally pick up another request's host or cancellation signal.
- Terminal edits and execution remain outside the library. Host adapters obtain facts; the engine decides how to interpret and rank them.

Native execution calls the filesystem and subprocess providers directly. It does not serialize intermediate facts, start a browser repair worker or push periodic catalogs. Prompt-time metadata prewarming is retained. Native discovery uses routes already verified by the engine instead of rewalking every help ancestor as an HTTP boundary must. File-operand validation requests metadata without an extra executable-access check, preserving master's original I/O behavior.

Client execution retains its existing transport and cache strategy. Native-only prewarming is not enabled in this mode. Remote help requests still receive independent route verification at the server boundary.

## Validation and performance

The shared-engine benchmark compares the optimized pre-change commits (`ead84d9` master and `bfa4362` experiment) against both execution modes in the new source. It checks complete candidate arrays and rejects increases in cold or warm foreground request counts for any case.

Run `BENCH_SUITE=shared npm run bench:architecture`. By default, the after variants use a copied snapshot of the working tree; set `BENCH_AFTER` to a commit for a reproducible revision. `BENCH_RTT`, `BENCH_REPEATS` and `BENCH_OUTPUT` control the measurement. The original four-way architecture benchmark remains available without `BENCH_SUITE`.

Run `npm test` and `npm run build`, then `TEST_ENGINE=server npm run test:browser` and `TEST_ENGINE=client npm run test:browser`. `TEST_BASE_PATH=/t` checks a mounted deployment. Server browser checks reject worker creation, fact requests and context pushes. Client browser checks require one warm directory request containing freshness validation.

This work consolidates the library and its two existing execution paths. SSH access and a frontend connecting to multiple backends are separate future work.
