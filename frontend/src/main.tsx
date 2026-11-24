import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { i18nReady } from './i18n'
import './styles/global.css'

async function prepareApp() {
  // Wait for i18next before the first render so the UI never paints raw
  // translation keys.
  await i18nReady

  // Guard the import itself so the module is excluded from the production graph.
  if (import.meta.env.DEV || import.meta.env.MODE === 'test' || window.location.hostname === 'localhost') {
    try {
      // Dynamic import with dev guard ensures Rollup can tree-shake this.
      const { worker } = await import('./mocks/browser')
      await worker.start({
        onUnhandledRequest: 'bypass',
        serviceWorker: {
          url: '/mockServiceWorker.js',
        }
      })
    } catch (e) {
      console.warn('MSW failed to start', e)
    }
  }
}

prepareApp().then(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
})
