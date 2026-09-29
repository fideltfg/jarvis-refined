import { activeTheme } from './lib/theme-runtime'
import type { Phase } from './store'

/**
 * The active theme's words and colours, read once at module load.
 *
 * Components read from here rather than branching on the theme themselves, so
 * a string that only one theme overrides can never be forgotten in another.
 * The values come from `public/themes/<id>/theme.json` — see theme-runtime.ts —
 * which is resolved before React mounts, so these can stay plain constants.
 */
const theme = activeTheme()

export const copy = theme.copy

export const themePhaseColor: Record<Phase, string> = theme.phaseColors

/** The resting colours the 3D scene starts from before any phase tint lands. */
export const sceneTint = theme.sceneTint

export const NAME_PATTERN: string = theme.wake.pattern

/** Spoken forms supplied to browsers that support contextual phrase biasing. */
export const WAKE_PHRASES: readonly string[] = theme.wake.phrases

export const SPEECH_LANGUAGE = theme.wake.language

/**
 * Which phrasebook the canned lines come from. A butler says "Very good, sir";
 * a machine says "Acknowledged."
 */
export const IS_BUTLER = theme.register === 'butler'
