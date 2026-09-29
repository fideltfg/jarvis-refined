import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { THEME } from './config'
import { copy } from './theme'

// The theme is fixed for the life of the page, so it is stamped once here:
document.documentElement.dataset.theme = THEME
document.title = copy.title
if (THEME !== 'stark') {
  // LCARS carries its own stylesheet; the other classics share one.
  void (THEME === 'lcars' ? import('./lcars.css') : import('./cult-classics.css'))
  const themeColors = {
    stark: '#01060c',
    hal: '#050000',
    wopr: '#090700',
    mother: '#071006',
    lcars: '#000000',
  }
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', themeColors[THEME])
}

// Deliberately no StrictMode: its double-invoked effects would open the
// microphone and arm the wake-word engine twice, and the second subscription
// steals the audio stream from the first.
createRoot(document.getElementById('root')!).render(<App />)
