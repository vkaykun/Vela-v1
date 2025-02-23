// packages/plugin-solana/src/utils/depositUtils.ts

import { Connection, ParsedTransactionWithMeta, PublicKey } from "@solana/web3.js";
import { elizaLogger, IAgentRuntime, stringToUuid, Content } from "@elizaos/core";
import { getWalletKey } from "../keypairUtils.ts";

export interface Deposit {
    amountSOL: number;
    fromAddress: string;
    timestamp: number;
    txSignature: string;
}

export interface DepositContent extends Content {
    type: "deposit";
    status: "completed" | "pending";
    amountSOL: number;
    timestamp: number;
    txSignature: string;
    fromAddress: string;
    discordId?: string;
}

export async function verifyAndRecordDeposit(
    txSignature: string,
    runtime: IAgentRuntime
): Promise<{ amountSOL: number; fromAddress: string } | null> {
    try {
        // Check if this transaction was already processed - do this first
        const existingMemories = await runtime.messageManager.getMemories({
            roomId: runtime.agentId,
            count: 1000
        });

        const alreadyProcessed = existingMemories.some(mem => 
            mem.content.type === "deposit" && 
            mem.content.txSignature === txSignature
        );

        if (alreadyProcessed) {
            elizaLogger.warn("Transaction already processed:", txSignature);
            return null;
        }

        const connection = new Connection(
            runtime.getSetting("SOLANA_RPC_URL") || "https://api.mainnet-beta.solana.com",
            "confirmed"
        );

        // Get our wallet
        const { publicKey } = await getWalletKey(runtime, false);
        if (!publicKey) {
            elizaLogger.error("No wallet configured for deposit verification");
            return null;
        }

        // Fetch transaction
        const tx = await connection.getParsedTransaction(txSignature, "confirmed");
        if (!tx) {
            elizaLogger.warn("Transaction not found:", txSignature);
            return null;
        }

        // Process transaction to find deposits to our wallet
        const deposits = processTransaction(tx, publicKey.toBase58());
        if (deposits.length === 0) {
            elizaLogger.warn("No deposits found in transaction:", txSignature);
            return null;
        }

        // For each deposit, try to find the registered user
        for (const deposit of deposits) {
            const registrations = await runtime.messageManager.getMemories({
                roomId: runtime.agentId,
                count: 1000
            });

            // Find matching wallet registration
            const walletRegistration = registrations.find(mem =>
                mem.content.type === "wallet_registration" &&
                mem.content.walletAddress === deposit.fromAddress &&
                mem.content.status === "executed"
            );

            if (walletRegistration) {
                // Record the deposit
                const memoryId = stringToUuid(`deposit-${txSignature}-${Date.now()}`);
                await runtime.messageManager.createMemory({
                    id: memoryId,
                    content: {
                        text: `Received deposit of ${deposit.amountSOL} SOL from ${deposit.fromAddress}`,
                        type: "deposit",
                        status: "completed",
                        amountSOL: deposit.amountSOL,
                        timestamp: Date.now(),
                        txSignature: txSignature,
                        fromAddress: deposit.fromAddress,
                        discordId: (walletRegistration.content as any).discordId || walletRegistration.userId,
                    } as DepositContent,
                    roomId: runtime.agentId,
                    userId: walletRegistration.userId,
                    agentId: runtime.agentId,
                });

                return {
                    amountSOL: deposit.amountSOL,
                    fromAddress: deposit.fromAddress
                };
            }
        }

        elizaLogger.warn("No matching registration found for deposit from:", deposits[0].fromAddress);
        return null;

    } catch (error) {
        elizaLogger.error("Error verifying deposit:", error);
        return null;
    }
}

export async function getBalanceWithUpdates(runtime: IAgentRuntime): Promise<{
    totalBalance: number;
    contributors: Array<{
        userId: string;
        username?: string;
        totalAmount: number;
        lastDeposit: number;
        depositCount: number;
        transactions: Array<{
            txSignature: string;
            amount: number;
            timestamp: number;
        }>;
    }>;
}> {
    try {
        const connection = new Connection(
            runtime.getSetting("SOLANA_RPC_URL") || "https://api.mainnet-beta.solana.com"
        );

        // Get current wallet balance
        const { publicKey } = await getWalletKey(runtime, false);
        if (!publicKey) throw new Error("No wallet configured");

        const balance = await connection.getBalance(publicKey);
        const totalBalance = balance / 1e9;

        // Get all recorded deposits
        const deposits = await runtime.messageManager.getMemories({
            roomId: runtime.agentId,
            count: 1000,
        });

        // Process deposits and group by user
        const contributorsMap = new Map<string, {
            userId: string;
            username?: string;
            totalAmount: number;
            lastDeposit: number;
            depositCount: number;
            transactions: Array<{
                txSignature: string;
                amount: number;
                timestamp: number;
            }>;
        }>();

        for (const deposit of deposits) {
            const content = deposit.content as DepositContent;
            if (content.type !== "deposit" || content.status !== "completed") continue;

            const userId = deposit.userId;
            const existing = contributorsMap.get(userId) || {
                userId,
                totalAmount: 0,
                lastDeposit: 0,
                depositCount: 0,
                transactions: []
            };

            existing.totalAmount += content.amountSOL;
            existing.lastDeposit = Math.max(existing.lastDeposit, content.timestamp);
            existing.depositCount++;
            existing.transactions.push({
                txSignature: content.txSignature,
                amount: content.amountSOL,
                timestamp: content.timestamp
            });

            contributorsMap.set(userId, existing);
        }

        // Convert to array and sort by total amount
        const contributors = Array.from(contributorsMap.values())
            .sort((a, b) => b.totalAmount - a.totalAmount);

        // Try to fetch Discord usernames if available
        if (runtime.clients?.discord?.client) {
            for (const contributor of contributors) {
                try {
                    const user = await runtime.clients.discord.client.users.fetch(contributor.userId);
                    contributor.username = user.username;
                } catch (error) {
                    elizaLogger.warn(`Could not fetch username for user ${contributor.userId}:`, error);
                    contributor.username = "Unknown User";
                }
            }
        }

        return {
            totalBalance,
            contributors
        };

    } catch (error) {
        elizaLogger.error("Error getting balance with updates:", error);
        throw error;
    }
}

function processTransaction(
    tx: ParsedTransactionWithMeta,
    poolAddress: string
): Array<{ amountSOL: number; fromAddress: string }> {
    const deposits: Array<{ amountSOL: number; fromAddress: string }> = [];

    if (!tx.meta || !tx.transaction.message.accountKeys) return deposits;

    tx.meta.preBalances.forEach((preBal, index) => {
        const postBal = tx.meta!.postBalances[index];
        const account = tx.transaction.message.accountKeys[index];
        const accountPubkey = new PublicKey(account.pubkey);

        // If this is our address and balance increased
        if (accountPubkey.toBase58() === poolAddress && postBal > preBal) {
            // find the source
            const sourceIndex = tx.meta!.preBalances.findIndex(
                (oldBal, idx) => {
                    const newBal = tx.meta!.postBalances[idx];
                    return oldBal > newBal && idx !== index;
                }
            );
            if (sourceIndex >= 0) {
                const sourceAccount =
                    tx.transaction.message.accountKeys[sourceIndex];
                const sourcePubkey = new PublicKey(sourceAccount.pubkey);
                const sourceAddress = sourcePubkey.toBase58();

                const amountSOL = (postBal - preBal) / 1e9;
                deposits.push({
                    amountSOL,
                    fromAddress: sourceAddress,
                });
            }
        }
    });

    return deposits;
}