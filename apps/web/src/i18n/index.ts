import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import { DEFAULT_LOCALE, detectInitialLocale } from "./config";

// Statically bundled: the whole UI string set across both languages is small,
// so it ships in the main chunk. Revisit lazy-loading only if this grows large.
import enCommon from "./locales/en/common.json";
import enNav from "./locales/en/nav.json";
import enSettings from "./locales/en/settings.json";
import enRuns from "./locales/en/runs.json";
import enSession from "./locales/en/session.json";
import enInspector from "./locales/en/inspector.json";
import enErrors from "./locales/en/errors.json";
import enPages from "./locales/en/pages.json";

import zhCommon from "./locales/zh-Hans/common.json";
import zhNav from "./locales/zh-Hans/nav.json";
import zhSettings from "./locales/zh-Hans/settings.json";
import zhRuns from "./locales/zh-Hans/runs.json";
import zhSession from "./locales/zh-Hans/session.json";
import zhInspector from "./locales/zh-Hans/inspector.json";
import zhErrors from "./locales/zh-Hans/errors.json";
import zhPages from "./locales/zh-Hans/pages.json";

export const NAMESPACES = [
  "common", "nav", "settings", "runs", "session", "inspector", "errors", "pages",
] as const;

const resources = {
  en: { common: enCommon, nav: enNav, settings: enSettings, runs: enRuns, session: enSession, inspector: enInspector, errors: enErrors, pages: enPages },
  "zh-Hans": { common: zhCommon, nav: zhNav, settings: zhSettings, runs: zhRuns, session: zhSession, inspector: zhInspector, errors: zhErrors, pages: zhPages },
} as const;

void i18n.use(initReactI18next).init({
  resources,
  lng: detectInitialLocale(),
  fallbackLng: DEFAULT_LOCALE,
  defaultNS: "common",
  ns: NAMESPACES,
  interpolation: { escapeValue: false }, // React already escapes.
  returnNull: false,
});

export default i18n;
