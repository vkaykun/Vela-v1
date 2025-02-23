import { IAgentRuntime, UUID } from "@elizaos/core";
import { StrategyContent } from "../types/strategy.ts";
import { findUniversalContent, queryUniversalContent } from "./search.ts";

export async function findStrategy(
    runtime: IAgentRuntime,
    strategyId: UUID
): Promise<StrategyContent | null> {
    return findUniversalContent<StrategyContent>(
        runtime,
        strategyId,
        "strategy",
        { searchGlobalOnly: true }  // Strategies should always be in global room
    );
}

export async function queryStrategies(
    runtime: IAgentRuntime,
    options: {
        filter?: (strategy: StrategyContent) => boolean;
        sort?: (a: StrategyContent, b: StrategyContent) => number;
        limit?: number;
    } = {}
): Promise<StrategyContent[]> {
    return queryUniversalContent<StrategyContent>(
        runtime,
        "strategy",
        {
            searchGlobalOnly: true,  // Strategies should always be in global room
            ...options
        }
    );
} 