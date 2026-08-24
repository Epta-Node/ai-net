import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { i18nReady } from './i18n'
import './styles/global.css'

async function prepareApp() {
  // Wait for i18next before the first render so the UI never paints raw
  // translation keys.
  await i18nReady

  // Always prepare MSW if we're in dev or test mode.
  // We can check if mockServiceWorker.js is present or just import mocks.
  if (import.meta.env.DEV || import.meta.env.MODE === 'test' || window.location.hostname === 'localhost') {
    try {
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
