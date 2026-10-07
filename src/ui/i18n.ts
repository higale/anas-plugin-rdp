import { createInstance } from 'i18next';
import english from '../../lang/en.json';

export const i18n = createInstance();
await i18n.init({ lng: 'en', fallbackLng: 'en', resources: { en: { translation: english } },
  interpolation: { escapeValue: false }, returnEmptyString: false });

export async function initializeLanguages(resources: Record<string, Record<string, unknown>>) {
  for (const [code, resource] of Object.entries(resources)) i18n.addResourceBundle(code, 'translation', resource, true, true);
}

export async function setLanguage(preference: string) {
  const available = Object.keys(i18n.store.data);
  const normalized = preference.trim().toLowerCase();
  const language = available.find(code => code.toLowerCase() === normalized)
    ?? available.find(code => code.split('-')[0].toLowerCase() === normalized.split('-')[0]) ?? 'en';
  if (i18n.language !== language) await i18n.changeLanguage(language);
}

// UI inserts translations via textContent, including interpolated host names.
export const t = (key: string, values?: Record<string, string | number>): string => String(i18n.t(key, values));
