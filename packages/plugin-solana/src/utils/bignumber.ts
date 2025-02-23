import { BigNumber } from "bignumber.js";

// Configure global settings
BigNumber.config({ EXPONENTIAL_AT: 1e9, DECIMAL_PLACES: 20 });

// Helper function to create new BigNumber instances
export function toBN(value: string | number): BigNumber {
    return new BigNumber(value);
}

// Export BigNumber
export { BigNumber }; 