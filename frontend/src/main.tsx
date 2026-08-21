import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import ErrorBoundary from './components/ErrorBoundary'
import useIsMobile from './hooks/useIsMobile'
import MobileApp from './mobile/MobileApp'
import './index.css'

function Root() {
  const isMobile = useIsMobile()
  return isMobile ? <MobileApp /> : <App />
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <Root />
    </ErrorBoundary>
  </React.StrictMode>,
)
