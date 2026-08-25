import { useState } from 'react'

export function useOnboarding(totalSteps: number) {
  const [currentStep, setCurrentStep] = useState(1)

  const nextStep = () => {
    setCurrentStep((prev) => Math.min(prev + 1, totalSteps))
  }

  const prevStep = () => {
    setCurrentStep((prev) => Math.max(prev - 1, 1))
  }

  const goToStep = (step: number) => {
    setCurrentStep(Math.max(1, Math.min(step, totalSteps)))
  }

  return {
    currentStep,
    nextStep,
    prevStep,
    goToStep,
    isFirstStep: currentStep === 1,
    isLastStep: currentStep === totalSteps,
  }
}
