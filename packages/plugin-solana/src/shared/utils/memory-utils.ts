import { MEMORY_DOMAINS } from '../constants.ts';

export function getMemoryDomain(type: string): string {
    // Active/recent memories
    if (type.startsWith("active_") || 
        type.includes("_request") || 
        type.includes("_pending")) {
        return MEMORY_DOMAINS.ACTIVE[type.split('_')[1].toUpperCase()] || MEMORY_DOMAINS.ACTIVE.TRANSACTIONS;
    }
    
    // Archived/completed memories
    if (type.startsWith("archived_") || 
        type.includes("_completed") || 
        type.includes("_executed")) {
        return MEMORY_DOMAINS.ARCHIVE[type.split('_')[1].toUpperCase()] || MEMORY_DOMAINS.ARCHIVE.TRANSACTIONS;
    }
    
    // Descriptive memories
    if (type.includes("_description") || 
        type.includes("_metadata") || 
        type.includes("_config")) {
        return MEMORY_DOMAINS.DESCRIPTIONS[type.split('_')[0].toUpperCase()] || MEMORY_DOMAINS.DESCRIPTIONS.AGENTS;
    }
    
    // Default to active transactions for unknown types
    return MEMORY_DOMAINS.ACTIVE.TRANSACTIONS;
}

export function shouldArchiveMemory(type: string, status?: string): boolean {
    return status === "executed" || 
           status === "failed" || 
           status === "cancelled" || 
           type.startsWith("archived_") || 
           type.includes("_completed") || 
           type.includes("_executed");
}

export function isDescriptiveMemory(type: string): boolean {
    return type.includes("_description") || 
           type.includes("_metadata") || 
           type.includes("_config");
} 