import React from 'react'
import ReactDOM from 'react-dom/client'
import './i18n'
import './App.css'

import { GetSystemLanguage } from './wailsjs/go/main/App'
import i18n from './i18n'

GetSystemLanguage().then(lang => {
  if (lang && lang.toLowerCase().startsWith('zh')) {
    return i18n.changeLanguage('zh')
  }
}).catch(() => {}).finally(() => {
  import('./App').then(({ default: App }) => {
    ReactDOM.createRoot(document.getElementById('root')).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>
    )
  })
})
