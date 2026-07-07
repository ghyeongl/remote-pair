import { type ReactNode } from "react";
import type { WizardDirection } from "./useWizard";

type Props = {
  stepKey: string | number;
  direction: WizardDirection;
  children: ReactNode;
};

export function AnimatedStep({ stepKey, direction, children }: Props) {
  return (
    <div
      key={stepKey}
      className={direction === "next" ? "step-enter-next" : "step-enter-prev"}
    >
      {children}
    </div>
  );
}
