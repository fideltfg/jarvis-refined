import type { ThemePackage } from '../../../src/lib/theme-package'
import { LcarsBoot as Boot } from './Boot'
import { Reactor } from './Reactor'
import { sounds } from './sounds'

const theme = { Boot, Reactor, sounds } satisfies ThemePackage
export default theme