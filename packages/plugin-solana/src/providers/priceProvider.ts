import { elizaLogger, IAgentRuntime } from "@elizaos/core";
import { Connection, PublicKey } from "@solana/web3.js";
import axios from "axios";

export interface TokenPrice {
    price: number;
    priceUsd: number;
    volume24h: number;
    timestamp: number;
    source: string;
    error?: string;
    symbol?: string;
}

export class PriceProvider {
    private connection: Connection;
    private runtime: IAgentRuntime;
    private cache: Map<string, { price: TokenPrice; expiry: number }>;
    private readonly CACHE_DURATION = 60 * 1000; // 1 minute cache
    private readonly MAX_RETRIES = 3;
    private readonly RETRY_DELAY = 1000; // 1 second

    constructor(runtime: IAgentRuntime) {
        this.runtime = runtime;
        this.connection = new Connection(
            runtime.getSetting("SOLANA_RPC_URL") || "https://api.mainnet-beta.solana.com"
        );
        this.cache = new Map();
    }

    public async getTokenPrice(tokenAddress: string): Promise<TokenPrice | null> {
        try {
            // Check cache first
            const cached = this.cache.get(tokenAddress);
            if (cached && cached.expiry > Date.now()) {
                return cached.price;
            }

            // Try DexScreener first
            let price = await this.fetchDexScreenerPrice(tokenAddress);
            
            // Fallback to Helius if DexScreener fails
            if (!price) {
                price = await this.fetchHeliusPrice(tokenAddress);
            }

            if (price) {
                // Update cache
                this.cache.set(tokenAddress, {
                    price,
                    expiry: Date.now() + this.CACHE_DURATION
                });
                return price;
            }

            return null;
        } catch (error) {
            elizaLogger.error(`Error fetching price for ${tokenAddress}:`, error);
            return null;
        }
    }

    private async fetchDexScreenerPrice(tokenAddress: string): Promise<TokenPrice | null> {
        try {
            const dexScreenerApiKey = this.runtime.getSetting("DEXSCREENER_API_KEY");
            if (!dexScreenerApiKey) {
                elizaLogger.warn("DexScreener API key not configured");
                return null;
            }

            for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
                try {
                    const response = await axios.get(
                        `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`,
                        {
                            headers: {
                                'X-API-KEY': dexScreenerApiKey
                            }
                        }
                    );

                    if (response.data?.pairs?.[0]) {
                        const pair = response.data.pairs[0];
                        return {
                            price: parseFloat(pair.priceUsd),
                            priceUsd: parseFloat(pair.priceUsd),
                            volume24h: parseFloat(pair.volume24h),
                            timestamp: Date.now(),
                            source: 'dexscreener',
                            symbol: pair.baseToken?.symbol
                        };
                    }
                } catch (error) {
                    if (attempt === this.MAX_RETRIES) throw error;
                    await new Promise(resolve => setTimeout(resolve, this.RETRY_DELAY));
                }
            }
        } catch (error) {
            elizaLogger.error(`DexScreener price fetch failed for ${tokenAddress}:`, error);
        }
        return null;
    }

    private async fetchHeliusPrice(tokenAddress: string): Promise<TokenPrice | null> {
        try {
            const heliusApiKey = this.runtime.getSetting("HELIUS_API_KEY");
            if (!heliusApiKey) {
                elizaLogger.warn("Helius API key not configured");
                return null;
            }

            for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
                try {
                    const response = await axios.post(
                        `https://api.helius.xyz/v0/token-metadata?api-key=${heliusApiKey}`,
                        { mintAccounts: [tokenAddress] }
                    );

                    if (response.data?.[0]?.price_info) {
                        const priceInfo = response.data[0].price_info;
                        return {
                            price: priceInfo.price_per_token,
                            priceUsd: priceInfo.price_per_token,
                            volume24h: priceInfo.volume_24h || 0,
                            timestamp: Date.now(),
                            source: 'helius',
                            symbol: response.data[0].symbol
                        };
                    }
                } catch (error) {
                    if (attempt === this.MAX_RETRIES) throw error;
                    await new Promise(resolve => setTimeout(resolve, this.RETRY_DELAY));
                }
            }
        } catch (error) {
            elizaLogger.error(`Helius price fetch failed for ${tokenAddress}:`, error);
        }
        return null;
    }
} 