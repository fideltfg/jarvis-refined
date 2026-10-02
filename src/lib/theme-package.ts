import type { ComponentType } from 'react'
import type { Phase } from '../store'
import type { Drive } from '../scene/Scene'

export type Cue = 'boot' | 'wake' | 'listen' | 'tool' | 'done' | 'error'
  | 'interrupt' | 'ack' | 'warning' | 'panelOpen' | 'panelClose'
  | 'taskStart' | 'taskPause' | 'taskDone' | 'micOpen' | 'micClose'

export type SoundTools = {
  blip: (frequency: number, options?: {
    at?: number; dur?: number; type?: OscillatorType; gain?: number; sweepTo?: number
  }) => void
  noise: (options?: { at?: number; dur?: number; gain?: number; from?: number; to?: number }) => void
}

export type ThemePackage = {
  Boot?: ComponentType
  Reactor?: ComponentType<{ inline?: boolean }>
  Hud?: ComponentType
  Frame?: ComponentType<{ phase: Phase }>
  Scene?: ComponentType<{ drive: Drive }>
  sounds?: (tools: SoundTools) => Partial<Record<Cue, () => void>>
}