import { useState, useEffect, useCallback } from "react";

export type Locale = "en" | "ko";

const STORAGE_KEY = "xpair-locale";
const DEFAULT_LOCALE: Locale = "en";

function getStoredLocale(): Locale {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "ko" || v === "en") return v;
  } catch {}
  return DEFAULT_LOCALE;
}

let globalLocale: Locale = getStoredLocale();
const subs = new Set<(l: Locale) => void>();

export function useLocale() {
  const [locale, setLocaleState] = useState<Locale>(globalLocale);

  useEffect(() => {
    subs.add(setLocaleState);
    return () => {
      subs.delete(setLocaleState);
    };
  }, []);

  const setLocale = useCallback((next: Locale) => {
    if (next === globalLocale) return;
    globalLocale = next;
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {}
    subs.forEach((fn) => fn(next));
  }, []);

  return { locale, setLocale };
}
