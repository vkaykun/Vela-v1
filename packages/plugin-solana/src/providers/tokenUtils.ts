// packages/plugin-solana/src/providers/tokenUtils.ts

import { getAccount, getAssociatedTokenAddress } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import { elizaLogger } from "@elizaos/core";
import { ENDPOINTS } from "../endpoints.ts";

interface DexScreenerResponse {
    pairs?: Array<{
        liquidity?: { usd?: number };
        priceUsd?: string;
    }>;
}

export async function getTokenPrice(tokenAddress: string): Promise<number | null> {
    try {
        const response = await fetch(
            `${ENDPOINTS.DEXSCREENER_API}/tokens/${tokenAddress}`
        );

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json() as DexScreenerResponse;
        if (!data.pairs || data.pairs.length === 0) {
            throw new Error("No price data available");
        }

        // Sort pairs by liquidity to get the most liquid pair
        const sortedPairs = data.pairs.sort((a, b) => Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0));
        const bestPair = sortedPairs[0];

        if (!bestPair?.priceUsd) {
            throw new Error("No price data in most liquid pair");
        }

        return Number(bestPair.priceUsd);
    } catch (error) {
        elizaLogger.error(`Error getting DexScreener price for ${tokenAddress}:`, error);
        return null;
    }
}

async function getTokenBalance(
    connection: Connection,
    walletPublicKey: PublicKey,
    tokenMintAddress: PublicKey
): Promise<number> {
    const tokenAccountAddress = await getAssociatedTokenAddress(
        tokenMintAddress,
        walletPublicKey
    );

    try {
        const tokenAccount = await getAccount(connection, tokenAccountAddress);
        const tokenAmount = tokenAccount.amount as unknown as number;
        return tokenAmount;
    } catch (error) {
        elizaLogger.error(
            `Error retrieving balance for token: ${tokenMintAddress.toBase58()}`,
            error
        );
        return 0;
    }
}

async function getTokenBalances(
    connection: Connection,
    walletPublicKey: PublicKey
): Promise<{ [tokenName: string]: number }> {
    const tokenBalances: { [tokenName: string]: number } = {};

    // Add the token mint addresses you want to retrieve balances for
    const tokenMintAddresses = [
        new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), // USDC
        new PublicKey("So11111111111111111111111111111111111111112"), // SOL
        // Add more token mint addresses as needed
    ];

    for (const mintAddress of tokenMintAddresses) {
        const tokenName = getTokenName(mintAddress);
        const balance = await getTokenBalance(
            connection,
            walletPublicKey,
            mintAddress
        );
        tokenBalances[tokenName] = balance;
    }

    return tokenBalances;
}

function getTokenName(mintAddress: PublicKey): string {
    // Implement a mapping of mint addresses to token names
    const tokenNameMap: { [mintAddress: string]: string } = {
        EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
        So11111111111111111111111111111111111111112: "SOL",
        // Add more token mint addresses and their corresponding names
    };

    return tokenNameMap[mintAddress.toBase58()] || "Unknown Token";
}

export { getTokenBalance, getTokenBalances };
