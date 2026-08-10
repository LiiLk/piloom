import type { Api, Model } from "@earendil-works/pi-ai";

export interface OnboardingSettingsReader {
	getOnboardingShown(): boolean;
}

export interface OnboardingModelRegistryReader {
	refresh(): void;
	hasConfiguredAuth(model: Model<Api>): boolean;
}

export interface OnboardingStartupState {
	settingsManager: OnboardingSettingsReader;
	modelRegistry: OnboardingModelRegistryReader;
	model: Model<Api> | undefined;
}

/** Selects the branded model-picker branch; the legacy name remains internal to the existing startup flow. */
export function shouldRunPrimeCliOnboardingSplash(state: OnboardingStartupState): boolean {
	return !state.settingsManager.getOnboardingShown();
}

export function isOnboardingModelReady(state: OnboardingStartupState): boolean {
	return state.model !== undefined && state.modelRegistry.hasConfiguredAuth(state.model);
}

export function shouldRunOnboarding(state: OnboardingStartupState): boolean {
	if (state.settingsManager.getOnboardingShown()) {
		return false;
	}
	state.modelRegistry.refresh();
	if (shouldRunPrimeCliOnboardingSplash(state)) {
		return true;
	}
	return !isOnboardingModelReady(state);
}
