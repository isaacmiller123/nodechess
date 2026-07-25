// Shared localStorage key for PuzzlesView's active mode tab.
//
// Lives in its own tiny module (rather than PuzzlesView.tsx) so Home cards can
// deep-link a tab: write a mode, then navigate. WITHOUT statically importing
// the lazily-loaded PuzzlesView chunk into the main bundle.

/** Puzzle modes persisted under MODE_KEY. `train` is the classic adaptive
 *  trainer; custom/rush/daily are the mode tabs built in ./modes/*. */
export type PuzzleModeKey = 'train' | 'custom' | 'rush' | 'daily'

/** localStorage key PuzzlesView reads on mount to pick the active mode tab. */
export const MODE_KEY = 'oct.puzzles.mode.v1'
