import { useCallback, useRef, useState } from "react";

export type WizardDirection = "next" | "prev";

export function useWizard(totalSteps: number, initial = 0) {
  const [index, setIndex] = useState(initial);
  const directionRef = useRef<WizardDirection>("next");

  const goTo = useCallback(
    (i: number, dir: WizardDirection = "next") => {
      directionRef.current = dir;
      setIndex(Math.max(0, Math.min(totalSteps - 1, i)));
    },
    [totalSteps],
  );

  const next = useCallback(() => {
    directionRef.current = "next";
    setIndex((i) => Math.min(totalSteps - 1, i + 1));
  }, [totalSteps]);

  const prev = useCallback(() => {
    directionRef.current = "prev";
    setIndex((i) => Math.max(0, i - 1));
  }, []);

  return {
    index,
    direction: directionRef.current,
    totalSteps,
    isFirst: index === 0,
    isLast: index === totalSteps - 1,
    next,
    prev,
    goTo,
  };
}
