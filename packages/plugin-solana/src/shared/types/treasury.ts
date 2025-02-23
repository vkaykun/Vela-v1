import { UUID, Content } from "@elizaos/core";
import { BaseContent, ContentStatus, AgentType } from "./base.ts";
import { DAOMemoryType } from "./memory.ts";

export interface TokenBalance {
    token: string;
    amount: string;
    uiAmount: string;
    decimals: number;
    usdValue?: string;
}

export interface DepositContent extends Content {
    type: "deposit_received";
    txSignature: string;
    fromAddress: string;
    toAddress: string;
    amount: string;
    token: string;
    userId?: UUID;
    walletAddress?: string;
}

export interface TransferContent extends BaseContent {
    type: "transfer";
    fromAddress: string;
    toAddress: string;
    amount: string;
    token: string;
    txSignature?: string;
    initiator: UUID;
}

export interface TreasuryBalance {
    totalValueUsd: string;
    lastUpdated: number;
    balances: TokenBalance[];
}

export interface TreasuryTransaction extends BaseContent {
    type: "treasury_transaction";
    txHash: string;
    timestamp: number;
    from: string;
    to: string;
    amount: string;
    token: string;
    status: ContentStatus;
    initiator: UUID;
}

export interface SwapTransaction extends Content {
    type: "treasury_transaction";
    inputToken: string;
    outputToken: string;
    inputAmount: string;
    outputAmount: string;
    slippage?: number;
    route?: string;
    priceImpact?: number;
    price: number;
    status: "pending" | "completed" | "failed";
}

export interface WalletRegistration extends Content {
    type: "wallet_registration";
    walletAddress: string;
    userId: UUID;
    discordId?: string;
    status: ContentStatus;
    createdAt: number;
    updatedAt: number;
}

export interface SwapRequest extends BaseContent {
    type: "swap_request";
    id: UUID;
    fromToken: string;
    toToken: string;
    amount: string;
    reason: "strategy_triggered" | "proposal_passed" | "manual";
    requestId: UUID;
    sourceAgent: AgentType;
    sourceId: UUID;
    status: ContentStatus;
    agentId: UUID;
    createdAt: number;
    updatedAt: number;
    text: string;
}

export interface PendingDeposit extends Content {
    type: "deposit_received";
    txSignature: string;
    fromAddress: string;
    toAddress: string;
    amount: string;
    token: string;
    verificationTimestamp?: number;
}

export interface PendingTransaction extends Content {
    type: "pending_transaction";
    transactionId: string;
    transactionType: "swap" | "transfer";
    fromToken: string;
    amount: string;
    status: ContentStatus;
    timestamp: number;
    expiresAt: number;
    createdAt: number;
    updatedAt: number;
} 