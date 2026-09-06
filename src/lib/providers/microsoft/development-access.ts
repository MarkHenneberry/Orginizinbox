export function isMicrosoftOAuthDevelopmentUiEnabled(
  nodeEnv: string | undefined,
  featureEnabled: boolean
) {
  return nodeEnv !== "production" && featureEnabled;
}
