# Reuse report A (plain agent, no recyclewheel), re-run 2026-11-05

Output of the subagent (WebSearch, WebFetch, Bash with curl and npm tarballs). The harness refused the subagent's file
write, so the report came back as its final message and was saved here unchanged in substance.
Harness usage: 43 tool calls, about 118k subagent tokens, about 421 s.
Agent's own count: 4 WebSearch, 9 WebFetch (4 failed: rntp.dev, www.rntp.dev, docs.radio-browser.info and
www.radio-browser.info did not resolve), 27 Bash, 3 other. It reported the GitHub REST API answering 403 to its
calls, and the Radio Browser API hosts and jitpack.io as unreachable through the proxy.

| Feature | Decision | Choice (pin) | License |
|---|---|---|---|
| 1. Live stream playback (HLS/MP3/AAC) | adopt | `expo-audio@58.0.11` (Expo SDK 58, RN 0.88.1), expo modules installed in bare RN | MIT (checked in the tarball); Media3 (Apache-2.0) on Android, AVPlayer on iOS |
| 2. Station directory | adopt (hosted service + client) | Radio Browser public API + `radio-browser-api@6.0.3` | client MIT; server software AGPL-3.0 (not shipped); data said to be public domain, not verified |
| 3. Background playback + lock-screen/notification | adopt | `expo-audio@58.0.11` (`enableBackgroundPlayback`, `setActiveForLockScreen(..., {isLiveStream:true})`, `updateLockScreenMetadata`) | MIT |
| 4. ICY StreamTitle | extend | patch-package on `expo-audio@58.0.11`: forward Media3 `IcyInfo` (Android) and `AVPlayerItemMetadataOutput` `icy/StreamTitle` (iOS) to JS; offer upstream. RNTP v4 `MetadataAdapter` and `icecast-metadata-js` reference only | patch MIT; references Apache-2.0 and LGPL-3.0-or-later, not copied |
| 5. Local favorites | build (small repository layer) on an adopted store | `expo-sqlite@58.0.15`, `expo-sqlite/kv-store` | MIT; SQLite public domain |

## Key license finding: react-native-track-player

- `react-native-track-player@4.1.2` (npm `latest`, 2025-08-12) is Apache-2.0; the tarball has the Apache LICENSE.
- The default branch `main` (V5) has a proprietary `license.txt`: "Free for non-commercial use ... Any use that does not
  strictly and entirely qualify as Personal Use or Educational Use requires a commercial license, including any use
  within a for-profit company, non-profit organization, or government entity."
- V5 ships as `@rntp/player@5.13.0` (`"license": "SEE LICENSE IN <license.txt>"`, same text).
- The vendor says V4 is frozen on the `v4` branch.
- The nightly `react-native-track-player@5.0.0-alpha0-nightly-...` (2025-09) still declares Apache-2.0; an orphaned
  pre-release, do not use.

## 1. Live stream playback: adopt expo-audio@58.0.11

Why: audio-first player maintained by Expo, 58.0.11 published 2026-10-31, New Architecture. Android uses Media3
(`AudioModule.kt` maps `CONTENT_TYPE_HLS` to `HlsMediaSource`), iOS uses AVPlayer. MIT. Covers features 1 and 3. Bare RN
needs `npx install-expo-modules`.

Rejected:
- `react-native-track-player@4.1.2` (Apache-2.0): has ICY support (`MetadataAdapter.kt`), but is frozen, uses legacy
  `com.google.android.exoplayer2` through `kotlinaudio` from JitPack and `SwiftAudioEx 1.1.0`, and is a legacy bridge
  module while RN >= 0.82 is New Architecture only (bridgeless crash in issue #2293 on RN 0.74; no evidence for 0.88).
  Kept as fallback.
- `@rntp/player@5.13.0`: best technical fit, commercial license; search results report EUR 999/year per app (unverified).
- `react-native-video@6.19.3` (MIT; v7 beta also MIT): video component; Android `onMetadata` logs `IcyInfo` as
  unhandled. Second-best option.
- `react-native-audio-pro@10.1.3` (MIT): README documents static remote files only.
- `expo-av@16.0.8`: superseded by expo-audio.

Risks: versions tied to the Expo SDK cadence; the config plugin adds microphone permissions by default (set
`microphonePermission: false`, `recordAudioAndroid: false`); plain-HTTP streams need ATS and cleartext exceptions;
reconnect after network loss untested.
Not verified: HE-AAC v2 and HLS-ID3 on devices; automatic retry.

## 2. Station directory: adopt Radio Browser API + radio-browser-api@6.0.3

Why: free, community-run, no key; search by name, tag, country, codec, `hidebroken`, `url_resolved`, mirrors at
`all.api.radio-browser.info/json/servers`. Client has no dependencies, uses fetch, TypeScript types, server discovery;
last published 2025-05-06 (pin or vendor).
Rejected: TuneIn (partner agreement), SHOUTcast directory (developer key, own terms), dir.xiph.org (Icecast only),
own catalogue (cost). TuneIn and SHOUTcast terms not re-read.
Risks: no SLA (cache, mirror failover), data quality varies, a listing gives no rights to the streams, send a
descriptive User-Agent, click and vote endpoints send the user's IP.
Not verified: data license (only quoted in a forum post), `segler-alex/radiobrowser-api-rust` AGPL-3.0 (relevant only
when self-hosting a modified server), current rate limits and terms.

## 3. Background playback and lock-screen controls: adopt expo-audio@58.0.11

Why: the plugin adds `UIBackgroundModes: audio`, `FOREGROUND_SERVICE_MEDIA_PLAYBACK` and a `mediaPlayback` service;
`isLiveStream` hides the scrubber (`MPNowPlayingInfoPropertyIsLiveStream`); `updateLockScreenMetadata()` can push the ICY
title. On Android, lock-screen controls must be active or background playback stops after about 3 minutes.
Rejected: RNTP and react-native-video (see 1); `react-native-music-control@1.4.1` (2022, no license field).
Risks: Play Console foreground-service declaration; `POST_NOTIFICATIONS` on Android 13+; audio focus, calls, Bluetooth,
headset unplug.
Not verified: CarPlay / Android Auto, AVRCP, OEM battery killers.

## 4. ICY now-playing metadata: extend expo-audio with a patch

Why: Media3 sends `Icy-MetaData: 1` and emits `IcyInfo`; AVPlayer exposes `icyMetadataStreamTitle`. expo-audio 58.0.11
forwards none of it. The patch is small (Android `IcyInfo` plus ID3 TIT2/TPE1 for HLS, iOS metadata output, JS split of
"Artist - Title"); carry it with patch-package and offer it upstream. RNTP v4 and icecast-metadata-js as reference only.
Rejected: `icecast-metadata-js@1.2.9` / `icecast-metadata-player@1.17.13` (LGPL-3.0-or-later, browser-oriented, second
connection); `@music-metadata/icy@0.2.1` (MIT, needs streaming fetch, second connection); polling
`status-json.xsl` / `/currentsong` (server-specific); switching to RNTP v4 for ICY only.
Risks: patch re-test per SDK; missing or Latin-1 ICY; timing drift; HLS uses ID3 or DATERANGE.
Not verified: ICY through expo-audio's OkHttp path; AVPlayer ICY for AAC/ADTS. Device test against 5-10 stations first.

## 5. Local favorites: build on expo-sqlite@58.0.15 (kv-store)

Why: about 50 lines (UUIDs plus a snapshot, schema version); expo-sqlite is MIT with a LICENSE file, already in the Expo
module graph, kv-store is AsyncStorage-compatible.
Rejected: `@react-native-async-storage/async-storage@3.1.1` (prebuilt xcframework, no LICENSE in the tarball, API
change); `react-native-mmkv@4.3.2` (more than needed, nitro peer, no LICENSE in the tarball); cloud backend (accounts,
GDPR).
Risks: directory UUIDs can disappear (keep the snapshot); keep SQLCipher off.
Not verified: backup and restore behaviour.

## Cross-cutting risks

- Cost: all free; hidden cost is the ICY patch and maybe a directory cache; developer accounts (not re-checked);
  RNTP V5 about EUR 999/year (unverified).
- App store policy: Apple 5.2.2 (authorization to use third-party services), 5.2.3 (streaming may violate terms: no
  recording, public streams only, takedown process), 4.2/4.3 (thin wrappers), 2.5.4 (background audio allowed); Google
  Play foreground-service declaration, IP and impersonation policy for logos, Data safety form; remove default
  microphone permissions.
- Privacy (US, EU): every stream request sends IP and User-Agent to stations and Radio Browser (personal data under
  GDPR); privacy policy and store labels; click/vote opt-in; favorites on device; no ads or analytics at first (ATT,
  ePrivacy/GDPR consent, CCPA/CPRA); check PrivacyInfo.xcprivacy per dependency.
- Operations: no backend; cache, mirror failover, built-in fallback list; monitor crashes and ANRs; pin versions and
  re-validate the patch per SDK.
- Security: `NSAllowsArbitraryLoadsForMedia` instead of global ATS; narrow network-security-config; treat directory data
  and ICY strings as untrusted; lockfile with integrity; JitPack is a supply-chain risk.
