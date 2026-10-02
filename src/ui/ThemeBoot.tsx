import { activeThemePackage } from '../lib/theme-runtime'
import { useStore } from '../store'
import { copy } from '../theme'

function DefaultBoot() {
  const phase = useStore((state) => state.phase)
  if (phase !== 'boot') return null
  return <div className="boot" style={{ display: 'grid', placeItems: 'center' }}>{copy.status.boot}</div>
}

export function ThemeBoot() {
  const Sequence = activeThemePackage().Boot ?? DefaultBoot
  return <Sequence />
}