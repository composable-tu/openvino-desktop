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

// Detect language from Go backend (OS system language)
const detectFromOS = async () => {
  try {
    const { GetSystemLanguage } = await import('../../wailsjs/go/main/App')
    const lang = await GetSystemLanguage()
    if (lang && lang.toLowerCase().startsWith('zh')) {
      i18n.changeLanguage('zh')
    }
  } catch {
    // fallback: try navigator
    const languages = navigator.languages || [navigator.language || navigator.userLanguage || '']
    for (const lang of languages) {
      if (lang && lang.toLowerCase().startsWith('zh')) {
        i18n.changeLanguage('zh')
        break
      }
    }
  }
}

detectFromOS()

export default i18n
