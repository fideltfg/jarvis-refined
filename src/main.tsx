import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { copy, IS_LCARS } from './theme'

// The theme is fixed for the life of the page, so it is stamped once here:
// lcars.css scopes every rule under [data-theme='lcars'], and is only fetched
// at all when it is going to be used.
document.documentElement.dataset.theme = IS_LCARS ? 'lcars' : 'stark'
document.title = copy.title
if (IS_LCARS) {
  void import('./lcars.css')
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#000000')
}

// Deliberately no StrictMode: its double-invoked effects would open the
// microphone and arm the wake-word engine twice, and the second subscription
// steals the audio stream from the first.
createRoot(document.getElementById('root')!).render(<App />)
