// packages/plugin-solana/src/utils/governanceUtils.ts

import {
    elizaLogger,
    Memory
} from "@elizaos/core";
import { IAgentRuntime } from "../shared/types/base.ts";
import { ProposalContent } from "../shared/types/vote";
import { SwapService } from "../services/swapService.ts";
import { PositionTracker } from "../providers/positionTracker.ts";
import { ExtendedAgentRuntime } from "../shared/utils/runtime.ts";

export const TOKEN_MINTS = {
    'SOL': 'So11111111111111111111111111111111111111112',
    'USDC': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    'BONK': 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    'JUP': 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
    'WEN': 'WENWENvqqNya429ubCdR81ZmD69brwQaaBYY6p3LCpk',
    'ORCA': 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE',
    'RAY': '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R'
} as const;

function getMintAddress(tokenSymbol: string): string {
    const upperSymbol = tokenSymbol.toUpperCase();
    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(tokenSymbol)) {
        return tokenSymbol;
    }
    const mintAddress = TOKEN_MINTS[upperSymbol as keyof typeof TOKEN_MINTS];
    if (!mintAddress) {
        throw new Error(`Unknown token symbol: ${tokenSymbol}. Please use the full mint address.`);
    }
    return mintAddress;
}

export interface ActionValidationResult {
    isValid: boolean;
    extractedText?: string;
    matchType?: string;
}

export function validateActionCommand(
    message: Memory,
    runtime: IAgentRuntime,
    commandName: string,
    naturalPrefixes: string[],
    requiredTerms: string[] = []
): ActionValidationResult {
    try {
        if (message.userId === runtime.agentId) {
            elizaLogger.debug(`Skipping ${commandName} validation for assistant's message`);
            return { isValid: false };
        }

        const text = message.content.text.trim().toLowerCase();
        elizaLogger.debug(`Validating ${commandName} command:`, { text });

        const isCommandFormat = text.startsWith(`!${commandName}`) || text.startsWith(`/${commandName}`);

        const isNaturalFormat = naturalPrefixes.some(prefix => text.startsWith(prefix.toLowerCase()));

        const isImplicitFormat = text.includes(commandName) &&
            (requiredTerms.length === 0 || requiredTerms.some(term => text.includes(term.toLowerCase())));

        let extractedText = text;
        let matchType = '';

        if (isCommandFormat) {
            extractedText = text.replace(new RegExp(`^[!/]${commandName}\\s*`), '').trim();
            matchType = 'command';
        } else if (isNaturalFormat) {
            const matchedPrefix = naturalPrefixes.find(prefix => text.startsWith(prefix.toLowerCase()));
            if (matchedPrefix) {
                extractedText = text.replace(new RegExp(`^${matchedPrefix}\\s*`, 'i'), '').trim();
                matchType = 'natural';
            }
        } else if (isImplicitFormat) {
            matchType = 'implicit';
        }

        const isValid = isCommandFormat || isNaturalFormat || isImplicitFormat;

        elizaLogger.debug(`${commandName} validation result:`, {
            isValid,
            matchType,
            extractedText: extractedText || text
        });

        return {
            isValid,
            extractedText: extractedText || text,
            matchType
        };
    } catch (error) {
        elizaLogger.error(`Error in ${commandName} validation:`, error);
        return { isValid: false };
    }
}

export async function voteGatedAction(
    runtime: IAgentRuntime,
    action: (runtime: IAgentRuntime) => Promise<any>,
    proposal: ProposalContent,
    requiredVotes: number = 3
): Promise<boolean> {
    const yesVotes = proposal.yes.length;
    const noVotes = proposal.no.length;

    elizaLogger.info(`Processing vote-gated action for proposal ${proposal.id}`, {
        yesVotes,
        noVotes,
        requiredVotes,
        proposer: proposal.proposer
    });

    // Check vote threshold
    if (yesVotes + noVotes < requiredVotes) {
        elizaLogger.info(`Proposal ${proposal.id} lacks required votes (${yesVotes + noVotes}/${requiredVotes})`);
        return false;
    }

    // Check if passed
    if (yesVotes <= noVotes) {
        elizaLogger.info(`Proposal ${proposal.id} did not pass (Yes: ${yesVotes}, No: ${noVotes})`);
        return false;
    }

    // Execute the action
    try {
        elizaLogger.info(`Executing approved proposal ${proposal.id}`);
        await action(runtime);
        elizaLogger.info(`Successfully executed proposal ${proposal.id}`);
        return true;
    } catch (error) {
        elizaLogger.error(`Error executing vote-gated action:`, {
            error,
            proposal: proposal.id,
            yesVotes,
            noVotes
        });
        return false;
    }
}

export async function executeSwapProposal(runtime: IAgentRuntime, proposal: ProposalContent): Promise<boolean> {
    const text = proposal.text;
    const swapMatch = text.match(/swap\s+(\d+(?:\.\d+)?)\s+(\w+)\s+(?:for|to)\s+(\w+)/i);

    if (!swapMatch) {
        elizaLogger.warn(`Could not parse swap parameters from proposal: ${text}`);
        return false;
    }

    const [, amount, fromTokenSymbol, toTokenSymbol] = swapMatch;

    try {
        const fromToken = getMintAddress(fromTokenSymbol);
        const toToken = getMintAddress(toTokenSymbol);

        elizaLogger.info(`Executing swap proposal:`, {
            amount,
            fromTokenSymbol,
            toTokenSymbol,
            fromToken,
            toToken
        });

        const swapService = new SwapService(runtime as ExtendedAgentRuntime);

        const fromTokenPrice = await swapService.getTokenPrice(fromToken);
        const toTokenPrice = await swapService.getTokenPrice(toToken);

        if (!fromTokenPrice || !toTokenPrice) {
            elizaLogger.error(`Invalid tokens in swap proposal:`, {
                fromToken,
                toToken,
                fromTokenPrice,
                toTokenPrice
            });
            return false;
        }

        const result = await swapService.executeSwap(
            fromToken,
            toToken,
            Number(amount),
            runtime.agentId
        );

        elizaLogger.info(`Swap execution completed`, {
            success: !!result,
            proposal: proposal.id,
            fromToken,
            toToken,
            amount,
            treasuryId: runtime.agentId,
            proposer: proposal.proposer
        });

        return !!result;
    } catch (error) {
        elizaLogger.error("Error executing swap proposal:", {
            error,
            proposal: proposal.id,
            fromTokenSymbol,
            toTokenSymbol,
            amount
        });
        return false;
    }
}

export interface TakeProfitLevel {
    percentage: number;
    sellAmount: number;
    price: number;
}

export interface StopLossConfig {
    percentage: number;
    price: number;
    isTrailing: boolean;
    trailingDistance?: number;
}

export interface StrategyConfig {
    takeProfitLevels: TakeProfitLevel[];
    stopLoss?: StopLossConfig;
}

export type StrategyProposalType = 'take_profit' | 'stop_loss' | 'trailing_stop';

export interface StrategyProposalParams {
    type: StrategyProposalType;
    percentage: number;
    sellAmount?: number; 
}

export interface StandardStrategyProposal {
    token: string;
    actions: StrategyProposalParams[];
}

function isValidPercentage(value: number): boolean {
    return !isNaN(value) && value > 0 && value <= 100;
}

function isValidSellAmount(value: number | undefined): boolean {
    if (value === undefined) return true;
    return !isNaN(value) && value > 0 && value <= 100;
}

export function parseStrategyProposal(text: string): StandardStrategyProposal | null {
    try {
        const tokenMatch = text.match(/for\s+([A-Z0-9]+)\s+(?:token|position)/i);
        if (!tokenMatch) {
            elizaLogger.debug("No token found in strategy proposal");
            return null;
        }

        const token = tokenMatch[1].toUpperCase();

        const actions: StrategyProposalParams[] = [];

        const tpMatches = text.matchAll(/(?:tp|take profit|sell)\s+(?:at\s+)?(\d+(?:\.\d+)?)\s*%(?:\s+(?:sell|size)\s+(\d+(?:\.\d+)?)\s*%)?/gi);
        for (const match of tpMatches) {
            const percentage = parseFloat(match[1]);
            const sellAmount = match[2] ? parseFloat(match[2]) : undefined;

            if (!isValidPercentage(percentage) || !isValidSellAmount(sellAmount)) {
                continue;
            }

            actions.push({
                type: 'take_profit',
                percentage,
                sellAmount: sellAmount || 100
            });
        }

        const slMatch = text.match(/(?:sl|stop loss|stop)\s+(?:at\s+)?(\d+(?:\.\d+)?)\s*%/i);
        if (slMatch) {
            const percentage = parseFloat(slMatch[1]);
            if (isValidPercentage(percentage)) {
                actions.push({
                    type: 'stop_loss',
                    percentage
                });
            }
        }

        const tsMatch = text.match(/(?:trailing stop|trailing sl|ts)\s+(?:at\s+)?(\d+(?:\.\d+)?)\s*%/i);
        if (tsMatch) {
            const percentage = parseFloat(tsMatch[1]);
            if (isValidPercentage(percentage)) {
                actions.push({
                    type: 'trailing_stop',
                    percentage
                });
            }
        }

        if (actions.length === 0) {
            elizaLogger.debug("No valid strategy parameters found");
            return null;
        }

        return { token, actions };

    } catch (error) {
        elizaLogger.error("Error parsing strategy proposal:", error);
        return null;
    }
}

export async function executeStrategyProposal(runtime: IAgentRuntime, proposal: ProposalContent): Promise<boolean> {
    try {
        const parsedStrategy = parseStrategyProposal(proposal.text);
        if (!parsedStrategy) {
            elizaLogger.error("Could not parse strategy proposal:", proposal.text);
            return false;
        }

        const positionTracker = new PositionTracker(runtime);

        const position = await positionTracker.getLatestPosition(runtime.agentId);
        if (!position || position.token !== parsedStrategy.token) {
            elizaLogger.error("No matching position found for token:", parsedStrategy.token);
            return false;
        }

        const strategyConfig: StrategyConfig = {
            takeProfitLevels: parsedStrategy.actions
                .filter(a => a.type === 'take_profit')
                .map(tp => ({
                    percentage: tp.percentage,
                    sellAmount: tp.sellAmount || 100,
                    price: position.entryPrice * (1 + tp.percentage / 100)
                })),
            stopLoss: parsedStrategy.actions.find(a => a.type === 'stop_loss' || a.type === 'trailing_stop')
                ? {
                    percentage: parsedStrategy.actions.find(a => a.type === 'stop_loss' || a.type === 'trailing_stop')!.percentage,
                    price: position.entryPrice * (1 - parsedStrategy.actions.find(a => a.type === 'stop_loss' || a.type === 'trailing_stop')!.percentage / 100),
                    isTrailing: parsedStrategy.actions.find(a => a.type === 'trailing_stop') !== undefined,
                    trailingDistance: parsedStrategy.actions.find(a => a.type === 'trailing_stop')?.percentage
                }
                : undefined
        };

        await positionTracker.attachStrategy(position, strategyConfig);
        return true;

    } catch (error) {
        elizaLogger.error("Error executing strategy proposal:", error);
        return false;
    }
}

export async function executeProposal(runtime: IAgentRuntime, proposal: ProposalContent): Promise<boolean> {
    const text = proposal.text.toLowerCase();

    if (text.includes("swap")) {
        return executeSwapProposal(runtime, proposal);
    }

    if (text.includes("strategy") || text.includes("tp") || text.includes("sl")) {
        return executeStrategyProposal(runtime, proposal);
    }

    elizaLogger.warn("Unknown proposal type:", text);
    return false;
}