# EXP-002: history polling measurement

The bridge now reuses converted history when the Desktop owner and snapshot revision remain unchanged. It still asks Desktop for a complete snapshot on every read. This change does not eliminate upstream IPC transfer or JSON parsing.

The cache is limited to eight targets and a shared 16 MiB serialized-snapshot budget. A revision change, owner replacement, verified first-message change, or failed read invalidates reuse. Reconnection rebuilds from the complete snapshot. Missing owner or revision evidence disables reuse. Requests and receipt reconciliation still run on every poll.

## Reproduce

```sh
BENCH_CACHE=0 node --import tsx scripts/benchmark-conversations.mjs /tmp/history-before.json
node --import tsx scripts/benchmark-conversations.mjs /tmp/history-after.json
```

`BENCH_TURNS` and `BENCH_ITERATIONS` set the workload. The defaults are 2,000 completed turns and 15 unchanged reads. The script uses generated text, performs no Codex writes, and deletes its temporary receipt directory. It checks unchanged history, an added turn, and replacement-owner recovery. Loopback HTTP needs permission to bind a temporary local port.

## Recorded sample

The [before sample](benchmarks/history-before.json) and [after sample](benchmarks/history-after.json) used the same workload on Node 26.10.0. The full snapshot contained 5,050,598 bytes. The 50-message response contained 47,865 bytes.

| Measurement | Cache disabled | Cache enabled |
| --- | ---: | ---: |
| Upstream reads | 15 | 15 |
| Projection cache hits | 0 | 15 |
| Mean measured conversion | 19.885 ms | 0 ms |
| Median service read plus response serialization | 24.180 ms | 9.155 ms |
| Median loopback response transfer | 0.859 ms | 0.802 ms |
| Changed snapshot | 20.673 ms | 19.664 ms |
| Restart and owner replacement | 19.373 ms | 25.577 ms |

These are synthetic local measurements from one run. Concurrent machine load affected timings. The unchanged conversion count establishes the avoided work. The timings do not establish LAN, Tailscale, actual Desktop IPC, or iPad rendering performance. New revisions still require conversion and cache accounting. The sample does not justify a latency guarantee.

The conversation tests separately cover appended history, reused revision under a different owner, failed reads followed by resynchronization, and first-message receipt projection. No event stream or incremental-only persistence was introduced.
