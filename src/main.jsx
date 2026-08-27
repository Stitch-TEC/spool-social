import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import { installStaleAssetRecovery } from './staleAssetRecovery.js'

// Vite emits this event when a loaded shell asks for a lazy chunk removed by a
// newer deployment. Install before React so the failed import cannot become a
// component error or a blank root.
installStaleAssetRecovery()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {/* This boundary must live OUTSIDE App. App's former inner boundary could
        catch child-card failures, but not an exception in App's own render or
        a state updater such as the first Firestore snapshot. */}
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
