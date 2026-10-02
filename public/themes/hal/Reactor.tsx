import { useStore } from '../../../src/store'



export function Reactor({ inline = false }: { inline?: boolean } = {}) {
  const reactor = useStore((state) => state.ui.reactor)
  const className = 'character-reactor hal-reactor'
  const style = {
    '--reactor-scale': reactor.scale,
    // Spin was reaching the store but never the stylesheet, so ui_reactor's
    // spin had no effect on any character reactor. Clamped above zero because
    // it divides an animation duration.
    '--reactor-spin': Math.max(reactor.spin, 0.2),
    opacity: reactor.visible ? reactor.intensity : 0,
  } as React.CSSProperties

  return (
    <div className={className} style={style} aria-hidden="true" data-visible={reactor.visible} data-inline={inline ? 'true' : undefined}>
      <div className="hal-live-lens">
          <span className="hal-live-bezel" />
          <span className="hal-live-glass" />
          <span className="hal-live-reflection" />
          <span className="hal-live-core" />
        </div>
    </div>
  )
}
