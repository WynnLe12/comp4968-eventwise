/** Missing or invalid deployment settings. The message names the variable, never its value. */
export class TimelineConfigurationError extends Error {
  override name = "TimelineConfigurationError";
}
