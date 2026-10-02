import type { ThemePackage } from '../../../src/lib/theme-package'
import { Boot } from './Boot'
import { OrinHud as Hud } from './Hud'
import { Reactor } from './Reactor'
import { sounds } from './sounds'

const theme = { Boot, Reactor, Hud, sounds } satisfies ThemePackage
export default theme