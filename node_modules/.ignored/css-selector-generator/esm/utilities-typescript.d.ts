/**
 * Checks whether value is one of the enum's values.
 */
export declare function isEnumValue<T extends Record<string, unknown>>(haystack: T, needle: unknown): needle is T[keyof T];
