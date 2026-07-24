import { Buffer } from 'buffer'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'

// bip39 references Buffer as a global — polyfill it for the WebView.
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).Buffer = Buffer
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
