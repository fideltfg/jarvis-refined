import type { Drive } from '../../../src/scene/Scene'
import { Core } from './Core'
import { Particles } from './Particles'

export function Scene({ drive }: { drive: Drive }) {
  return <><Core drive={drive} /><Particles drive={drive} /></>
}