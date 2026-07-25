// useSound: React binding for the SoundManager singleton.
//
// Reads the live `sound` flag, `soundVolume`, and `soundTheme` from the shared
// settings context so the Settings controls act in real time, and installs the
// autoplay gesture-unlock exactly once for the app. Returns a stable `play`
// callback plus helpers for mapping a chess move to the right sound name.

import { useCallback, useEffect, useMemo } from 'react'
import { useSettings } from '../state/settings'
import { getSoundManager, type SoundManager, type SoundName } from './SoundManager'

export type { SoundName } from './SoundManager'

/** Minimal shape of an applied move needed to pick a sound. Compatible with
 *  `AppliedMove` from chess/chess.ts (san/capture/check). Pass it directly. */
export interface MoveSoundInput {
  san: string
  capture: boolean
  check: boolean
}

/** Pure mapping from a move to a sound name. Order: promote > castle > check
 *  (capture-with-check resolves to 'check') > capture > move. */
export function soundForMove(move: MoveSoundInput): SoundName {
  if (move.san.includes('=')) return 'promote'
  if (move.san.startsWith('O-O')) return 'castle'
  if (move.check) return 'check'
  if (move.capture) return 'capture'
  return 'move'
}

export interface UseSound {
  /** Play a named sound. No-op when sound is disabled or audio is unavailable. */
  play: (name: SoundName) => void
  /** Convenience: derive + play the sound for an applied move. */
  playMove: (move: MoveSoundInput) => void
  /** Whether sound is currently enabled (mirrors settings.sound). */
  enabled: boolean
  /** Escape hatch for non-component callers. */
  manager: SoundManager
}

export function useSound(): UseSound {
  const { settings } = useSettings()
  const enabled = settings.sound
  const manager = useMemo(() => getSoundManager(), [])

  // Keep the manager's enabled flag in sync with the live setting.
  useEffect(() => {
    manager.setEnabled(enabled)
  }, [manager, enabled])

  // Keep the master volume in sync with the live setting (the singleton also
  // seeds itself from localStorage, so pre-render sounds match).
  useEffect(() => {
    manager.setVolume(settings.soundVolume)
  }, [manager, settings.soundVolume])

  // Keep the sample pack in sync with the live setting (also seeded from
  // localStorage at construction; setTheme warms the pack's decodes).
  useEffect(() => {
    manager.setTheme(settings.soundTheme)
  }, [manager, settings.soundTheme])

  // Install the autoplay gesture-unlock once for the lifetime of the app.
  useEffect(() => {
    manager.attachGestureUnlock()
  }, [manager])

  const play = useCallback((name: SoundName) => manager.play(name), [manager])
  const playMove = useCallback((move: MoveSoundInput) => manager.play(soundForMove(move)), [manager])

  return { play, playMove, enabled, manager }
}
