// packages/plugin-solana/src/actions/tokeninfo.ts

import {
    Action,
    ActionExample,
    HandlerCallback,
    Memory,
    State,
    elizaLogger,
} from "@elizaos/core";
import { TokenProvider } from "../providers/token.js";
import { WalletProvider } from "../providers/wallet.js";
import { Connection, PublicKey } from "@solana/web3.js";
import { ENDPOINTS } from "../endpoints.js";
import { isValidSolanaAddress } from "../utils/commandValidation.js";
import { validateActionCommand } from "../utils/governanceUtils.js";
import { ExtendedAgentRuntime } from "../shared/utils/runtime.ts";

const examples: ActionExample[][] = [
    [
        {
            user: "user",
            content: {
                text: "<@1330078038200680499> whats the price of BONK",
                action: "tokeninfo"
            }
        },
        {
            user: "Vela",
            content: {
                text: "BONK Price: $0.00001234\n24h Change: +5.2%\nMarket Cap: $45.6M\nMost Liquid on: Raydium\nContract: DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
                action: "tokeninfo"
            }
        }
    ],
    [
        {
            user: "user",
            content: {
                text: "@1330078038200680499 show me JUP volume",
                action: "tokeninfo"
            }
        },
        {
            user: "Vela",
            content: {
                text: "JUP 24h Volume: $15.2M\nTop Trading Pairs:\n1. Jupiter: $8.5M (55.9%)\n2. Raydium: $4.2M (27.6%)\n3. Orca: $2.5M (16.5%)",
                action: "tokeninfo"
            }
        }
    ],
    [
        {
            user: "user",
            content: {
                text: "what's the price of EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
                action: "tokeninfo"
            }
        },
        {
            user: "Vela",
            content: {
                text: "USDC Price: $1.00\n24h Change: +0.01%\nSource: DexScreener (Raydium)\nMarket Cap: $43.2B",
                action: "tokeninfo"
            }
        }
    ],
    [
        {
            user: "user",
            content: {
                text: "show me volume for USDC",
                action: "tokeninfo"
            }
        },
        {
            user: "Vela",
            content: {
                text: "USDC 24h Volume: $123.4M\nTop Trading Pairs:\n1. USDC/SOL: $45.6M (Raydium)\n2. USDC/BONK: $32.1M (Orca)\n3. USDC/JUP: $12.3M (Jupiter)",
                action: "tokeninfo"
            }
        }
    ],
    [
        {
            user: "user",
            content: {
                text: "how much liquidity does bonk have",
                action: "tokeninfo"
            }
        },
        {
            user: "Vela",
            content: {
                text: "BONK Total Liquidity: $50M\nTop Liquidity Pools:\n1. BONK/SOL: $20M (Raydium)\n2. BONK/USDC: $15M (Orca)\n3. BONK/RAY: $5M (Raydium)",
                action: "tokeninfo"
            }
        }
    ],
    [
        {
            user: "user",
            content: {
                text: "price of 6d5zHW5B8RkGKd51Lpb9RqFQSqDudr9GJgZ1SgQZpump",
                action: "tokeninfo"
            }
        },
        {
            user: "Vela",
            content: {
                text: "PUMP Token Price: $0.00123\n24h Change: +45.6%\nSource: PumpFun DEX\nMarket Cap: $234.5K\nLiquidity: $45.6K\n\n⚠️ PumpFun Token Warning:\n• High volatility\n• Limited liquidity\n• DYOR before trading",
                action: "tokeninfo"
            }
        }
    ],
    [
        {
            user: "user",
            content: {
                text: "volume for token ending in pump",
                action: "tokeninfo"
            }
        },
        {
            user: "Vela",
            content: {
                text: "⚠️ Please provide the full token address for PumpFun tokens. These tokens often share similar names but have different addresses ending in 'pump'.\n\nExample: 6d5zHW5B8RkGKd51Lpb9RqFQSqDudr9GJgZ1SgQZpump",
                action: "tokeninfo"
            }
        }
    ],
    [
        {
            user: "user",
            content: {
                text: "mc + liq for 6d5zHW5B8RkGKd51Lpb9RqFQSqDudr9GJgZ1SgQZpump",
                action: "tokeninfo"
            }
        },
        {
            user: "Vela",
            content: {
                text: "PUMP Token Metrics (PumpFun):\nMarket Cap: $234.5K\nFully Diluted: $345.6K\nTotal Liquidity: $45.6K\n\nTop Pairs:\n1. PUMP/SOL: $30.2K\n2. PUMP/USDC: $15.4K\n\nContract: 6d5zHW5B8RkGKd51Lpb9RqFQSqDudr9GJgZ1SgQZpump\n\n⚠️ Warning: Low liquidity token - trade with caution",
                action: "tokeninfo"
            }
        }
    ],
    [
        {
            user: "user",
            content: {
                text: "what is the 24hr volume for BONK",
                action: "tokeninfo"
            }
        },
        {
            user: "Vela",
            content: {
                text: "BONK 24h Volume:\n$12.5M\nTop Trading Pairs:\n• BONK/USDC: $8.2M\n• BONK/SOL: $4.3M",
                action: "tokeninfo"
            }
        }
    ],
    [
        {
            user: "user",
            content: {
                text: "what is the liquidity of JUP",
                action: "tokeninfo"
            }
        },
        {
            user: "Vela",
            content: {
                text: "JUP Total Liquidity: $45.2M\nTop Pools:\n• JUP/USDC: $32.1M\n• JUP/SOL: $13.1M",
                action: "tokeninfo"
            }
        }
    ],
    [
        {
            user: "user",
            content: {
                text: "whats the price of SOL",
                action: "tokeninfo"
            }
        },
        {
            user: "Vela",
            content: {
                text: "The price of SOL is $95.42",
                action: "tokeninfo"
            }
        }
    ],
    [
        {
            user: "user",
            content: {
                text: "what is the market cap of RAY",
                action: "tokeninfo"
            }
        },
        {
            user: "Vela",
            content: {
                text: "RAY Market Cap:\nFully Diluted: $245.8M\nCirculating: $198.3M\nTotal Supply: 555,000,000 RAY",
                action: "tokeninfo"
            }
        }
    ],
    [
        {
            user: "user",
            content: {
                text: "whats the price of 6d5zHW5B8RkGKd51Lpb9RqFQSqDudr9GJgZ1SgQZpump",
                action: "tokeninfo"
            }
        },
        {
            user: "Vela",
            content: {
                text: "⚠️ PumpFun Token Alert ⚠️\nPrice: $0.00001234\n24h Volume: $15.2K\nLiquidity: $8.5K\n\nCAUTION: This is a PumpFun token. These tokens are highly volatile and risky. Always DYOR and invest responsibly.",
                action: "tokeninfo"
            }
        }
    ],
    [
        {
            user: "user",
            content: {
                text: "what is the supply of COPE",
                action: "tokeninfo"
            }
        },
        {
            user: "Vela",
            content: {
                text: "COPE Supply Metrics:\nTotal Supply: 10,000,000 COPE\nCirculating: 8,500,000 COPE\nHolders: 12,345\nTop 10 Holders: 45% of supply",
                action: "tokeninfo"
            }
        }
    ],
    [
        {
            user: "user",
            content: {
                text: "@1330078038200680499 whats the price of SOL",
                action: "tokeninfo"
            }
        },
        {
            user: "Vela",
            content: {
                text: "SOL Price: $95.42\n24h Change: +3.2%\nMarket Cap: $41.2B\nMost Liquid on: Raydium\nContract: So11111111111111111111111111111111111111112",
                action: "tokeninfo"
            }
        }
    ]
];

// Common token query patterns
const QUERY_PATTERNS = {
    PRICE: [
        /^(?:whats|what'?s|what\s+is)\s+(?:the\s+)?price\s+(?:for|of|on)?\s*(.*)/i,
        /(?:what'?s|whats|what is|show|get|check|tell me|gimme)?\s*(?:the)?\s*(?:current|latest)?\s*(?:price|cost|rate|value)\s*(?:for|of|on)?\s*(.*)/i,
        /how much (?:is|does|do)\s*(.*?)\s*(?:cost|go for|trade for|trade at|worth)/i,
        /(?:price|cost|rate|value)\s*(.*)/i
    ],
    VOLUME: [
        /(?:what'?s|what is|show|get|check|tell me|gimme)?\s*(?:the)?\s*(?:current|latest|24h|daily)?\s*(?:volume|vol|trading volume|24h vol)\s*(?:for|of|on)?\s*(.*)/i,
        /how much (?:volume|trading|activity)\s*(?:does|do|is there for)?\s*(.*)/i,
        /(?:volume|vol|24h vol)\s*(.*)/i
    ],
    LIQUIDITY: [
        /(?:what'?s|what is|show|get|check|tell me|gimme)?\s*(?:the)?\s*(?:current|total)?\s*(?:liquidity|liq|tvl)\s*(?:for|of|on)?\s*(.*)/i,
        /how much (?:liquidity|liq|tvl)\s*(?:does|do|is there for)?\s*(.*)/i,
        /(?:liquidity|liq|tvl)\s*(.*)/i
    ],
    HOLDERS: [
        /(?:what'?s|what is|show|get|check|tell me|gimme)?\s*(?:the)?\s*(?:holder|holders|holding|wallet|wallets)\s*(?:count|number|distribution|info)?\s*(?:for|of|on)?\s*(.*)/i,
        /how many (?:holders|wallets|people hold|accounts hold)\s*(.*)/i,
        /(?:holders|holding|wallets)\s*(.*)/i
    ],
    MCAP: [
        /(?:what'?s|what is|show|get|check|tell me|gimme)?\s*(?:the)?\s*(?:current|total)?\s*(?:market cap|mcap|market value|valuation)\s*(?:for|of|on)?\s*(.*)/i,
        /how much (?:is|does)\s*(.*?)\s*(?:market cap|mcap|worth)/i,
        /(?:market cap|mcap)\s*(.*)/i
    ]
};

// Add exclusion patterns to avoid clashing with other actions
const EXCLUSION_PATTERNS = [
    /^!(?:balance|register|verify|deposit)/i,
    /^(?:transfer|send)\s+[\d.]+\s*(?:sol|usdc)/i,
    /^swap\s+[\d.]+/i,
    /^set\s+(?:tp|sl)/i
];

// Helper function to format numbers with commas and fixed decimals
function formatNumber(num: number, decimals: number = 2, abbreviate: boolean = false): string {
    if (abbreviate) {
        const abbreviations = [
            { value: 1e12, symbol: "T" },
            { value: 1e9, symbol: "B" },
            { value: 1e6, symbol: "M" },
            { value: 1e3, symbol: "K" }
        ];

        const item = abbreviations.find(item => num >= item.value);
        if (item) {
            return (num / item.value).toFixed(decimals) + item.symbol;
        }
    }

    return new Intl.NumberFormat('en-US', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals
    }).format(num);
}

// Helper to detect query type and extract token identifier
function parseQuery(text: string): { type: string; tokenIdentifier: string } | null {
    try {
        // Remove any leading/trailing whitespace and log original input
        text = text.trim();
        elizaLogger.debug("Original query text:", { text });

        // Handle Discord mentions by removing them
        const originalText = text;
        text = text.replace(/^(?:<@!?\d+>|@\d+)\s*/, '');
        if (text !== originalText) {
            elizaLogger.debug("Mention removed:", {
                before: originalText,
                after: text
            });
        }

        // Clean and normalize the text
        text = text.toLowerCase();
        elizaLogger.debug("Normalized text:", { text });

        // Check exclusion patterns first
        if (EXCLUSION_PATTERNS.some(pattern => pattern.test(text))) {
            elizaLogger.debug("Query matched exclusion pattern");
            return null;
        }

        // Try each query type
        for (const [queryType, patterns] of Object.entries(QUERY_PATTERNS)) {
            for (const pattern of patterns) {
                const match = text.match(pattern);
                elizaLogger.debug("Testing pattern:", {
                    type: queryType,
                    pattern: pattern.toString(),
                    matched: !!match
                });

                if (match && match[1]) {
                    // Clean up the token identifier
                    const tokenPart = match[1].trim()
                        .replace(/^[$]/, '')
                        .replace(/[^a-z0-9]/g, '');

                    elizaLogger.debug("Token match found:", {
                        type: queryType,
                        rawToken: match[1],
                        cleanedToken: tokenPart
                    });

                    // Additional validation
                    if (tokenPart.length < 2 ||
                        tokenPart.includes('sol to') ||
                        tokenPart.includes('usdc to') ||
                        /^set\s+/.test(tokenPart) ||
                        /^[\d.]+$/.test(tokenPart)) {
                        elizaLogger.debug("Token validation failed:", { tokenPart });
                        continue;
                    }

                    return {
                        type: queryType,
                        tokenIdentifier: tokenPart
                    };
                }
            }
        }

        elizaLogger.debug("No valid token query pattern matched");
        return null;
    } catch (error) {
        elizaLogger.error("Error parsing token query:", error);
        return null;
    }
}

// Helper to resolve token address from identifier (address or symbol)
async function resolveTokenAddress(identifier: string): Promise<string | null> {
    // If it's already a valid address, return it
    if (isValidSolanaAddress(identifier)) {
        return identifier;
    }

    // Try to resolve common token symbols
    const commonTokens: { [key: string]: string } = {
        'usdc': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        'sol': 'So11111111111111111111111111111111111111112',
        'bonk': 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
        'wen': 'WENWENvqqNya429ubCdR81ZmD69brwQaaBYY6p3LCpk',
        'jup': 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
        'orca': 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE',
        'ray': '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
        'msol': 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So'
    };

    const normalizedInput = identifier.toLowerCase().replace(/[^a-z0-9]/g, '');
    return commonTokens[normalizedInput] || null;
}

export const tokeninfo: Action = {
    name: "tokeninfo",
    description: "Get information about a token including price, volume, and liquidity",
    examples,
    similes: ["token price", "token info", "token details", "price check"],
    suppressInitialMessage: true,
    validate: async (runtime: ExtendedAgentRuntime, message: Memory) => {
        const result = validateActionCommand(
            message,
            runtime,
            "tokeninfo",
            [
                "what's the price of",
                "whats the price of",
                "show me price for",
                "price of",
                "show me volume for",
                "volume for",
                "how much liquidity does",
                "what is the liquidity of",
                "mc + liq for",
                "market cap of",
                "what is the supply of",
                "supply of"
            ],
            ["price", "volume", "liquidity", "mc", "supply"]
        );

        if (!result.isValid) {
            return false;
        }

        // Parse query to get token identifier
        const query = parseQuery(result.extractedText || "");
        if (!query) {
            elizaLogger.debug("Could not parse token query");
            return false;
        }

        return true;
    },
    handler: async (
        runtime: ExtendedAgentRuntime,
        message: Memory,
        state: State | undefined,
        _options: { [key: string]: unknown } = {},
        callback?: HandlerCallback
    ): Promise<boolean> => {
        try {
            // Handle undefined state
            if (!state) {
                callback?.({
                    text: "Error: State is required for this operation."
                });
                return false;
            }

            // Validate and extract query
            const result = validateActionCommand(
                message,
                runtime,
                "tokeninfo",
                [
                    "what's the price of",
                    "whats the price of",
                    "show me price for",
                    "price of",
                    "show me volume for",
                    "volume for",
                    "how much liquidity does",
                    "what is the liquidity of",
                    "mc + liq for",
                    "market cap of",
                    "what is the supply of",
                    "supply of"
                ],
                ["price", "volume", "liquidity", "mc", "supply"]
            );

            const query = parseQuery(result.extractedText || "");
            if (!query) {
                callback?.({
                    text: "I couldn't understand which token you're asking about. Please specify a token symbol (like SOL or BONK) or address."
                });
                return false;
            }

            elizaLogger.debug("Resolving token address for:", {
                type: query.type,
                tokenIdentifier: query.tokenIdentifier
            });

            const tokenAddress = await resolveTokenAddress(query.tokenIdentifier);
            if (!tokenAddress) {
                callback?.({
                    text: `I couldn't find a token matching "${query.tokenIdentifier}". Please provide a valid token address or symbol.`
                });
                return false;
            }

            // Initialize providers
            const connection = new Connection(ENDPOINTS.HELIUS_RPC);
            const walletProvider = new WalletProvider(connection, new PublicKey(tokenAddress));
            const tokenProvider = new TokenProvider(tokenAddress, walletProvider, runtime.cacheManager);

            // Fetch token data from appropriate sources
            const [dexScreenerData, tokenData] = await Promise.all([
                tokenProvider.fetchDexScreenerData(),
                tokenProvider.fetchTokenCodex()
            ]);

            if (!dexScreenerData.pairs || dexScreenerData.pairs.length === 0) {
                callback?.({
                    text: `No trading data available for ${tokenData.symbol || "this token"}.`
                });
                return false;
            }

            // Sort pairs by liquidity
            const sortedPairs = dexScreenerData.pairs.sort((a, b) =>
                Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0)
            );
            const bestPair = sortedPairs[0];

            let responseText = "";
            const symbol = tokenData.symbol || "Unknown Token";

            // Calculate total volume
            const totalVolume = sortedPairs.reduce((sum, pair) =>
                sum + Number(pair.volume?.h24 || 0), 0
            );

            switch (query.type) {
                case "PRICE":
                    const priceChange = Number(bestPair.priceChange?.h24 || 0);
                    const priceChangeSymbol = priceChange >= 0 ? "+" : "";
                    responseText = `${symbol} Price: $${formatNumber(Number(bestPair.priceUsd))}\n` +
                                 `24h Change: ${priceChangeSymbol}${formatNumber(priceChange)}%\n` +
                                 `Market Cap: $${formatNumber(Number(bestPair.marketCap), 2, true)}\n` +
                                 `Most Liquid on: ${bestPair.dexId}\n` +
                                 `Contract: ${tokenAddress}`;
                    break;

                case "VOLUME":
                    responseText = `${symbol} 24h Volume: $${formatNumber(totalVolume, 2, true)}\n` +
                                 `Top Trading Pairs:\n`;

                    sortedPairs.slice(0, 3).forEach((pair, index) => {
                        const pairVolume = Number(pair.volume?.h24 || 0);
                        const pctOfTotal = (pairVolume / totalVolume * 100).toFixed(1);
                        responseText += `${index + 1}. ${pair.dexId}: $${formatNumber(pairVolume, 2, true)} (${pctOfTotal}%)\n`;
                    });
                    break;

                case "LIQUIDITY":
                    const totalLiquidity = sortedPairs.reduce((sum, pair) =>
                        sum + Number(pair.liquidity?.usd || 0), 0
                    );

                    responseText = `${symbol} Total Liquidity: $${formatNumber(totalLiquidity, 2, true)}\n` +
                                 `Top Liquidity Pools:\n`;

                    sortedPairs.slice(0, 3).forEach((pair, index) => {
                        const pairLiq = Number(pair.liquidity?.usd || 0);
                        const pctOfTotal = (pairLiq / totalLiquidity * 100).toFixed(1);
                        responseText += `${index + 1}. ${pair.dexId}: $${formatNumber(pairLiq, 2, true)} (${pctOfTotal}%)\n`;
                    });
                    break;

                case "MCAP":
                    const mcap = Number(bestPair.marketCap || 0);
                    const fdv = Number(bestPair.fdv || 0);

                    responseText = `${symbol} Market Metrics:\n` +
                                 `Market Cap: $${formatNumber(mcap, 2, true)}\n` +
                                 `Fully Diluted Value: $${formatNumber(fdv, 2, true)}\n` +
                                 `Price: $${formatNumber(Number(bestPair.priceUsd))}\n` +
                                 `24h Volume/MCap: ${formatNumber((totalVolume / mcap) * 100, 2)}%`;
                    break;

                case "HOLDERS":
                    // Use Helius for holder data
                    const tokenMetadata = await connection.getTokenSupply(new PublicKey(tokenAddress));
                    responseText = `${symbol} Supply Metrics:\n` +
                                 `Total Supply: ${formatNumber(Number(tokenMetadata.value.amount), tokenMetadata.value.decimals)}\n` +
                                 `Decimals: ${tokenMetadata.value.decimals}\n` +
                                 `Contract: ${tokenAddress}`;
                    break;
            }

            callback?.({
                text: responseText
            });
            return true;

        } catch (error) {
            elizaLogger.error("Error in tokeninfo handler:", error);
            callback?.({
                text: "Sorry, I encountered an error getting token information. Please try again."
            });
            return false;
        }
    }
};