# Sound assets

This directory is intentionally **empty of audio files**.

The app's `SoundManager` (`src/renderer/src/sound/SoundManager.ts`) **synthesizes**
all sound effects at runtime with the WebAudio API. This was a deliberate choice:

- **Fully offline.** No network fetch, no bundled binary, nothing to ship.
- **No licensing ambiguity.** Procedurally generated tones carry no third-party
  rights, so there is zero risk from an uncertain CC0 pack provenance.
- **Tiny + themeable.** Each effect is a short oscillator "recipe" tuned to read
  as an understated UI tick rather than a musical note.

## Optionally using real samples (CC0) later

If you want to ship recorded samples instead of (or in addition to) the synth:

1. Drop CC0-licensed files here, e.g. `move.ogg`, `capture.ogg`, `check.ogg`,
   `castle.ogg`, `promote.ogg`, `game-start.ogg`, `game-end.ogg`, `low-time.ogg`.
   Good public-domain sources: Lichess `lila` sound assets (CC0) and the
   freesound.org CC0 pool. Verify each file's license before committing.
2. Map names to URLs in `samplePaths` inside `SoundManager.ts`. With Vite you can
   `import moveUrl from '@/../resources/assets/sound/move.ogg?url'` (or place the
   files under a `public/` dir and reference by path).
3. The manager will prefer a decoded sample when present and **fall back to the
   synth** automatically if a sample is missing or fails to decode, so partial
   coverage is fine.

No code change beyond populating `samplePaths` is required.
