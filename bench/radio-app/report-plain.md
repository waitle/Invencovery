# Reuse report A (plain agent, no recyclewheel): React Native internet-radio app

Output of the subagent, data gathered 2026-11-04. About 6 tool calls (about 25 curl calls to npm, GitHub API and radio-browser), 0 WebSearch.

| # | Feature | Decision | Choice | License |
|---|---|---|---|---|
| 1 | Stream playback (HLS/MP3/AAC) | adopt | react-native-track-player (RNTP) | Apache-2.0 |
| 2 | Station directory | adopt the hosted service, build a thin client | Radio Browser API (radio-browser.info) | Free community API. Server code is AGPL-3.0 but not linked. |
| 3 | Background playback and lock-screen controls | adopt (same lib) | RNTP | Apache-2.0 |
| 4 | ICY now-playing | adopt, with a verification spike. Fallback: extend or build. | RNTP `MetadataReceived` event | Apache-2.0 |
| 5 | Favorites persistence | adopt | react-native-mmkv (or AsyncStorage) | MIT |

## 1 + 3. Playback, background, lock-screen: adopt react-native-track-player
- Repo: https://github.com/doublesymmetry/react-native-track-player, npm `react-native-track-player`. About 72k downloads/week, 3.7k stars.
- License: npm metadata says Apache-2.0. The GitHub API reports NOASSERTION. Apache-2.0 is compatible with an MIT app; ship the NOTICE. Read the LICENSE file before release.
- Version caveat: npm `latest` is 4.1.2 (Aug 2025). The GitHub README and a v5 tag (2026-09-30) claim New Architecture support. Not confirmed that v5 is on npm; dist-tags show only a 5.0.0-alpha nightly. Pick the version based on RN version and New Architecture.
- Rejected: expo-audio (MIT, less mature lock-screen support, judged not tested), expo-av (superseded), react-native-video (video component; fallback for ICY via `onTimedMetadata`), react-native-audio-api (synthesis API, not a streaming player).

## 2. Station directory: adopt the Radio Browser API
- https://www.radio-browser.info. Called `https://de1.api.radio-browser.info/json/stations/search?name=jazz` live; it returned JSON with `url_resolved`, `favicon`, `tags`.
- Plain `fetch` is enough. npm `radio-browser-api` (MIT, about 700 downloads/week) rejected as a dependency; useful for typings.
- Rejected: `segler-alex/radiobrowser-api-rust` (AGPL-3.0, archived). No React Native radio-browser client worth adopting was found.
- Not verified: usage terms and attribution, legal status of individual streams, URL stability.

## 4. ICY now-playing: adopt RNTP, but spike it first
- RNTP exposes `MetadataReceived`. Risk (issue titles only): iOS #2638, #2661 "MetadataReceived not firing when ICY metadata changes"; Android fix for legacy ICY punctuation (PRs #2673, #2674). All closed.
- Plan: day-one spike on real iOS and Android devices with 2-3 known ICY stations.
- Fallbacks: react-native-video `onTimedMetadata`; own ICY reader (native module needed).

## 5. Favorites: adopt react-native-mmkv
- https://github.com/mrousavy/react-native-mmkv, npm 4.3.2, MIT, about 2.4M downloads/week.
- Alternative: `@react-native-async-storage/async-storage` 3.1.1 (MIT).

## Build (own code)
Thin Radio Browser client with server rotation and User-Agent; favorites wrapper; station-to-RNTP-track glue; UI.

## Not verified
No code run, no device tests. ICY and lock-screen behavior from docs and issue titles only. Whether RNTP v5 is on npm and works with the RN version. Exact RNTP LICENSE text, Radio Browser terms, Shoutcast/TuneIn alternatives.
