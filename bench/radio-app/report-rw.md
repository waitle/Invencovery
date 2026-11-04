# Reuse report B (recyclewheel workflow): React Native internet-radio app

Output of the subagent. Project: MIT, app-store application, npm. Target markets US and EU (from the task). Not legal advice.
About 45 tool calls by the agent's own count (the harness counted 28): about 22 Bash calls to the rw wrapper, 10 WebSearch, 4 WebFetch. Ledger: [ledger.rw.jsonl](ledger.rw.jsonl).

| Component | Decision | Choice | License | Evidence |
|---|---|---|---|---|
| 1. Stream playback, background, lock-screen | adopt | `npm:react-native-track-player@4.1.2`, pinned to 4.x | Apache-2.0 (v4 line) | dec_2a8d6c7f2ae8 |
| 2. Station directory | extend | `github:ivandotv/radio-browser-api` (npm 6.0.3) over the free api.radio-browser.info | MIT | dec_61816f4dbfdb |
| 3. ICY now-playing | adopt | same player, native ICY/ID3 metadata events | Apache-2.0 | dec_868035c6ce4b |
| 4. Favorites | adopt | `npm:react-native-mmkv@4.3.2` | MIT | dec_4ec05b4c8372 |
| Glue | build (trivial / integration_glue) | own code | MIT | not registered |

## 1. Playback, background, lock screen: adopt react-native-track-player 4.1.2
- Scored 84/100, fit 4. `npm view` confirms latest 4.1.2, Apache-2.0.
- Key finding: GitHub `main` is V5 (package `@rntp/player`), commercially licensed. Only v4 stays Apache-2.0. Pin 4.x exactly; do not follow `main`, `next` or `nightly`.
- Rejected: `github:radio-garden/react-native-audio-browser` (MIT, 71/100, README says Alpha; fallback), RNTP `main` (V5 commercial), `rmotafreitas/react-native-anything-player` (PolyForm Noncommercial), `react-native-audio-api` (low-level engine).
- Unverified: v4 last released 2025-08-12; RN version compatibility; live HLS needs `isLive` on Android; `metrics_partial` flag set.

## 2. Station directory: extend radio-browser-api with a thin adapter
- MIT, TypeScript, fetch-based. Scored 55/100, fit 4, `stale` flag (last activity 2025-05). Radio Browser docs allow use in free and non-free software.
- Adapter must send a descriptive User-Agent, do `/json/servers` discovery with randomized failover, and report station clicks.
- Rejected: `radiobrowser-api-client` (Apache-2.0, about 11 weekly downloads), `radio-browser` (stale since 2023).
- Unverified: React Native compatibility; the wrapper's server-selection behavior.

## 3. ICY now-playing: adopt, same player package
- v4 emits `Audio*MetadataReceived`; old `PlaybackMetadataReceived` is deprecated.
- Rejected: `icecast-metadata-js` (LGPL-3.0), `@music-metadata/icy` (MIT, fit 2, double stream fetch), `icy` (Node, 2015), radio-garden library (alpha).
- Risk, unverified: on v4 Android the event reportedly fired only at startup on continuous streams (#2149, #2638); fixes shipped in v5.1.x (commercial). Test on a device with real Icecast and Shoutcast streams.

## 4. Favorites: adopt react-native-mmkv 4.3.2
- MIT, 94/100, fit 5, about 2.4M weekly downloads. v4 needs `react-native-nitro-modules` and a New-Architecture-era RN. CVE-2024-21668 fixed in 2.11.0; not affecting 4.x.
- Fallback: `@react-native-async-storage/async-storage` (MIT, 80/100).

## Cross-cutting checks
- **cost**: all chosen code free; Radio Browser API free with no documented rate limit.
- **distribution_policy**: Android 14+ needs foreground service type `mediaPlayback`; plain `http://` streams need an iOS ATS exception and an Android cleartext config; an Apple developer-forum thread reports a radio app on radio-browser.info rejected under Guideline 5.2.3 (Legal), so an unfiltered directory is a store-review risk.
- **legal_privacy (EU, US)**: Radio Browser sees the user's IP and search terms; a privacy policy naming recipients is expected. COPPA/CCPA likely out of scope. Retransmission legality needs a lawyer.
- **operations**: community-run directory, no SLA; stream URLs rot, so error handling and failover are needed.
- **security**: RNTP 4.1.2 has no Snyk findings; ICY titles and station names are untrusted input.

## Problems with the tooling (reported by the agent)
1. The default npm query failed for 3 of 4 components ("npm registry search request failed"); short explicit queries worked. Cost one search round per component. Not reproducible later.
2. Multi-keyword default queries returned few or no GitHub hits.
3. `rw_evaluate` required `service_ref` or `no_service_reason` on SDK-like candidates.
4. `rw_decide` for `extend` warned that attribution is recommended.
5. The `rw_search` structuredContent block was very large (caused by the first wrapper; see README).
6. One hint (`extend radiobrowser-api-client`, 57) was overridden by the agent's decision (55, fit 4).
