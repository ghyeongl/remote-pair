import { useLocale } from "@/hooks/use-locale";
import { Globe } from "lucide-react";

export function LangToggle() {
  const { locale, setLocale } = useLocale();

  return (
    <div className="mt-5 flex items-center justify-center gap-2">
      <Globe className="h-4 w-4 text-muted-foreground" />
      <div className="inline-flex overflow-hidden rounded-full border border-border bg-muted/60 p-0.5">
        <button
          onClick={() => setLocale("en")}
          className={
            "rounded-full px-3 py-1 text-xs font-medium transition-colors " +
            (locale === "en"
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-foreground")
          }
        >
          English
        </button>
        <button
          onClick={() => setLocale("ko")}
          className={
            "rounded-full px-3 py-1 text-xs font-medium transition-colors " +
            (locale === "ko"
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-foreground")
          }
        >
          한국어
        </button>
      </div>
    </div>
  );
}
