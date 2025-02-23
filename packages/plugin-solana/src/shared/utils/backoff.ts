export interface BackoffOptions {
    initialDelayMs: number;
    maxDelayMs: number;
    factor: number;
}

export async function exponentialBackoff(
    attempt: number,
    options: BackoffOptions
): Promise<void> {
    const { initialDelayMs, maxDelayMs, factor } = options;
    const delay = Math.min(
        initialDelayMs * Math.pow(factor, attempt),
        maxDelayMs
    );
    
    await new Promise(resolve => setTimeout(resolve, delay));
} 