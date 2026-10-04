// Inner work expires before its transport and controller, so failures propagate
// before the caller's deadline instead of taking effect after a reported timeout.
export const audioPreparationTimeoutMs = 25_000;
export const audioOperationTimeoutMs = 30_000;
export const seekTimeoutSeconds = 35;
export const playbackRequestTimeoutMs = (type: string) => type === 'load' || type === 'retry' ? 120_000 : 40_000;
