export function startPerformanceCleanup(): () => void {
  // React development profiling retains these measures in the browser's native heap.
  const timer = window.setInterval(() => {
    window.performance.clearMeasures()
  }, 5000)
  return () => window.clearInterval(timer)
}