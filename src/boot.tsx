import { createRoot } from 'react-dom/client'
import App from './App.tsx'

// Everything downstream of this module reads the theme as a plain constant at
// import time, which is only safe because main.tsx has already resolved it.
createRoot(document.getElementById('root')!).render(<App />)
