import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from './locales/en.json'
import zh from './locales/zh.json'

i18n
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      zh: { translation: zh },
    },
    lng: 'en',
    fallbackLng: 'en',
    interpolation: {
      escapeValue: false,
    },
  })

// Detect language: navigator first (sync, instant), then Go backend (async)
const navLangs = navigator.languages || [navigator.language || navigator.userLanguage || '']
for (const lang of navLangs) {
  if (lang && lang.toLowerCase().startsWith('zh')) {
    i18n.changeLanguage('zh')
    break
  }
}

export default i18n
