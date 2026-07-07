import { useLocale, type Locale } from "@shared/hooks/use-locale";

export type { Locale };

export type Dict = Record<string, string>;
export type Dicts = Record<Locale, Dict>;
export type TFn = (key: keyof typeof BASE_DICTS.en | string, vars?: Record<string, string | number>) => string;

export const BASE_DICTS = {
  en: {
    "shell.back": "Back",
    "shell.next": "Next",
    "shell.getStarted": "Get started",
    "shell.finish": "Finish",
    "shell.continue": "Continue",
    "shell.beginSetup": "Begin setup",
    "shell.openXpair": "Open Xpair",
    "shell.close": "Close",
    "shell.notAvailable": "—",

    "consent.crash.title": "Help us squash bugs",
    "consent.crash.desc":
      "If Xpair ever crashes, we can send an anonymous stack trace so we can fix it fast. No file names, no code, no personal data.",
    "consent.crash.label": "Send crash reports",
    "consent.crash.sub": "Anonymous. Only sent when something breaks.",
    "consent.recommended": "Recommended",
    "consent.analytics.title": "Shape what we build next",
    "consent.analytics.desc":
      "Share aggregate feature usage so we know what to improve. Never your file names, code, or keystrokes.",
    "consent.analytics.label": "Share usage analytics",
    "consent.analytics.sub": "Off by default. Change anytime in Settings.",
  },
  ko: {
    "shell.back": "이전",
    "shell.next": "다음",
    "shell.getStarted": "시작하기",
    "shell.finish": "완료",
    "shell.continue": "계속",
    "shell.beginSetup": "설정 시작",
    "shell.openXpair": "Xpair 열기",
    "shell.close": "닫기",
    "shell.notAvailable": "—",

    "consent.crash.title": "버그 개선을 도와주세요",
    "consent.crash.desc":
      "Xpair에 문제가 생기면 익명 스택 트레이스를 보내주세요. 파일명, 코드, 개인정보는 포함되지 않습니다.",
    "consent.crash.label": "크래시 리포트 전송",
    "consent.crash.sub": "익명. 오류가 발생했을 때만 전송됩니다.",
    "consent.recommended": "권장",
    "consent.analytics.title": "다음에 만들 것을 함께 정해요",
    "consent.analytics.desc":
      "어떤 기능이 얼마나 쓰이는지 집계 데이터를 공유해 주세요. 파일명, 코드, 키 입력은 절대 수집하지 않습니다.",
    "consent.analytics.label": "사용 분석 공유",
    "consent.analytics.sub": "기본은 꺼짐. 설정에서 언제든 변경할 수 있습니다.",
  },
} satisfies Dicts;

function format(str: string, vars?: Record<string, string | number>) {
  if (!vars) return str;
  return str.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`));
}

export function createUseT(extensions: Partial<Dicts> = {}) {
  const dicts: Dicts = {
    en: { ...BASE_DICTS.en, ...(extensions.en ?? {}) },
    ko: { ...BASE_DICTS.ko, ...(extensions.ko ?? {}) },
  };

  return function useT(): { t: TFn; locale: Locale } {
    const { locale } = useLocale();
    const dict = dicts[locale] ?? dicts.en;
    const t: TFn = (key, vars) => format(dict[key] ?? dicts.en[key] ?? String(key), vars);
    return { t, locale };
  };
}

export const useT = createUseT();
