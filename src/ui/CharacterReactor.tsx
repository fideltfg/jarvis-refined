import { activeThemePackage } from '../lib/theme-runtime'

export function CharacterReactor({ inline = false }: { inline?: boolean } = {}) {
  const Reactor = activeThemePackage().Reactor
  return Reactor ? <Reactor inline={inline} /> : null
}