interface powerSetGeneratorOptions {
    maxResults?: number;
}
export declare function powerSetGenerator<T>(input?: T[], { maxResults }?: powerSetGeneratorOptions): IterableIterator<T[]>;
/**
 * Generates power set of input items.
 */
export declare function getPowerSet<T>(input?: T[], { maxResults }?: powerSetGeneratorOptions): T[][];
export {};
