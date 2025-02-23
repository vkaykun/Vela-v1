// packages/plugin-solana/src/utils/commandValidation.ts

import { elizaLogger } from "@elizaos/core";
import { PublicKey } from "@solana/web3.js";

// Validates if a string is a valid Solana address
export const isValidSolanaAddress = (address: string): boolean => {
    // First do a basic format check before trying PublicKey
    const base58Pattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
    if (!base58Pattern.test(address)) {
        return false;
    }

    try {
        new PublicKey(address);
        return true;
    } catch {
        return false;
    }
};

// Validates if a string is a valid Solana transaction signature
export const isValidTransactionSignature = (signature: string): boolean => {
    // Solana transaction signatures are base58 encoded and 88 characters long
    const base58Pattern = /^[1-9A-HJ-NP-Za-km-z]{88}$/;
    return base58Pattern.test(signature);
};

// Validates commands in both direct (!command) and mention (@agent !command) formats
export const validateCommand = (text: string, command: string): boolean => {
    // Match both direct command and Discord mention format
    // This handles:
    // 1. !command
    // 2. <@123456789> !command (Discord mention)
    const commandPattern = new RegExp(`^(?:<@!?\\d+>\\s*)?!${command}(?:\\s|$)`, "i");
    const isValid = commandPattern.test(text);

    elizaLogger.debug(`[Command Validation] Testing command: ${command}`, {
        text,
        pattern: commandPattern.toString(),
        isValid,
        matchResult: text.match(commandPattern),
        mentionMatch: text.match(/^<@!?\d+>/),
        commandPart: text.replace(/^<@!?\d+>\s*/, '').trim()
    });

    return isValid;
};

// For commands that require parameters (like register and verify)
export const validateCommandWithParam = (text: string, command: string, paramPattern: string): RegExpMatchArray | null => {
    // Handle special cases for different commands
    let parameterPattern = paramPattern;
    let additionalValidation = null;

    switch (command) {
        case "register":
            parameterPattern = "[1-9A-HJ-NP-Za-km-z]{32,44}"; // Solana address format
            additionalValidation = isValidSolanaAddress;
            // Fixed pattern to handle all variations of wallet commands
            const registerPattern = new RegExp(
                `^(?:(?:<@!?\\d+>|@\\d+)\\s*)?!${command}\\s+(?:(?:my\\s+)?wallet\\s+)?(${parameterPattern})\\s*$`,
                "i"
            );
            return text.match(registerPattern);
        case "verify":
            parameterPattern = "[1-9A-HJ-NP-Za-km-z]{88}"; // Transaction signature format
            additionalValidation = isValidTransactionSignature;
            break;
        default:
            // Use provided pattern for other commands
            break;
    }

    // This handles other commands:
    // 1. !command <param>
    // 2. <@123456789> !command <param> (Discord mention with brackets)
    // 3. @123456789 !command <param> (Discord mention without brackets)
    const commandPattern = new RegExp(
        `^(?:(?:<@!?\\d+>|@\\d+)\\s*)?!${command}\\s+(${parameterPattern})\\s*$`,
        "i"
    );

    const match = text.match(commandPattern);

    // Additional validation if needed
    if (match && additionalValidation) {
        const param = match[1];
        if (!additionalValidation(param)) {
            elizaLogger.debug(`[Command Validation] Invalid parameter for ${command}: ${param}`);
            return null;
        }
    }

    elizaLogger.debug(`[Command Validation] Testing command with param: ${command}`, {
        text,
        pattern: commandPattern.toString(),
        hasMatch: !!match,
        match: match ? match[1] : null,
        fullMatch: match ? match[0] : null,
        mentionMatch: text.match(/^(?:<@!?\d+>|@\d+)/),
        commandAndParam: text.replace(/^(?:<@!?\d+>|@\d+)\s*/, '').trim(),
        commandType: command,
        parameterPattern,
        validationResult: match && additionalValidation ? additionalValidation(match[1]) : null
    });

    return match;
};

// Helper function to extract command and parameters from text
export const parseCommand = (text: string): { command: string; params: string[] } | null => {
    const commandMatch = text.trim().match(/^(?:<@!?\d+>|@\d+)?\s*!(\w+)(.*)/i);
    if (!commandMatch) return null;

    const command = commandMatch[1].toLowerCase();
    const paramString = commandMatch[2].trim();
    const params = paramString ? paramString.split(/\s+/) : [];

    return { command, params };
};