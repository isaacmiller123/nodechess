import { ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  Api,
  DatasetProgress,
  EngineBestmove,
  EngineLine,
  ReviewProgress,
  UpdateStatus
} from '@shared/types'

// The single typed surface exposed to the renderer. Mirrors the IPC channels in
// src/main/ipc/*. Raw ipcRenderer is NEVER exposed.
export const api: Api = {
  app: {
    ping: () => ipcRenderer.invoke('app:ping', {}),
    dataVersion: () => ipcRenderer.invoke('app:dataVersion', {}),
    resetProgress: (req) => ipcRenderer.invoke('app:resetProgress', req)
  },
  settings: {
    get: (key) => ipcRenderer.invoke('settings:get', { key }),
    set: (key, value) => ipcRenderer.invoke('settings:set', { key, value })
  },
  engine: {
    analyze: (req) => ipcRenderer.invoke('engine:analyze', req),
    stop: (handleId) => ipcRenderer.invoke('engine:stop', { handleId }),
    play: (req) => ipcRenderer.invoke('engine:play', req),
    playVariant: (req) => ipcRenderer.invoke('engine:playVariant', req),
    playGo: (req) => ipcRenderer.invoke('engine:playGo', req),
    evalVariant: (req) => ipcRenderer.invoke('engine:evalVariant', req),
    estimateGo: (req) => ipcRenderer.invoke('engine:estimateGo', req),
    status: () => ipcRenderer.invoke('engine:status', {}),
    newGame: (instance) => ipcRenderer.invoke('engine:newGame', { instance }),
    onLine: (cb) => {
      const listener = (_e: IpcRendererEvent, data: EngineLine) => cb(data)
      ipcRenderer.on('engine:line', listener)
      return () => ipcRenderer.removeListener('engine:line', listener)
    },
    onBestmove: (cb) => {
      const listener = (_e: IpcRendererEvent, data: EngineBestmove) => cb(data)
      ipcRenderer.on('engine:bestmove', listener)
      return () => ipcRenderer.removeListener('engine:bestmove', listener)
    }
  },
  puzzles: {
    next: (req) => ipcRenderer.invoke('puzzles:next', req),
    get: (puzzleId) => ipcRenderer.invoke('puzzles:get', { puzzleId }),
    themes: () => ipcRenderer.invoke('puzzles:themes', {}),
    count: () => ipcRenderer.invoke('puzzles:count', {}),
    attempt: (req) => ipcRenderer.invoke('puzzles:attempt', req),
    // Slice A/B: bulk fetch.
    batch: (req) => ipcRenderer.invoke('puzzles:batch', req),
    // Slice B: Rush / Storm.
    saveRush: (req) => ipcRenderer.invoke('puzzles:saveRush', req),
    rushRuns: (req) => ipcRenderer.invoke('puzzles:rushRuns', req ?? {}),
    rushBests: () => ipcRenderer.invoke('puzzles:rushBests', {}),
    // Slice C: Daily + stats/history.
    daily: (req) => ipcRenderer.invoke('puzzles:daily', req ?? {}),
    recordDaily: (req) => ipcRenderer.invoke('puzzles:recordDaily', req),
    dailyStreak: () => ipcRenderer.invoke('puzzles:dailyStreak', {}),
    stats: () => ipcRenderer.invoke('puzzles:stats', {}),
    history: (req) => ipcRenderer.invoke('puzzles:history', req ?? {})
  },
  ratings: {
    get: (kind) => ipcRenderer.invoke('ratings:get', { kind })
  },
  progress: {
    summary: () => ipcRenderer.invoke('progress:summary', {})
  },
  games: {
    save: (input) => ipcRenderer.invoke('games:save', input),
    list: (req) => ipcRenderer.invoke('games:list', req ?? {}),
    listAll: (req) => ipcRenderer.invoke('games:listAll', req ?? {}),
    get: (gameId) => ipcRenderer.invoke('games:get', { gameId }),
    reportResult: (req) => ipcRenderer.invoke('games:reportResult', req)
  },
  openings: {
    lookup: (fen) => ipcRenderer.invoke('openings:lookup', { fen })
  },
  coach: {
    explainMove: (args) => ipcRenderer.invoke('coach:explainMove', args),
    positional: (args) => ipcRenderer.invoke('coach:positional', args)
  },
  review: {
    run: (req) => ipcRenderer.invoke('review:run', req),
    get: (gameId) => ipcRenderer.invoke('review:get', { gameId }),
    cancel: () => ipcRenderer.invoke('review:cancel', {}),
    onProgress: (cb) => {
      const listener = (_e: IpcRendererEvent, data: ReviewProgress) => cb(data)
      ipcRenderer.on('review:progress', listener)
      return () => ipcRenderer.removeListener('review:progress', listener)
    }
  },
  perf: {
    estimate: (req) => ipcRenderer.invoke('perf:estimate', req)
  },
  famous: {
    list: (req) => ipcRenderer.invoke('famous:list', req ?? {}),
    get: (id) => ipcRenderer.invoke('famous:get', { id })
  },
  school: {
    chapters: () => ipcRenderer.invoke('school:chapters', {}),
    chapter: (id) => ipcRenderer.invoke('school:chapter', { id }),
    mastery: () => ipcRenderer.invoke('school:mastery', {}),
    recordConcept: (req) => ipcRenderer.invoke('school:recordConcept', req),
    recordSegment: (req) => ipcRenderer.invoke('school:recordSegment', req),
    completeChapter: (req) => ipcRenderer.invoke('school:completeChapter', req),
    narrate: (req) => ipcRenderer.invoke('school:narrate', req),
    debrief: (req) => ipcRenderer.invoke('school:debrief', req),
    recordLesson: (req) => ipcRenderer.invoke('school:recordLesson', req),
    recordTest: (req) => ipcRenderer.invoke('school:recordTest', req),
    testState: (req) => ipcRenderer.invoke('school:testState', req),
    placementState: () => ipcRenderer.invoke('school:placementState', {}),
    recordPlacementGame: (req) => ipcRenderer.invoke('school:recordPlacementGame', req),
    resetPlacement: () => ipcRenderer.invoke('school:resetPlacement', {}),
    placementConfig: () => ipcRenderer.invoke('school:placementConfig', {}),
    // Feature 2/3/4: recommendation, spaced repetition, daily lesson + streak.
    recommend: () => ipcRenderer.invoke('school:recommend', {}),
    dueReviews: (req) => ipcRenderer.invoke('school:dueReviews', req ?? {}),
    reviewConcept: (req) => ipcRenderer.invoke('school:reviewConcept', req),
    daily: () => ipcRenderer.invoke('school:daily', {}),
    recordDaily: (req) => ipcRenderer.invoke('school:recordDaily', req),
    streak: () => ipcRenderer.invoke('school:streak', {})
  },
  personas: {
    list: () => ipcRenderer.invoke('personas:list', {}),
    move: (req) => ipcRenderer.invoke('personas:move', req)
  },
  datasets: {
    status: () => ipcRenderer.invoke('datasets:status', {}),
    items: () => ipcRenderer.invoke('datasets:items', {}),
    import: (req) => ipcRenderer.invoke('datasets:import', req ?? {}),
    cancel: () => ipcRenderer.invoke('datasets:cancel', {}),
    onProgress: (cb) => {
      const listener = (_e: IpcRendererEvent, data: DatasetProgress) => cb(data)
      ipcRenderer.on('datasets:progress', listener)
      return () => ipcRenderer.removeListener('datasets:progress', listener)
    }
  },
  customVariants: {
    save: (req) => ipcRenderer.invoke('customVariants:save', req),
    list: () => ipcRenderer.invoke('customVariants:list', {}),
    get: (id) => ipcRenderer.invoke('customVariants:get', { id }),
    delete: (id) => ipcRenderer.invoke('customVariants:delete', { id })
  },
  dialog: {
    saveFile: (req) => ipcRenderer.invoke('dialog:saveFile', req)
  },
  updates: {
    status: () => ipcRenderer.invoke('updates:status', {}),
    check: () => ipcRenderer.invoke('updates:check', {}),
    download: () => ipcRenderer.invoke('updates:download', {}),
    onStatus: (cb) => {
      const listener = (_e: IpcRendererEvent, data: UpdateStatus) => cb(data)
      ipcRenderer.on('updates:status', listener)
      return () => ipcRenderer.removeListener('updates:status', listener)
    }
  }
  // Multiplayer is renderer-owned (WebRTC over trystero); it no longer crosses
  // IPC. See src/renderer/src/features/play/online/mpClient.ts.
}
