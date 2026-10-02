import type { ThemePackage } from '../../../src/lib/theme-package'
import { Boot } from './Boot'
import { sounds } from './sounds'
import { Scene } from './Scene'

const theme = { Boot, Scene, sounds } satisfies ThemePackage
export default theme