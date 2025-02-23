// packages/plugin-solana/src/services/swapService.ts

import { elizaLogger, IMemoryManager } from "@elizaos/core";
import { Connection, PublicKey } from "@solana/web3.js";
import { getWalletKey } from "../keypairUtils.ts";
import { ENDPOINTS } from "../endpoints.ts";
import { Memory, UUID, stringToUuid } from "@elizaos/core";
import { PriceProvider, TokenPrice } from "../providers/priceProvider.ts";
import { ROOM_IDS } from '../shared/constants.ts';
import { BaseContent } from '../shared/types/base.ts';
import { SwapRequest } from "../shared/types/treasury.ts";
import { jupiterSwap, raydiumSwap, pumpFunSwap } from "../utils/swapUtilsOrAtaHelper.ts";
import { ExtendedAgentRuntime } from "../shared/utils/runtime.ts";

interface TokenPriceInfo {
    price: number;
    symbol?: string;
    error?: string;
    source?: string;
    timestamp: number;
}

interface TokenPriceCache {
    [tokenAddress: string]: TokenPriceInfo;
}

interface DexScreenerResponse {
    pairs?: Array<{
        liquidity?: { usd?: number };
        priceUsd?: string;
        baseToken?: { symbol?: string };
    }>;
}

interface TokenApiResponse {
    tokens: Array<{ address: string; symbol: string; }>;
}

function isTokenApiResponse(data: unknown): data is TokenApiResponse {
    return (
        typeof data === 'object' &&
        data !== null &&
        'tokens' in data &&
        Array.isArray((data as TokenApiResponse).tokens)
    );
}

interface SwapResult {
    signature: string;
    price: number;
}

export class SwapService {
    private runtime: ExtendedAgentRuntime;
    private connection: Connection;
    private priceCache: TokenPriceCache = {};
    private readonly CACHE_DURATION = 30000; // 30 seconds cache duration
    private priceProvider: PriceProvider;

    constructor(runtime: ExtendedAgentRuntime) {
        this.runtime = runtime;
        this.connection = new Connection(
            runtime.getSetting("SOLANA_RPC_URL") || "https://api.mainnet-beta.solana.com"
        );
        this.priceProvider = new PriceProvider(runtime);
    }

    private isCacheValid(tokenAddress: string): boolean {
        const cached = this.priceCache[tokenAddress];
        if (!cached) return false;
        return Date.now() - cached.timestamp < this.CACHE_DURATION;
    }

    public async getTokenPrice(tokenAddress: string): Promise<{ price: number; lastUpdated: number; error?: string }> {
        return { price: 0, lastUpdated: Date.now() };
    }

    private async executeAtomicOperation<T>(operation: () => Promise<T>): Promise<T> {
        const memoryManager = this.runtime?.messageManager;
        await memoryManager?.beginTransaction();
        try {
            const result = await operation();
            await memoryManager?.commitTransaction();
            return result;
        } catch (error) {
            await memoryManager?.rollbackTransaction();
            elizaLogger.error("Error in atomic operation:", {
                error,
                service: 'SwapService'
            });
            throw error;
        }
    }

    public async executeSwap(
        fromToken: string,
        toToken: string,
        amount: number,
        userId: string
    ): Promise<SwapResult> {
        try {
            const { keypair } = await getWalletKey(this.runtime, true);
            if (!keypair) {
                throw new Error("Failed to get wallet keypair");
            }

            // Determine best route
            const route = await this.getBestRoute(fromToken, toToken, amount);

            // Execute swap based on route
            let result;
            switch (route.bestRoute) {
                case "jupiter":
                    result = await jupiterSwap(
                        this.connection,
                        keypair,
                        fromToken,
                        toToken,
                        amount
                    );
                    break;
                case "raydium":
                    result = await raydiumSwap(
                        this.connection,
                        keypair,
                        fromToken,
                        toToken,
                        amount
                    );
                    break;
                case "pumpfun":
                    result = await pumpFunSwap(
                        this.connection,
                        keypair,
                        fromToken,
                        toToken,
                        amount
                    );
                    break;
                default:
                    throw new Error(`Unsupported route: ${route.bestRoute}`);
            }

            return { 
                signature: result.signature, 
                price: result.entryPrice 
            };
        } catch (error) {
            elizaLogger.error("Swap execution failed:", error);
            throw error;
        }
    }

    private async getBestRoute(fromToken: string, toToken: string, amount: number): Promise<{ bestRoute: "jupiter" | "raydium" | "pumpfun" }> {
        try {
            // Try Jupiter first
            const jupiterQuoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${fromToken}&outputMint=${toToken}&amount=${amount}&slippageBps=100&onlyDirectRoutes=true&excludeDexes=Pump,Serum,Saber,Aldrin,Crema,Step,Cropper,GooseFX,Lifinity,Meteora,Invariant,Dradex,Openbook`;
            const jupiterResponse = await fetch(jupiterQuoteUrl, {
                headers: {
                    Accept: "application/json",
                    "Cache-Control": "no-cache",
                },
            });

            if (jupiterResponse.ok) {
                const data = await jupiterResponse.json();
                if (!data.error && data.outAmount) {
                    return { bestRoute: "jupiter" };
                }
            }

            // Try Raydium next
            const raydiumResponse = await fetch("https://api.raydium.io/v2/main/quote", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Cache-Control": "no-cache",
                },
                body: JSON.stringify({
                    inputMint: fromToken,
                    outputMint: toToken,
                    amount: amount.toString(),
                    slippage: 1.0,
                }),
            });

            if (raydiumResponse.ok) {
                const data = await raydiumResponse.json();
                if (!data.error) {
                    return { bestRoute: "raydium" };
                }
            }

            // Finally try PumpFun
            const pumpfunResponse = await fetch(`https://pumpportal.fun/api/pool/${toToken}`);
            if (pumpfunResponse.ok) {
                return { bestRoute: "pumpfun" };
            }

            // Default to Jupiter if no clear winner
            return { bestRoute: "jupiter" };
        } catch (error) {
            elizaLogger.error("Error determining best route:", error);
            // Default to Jupiter on error
            return { bestRoute: "jupiter" };
        }
    }

    async verifyTransaction(signature: string): Promise<boolean> {
        try {
            const tx = await this.connection.getTransaction(signature, {
                commitment: 'confirmed',
                maxSupportedTransactionVersion: 0
            });

            return tx !== null && tx.meta?.err === null;
        } catch (error) {
            elizaLogger.error(`Error verifying transaction ${signature}:`, error);
            return false;
        }
    }

    public async getSupportedTokens(): Promise<Array<{ address: string; symbol: string; }>> {
        try {
            const response = await fetch('https://token.jup.ag/all');
            if (!response.ok) {
                throw new Error('Failed to fetch supported tokens');
            }
            const data = await response.json();
            if (!isTokenApiResponse(data)) {
                throw new Error('Invalid token API response');
            }
            return data.tokens;
        } catch (error) {
            elizaLogger.error('Error fetching supported tokens:', error);
            return [];
        }
    }
}