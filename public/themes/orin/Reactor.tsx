import { useStore } from '../../../src/store'



/** Render the ORIN reactor lens when the theme docks it inline. */
export function Reactor({ inline = false }: { inline?: boolean } = {}) {
  const level = useStore((state) => state.level)
  const phase = useStore((state) => state.phase)
  const reactor = useStore((state) => state.ui.reactor)
  const className = 'character-reactor orin-reactor'
  const style = {
    '--reactor-scale': reactor.scale,
    // Spin was reaching the store but never the stylesheet, so ui_reactor's
    // spin had no effect on any character reactor. Clamped above zero because
    // it divides an animation duration.
    '--reactor-spin': Math.max(reactor.spin, 0.2),
    opacity: reactor.visible ? reactor.intensity : 0,
  } as React.CSSProperties
  if (!inline) return null

  return (
    <div className={className} style={style} aria-hidden="true" data-visible={reactor.visible} data-inline={inline ? 'true' : undefined}>
      <div className="orin-live-lens" data-phase={phase} style={{ '--level': level } as React.CSSProperties}>
          <span className="orin-lens-orbit" />
          <span className="orin-lens-bezel" />
          <span className="orin-lens-well" />
          <span className="orin-lens-glass" />
          <span className="orin-lens-ring orin-lens-ring-outer" />
          <span className="orin-lens-ring orin-lens-ring-inner" />
          <span className="orin-lens-highlight" />
        </div>
    </div>
  )
}
