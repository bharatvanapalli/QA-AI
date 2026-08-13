import { CssSelectorGenerated, CssSelectorTypes, ElementData, ElementSelectorData, OperatorValue } from "./types.js";
/**
 * Creates data describing a specific selector.
 */
export declare function createElementSelectorData(selector: CssSelectorGenerated): ElementSelectorData;
/**
 * Creates data describing an element within CssSelector chain.
 */
export declare function createElementData(element: Element, selectorTypes: CssSelectorTypes, operator?: OperatorValue): ElementData;
/**
 * Constructs selector from element data.
 */
export declare function constructElementSelector({ selectors, operator, }: ElementData): CssSelectorGenerated;
