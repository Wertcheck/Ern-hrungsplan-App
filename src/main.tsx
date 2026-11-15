import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { ErrorBoundary, StoreProvider } from './store'

createRoot(document.getElementById('root')!).render(
  <StrictMode><ErrorBoundary><StoreProvider><App /></StoreProvider></ErrorBoundary></StrictMode>,
)

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => undefined) })
}
