// packages/plugin-solana/src/index.ts

export * from "./providers/token.ts";
export * from "./providers/wallet.ts";
export * from "./evaluators/trust.ts";
export * from "./agents/proposal/ProposalAgent.ts";
export * from "./shared/utils/runtime.ts";

// Import and re-export types from base and strategy
import { 
    AgentType,
    AgentMessage,
    BaseContent,
    CharacterName,
    CHARACTER_AGENT_MAPPING,
    TransactionOptions,
    DistributedLock,
    ServiceType,
    IAgentRuntime,
    IMemoryManager
} from "./shared/types/base.ts";
import { StrategyContent } from "./shared/types/strategy.ts";

export {
    AgentType,
    AgentMessage,
    BaseContent,
    CharacterName,
    CHARACTER_AGENT_MAPPING,
    StrategyContent,
    TransactionOptions,
    DistributedLock,
    ServiceType,
    IAgentRuntime,
    IMemoryManager
};

import type { Plugin } from "@elizaos/core";
import { elizaLogger, stringToUuid, UUID, Memory, State, HandlerCallback, Validator } from "@elizaos/core";
import { TokenProvider } from "./providers/token.ts";
import { WalletProvider } from "./providers/wallet.ts";
import { getTokenBalance, getTokenBalances } from "./providers/tokenUtils.ts";
import { walletProvider } from "./providers/wallet.ts";

// Comment out action handler imports since we're using agents
// import { register } from "./actions/register.js";
// import { deposit } from "./actions/deposit.js";
// import { balance } from "./actions/balance.js";
// import { verify } from "./actions/verify.js";
// import { executeSwap } from "./actions/swap.js";
// import transfer from "./actions/transfer.js";
// import { tokeninfo } from "./actions/tokeninfo.js";
// import { propose } from "./actions/propose.js";
// import { vote } from "./actions/vote.js";
// import { closeVote, startProposalMonitoring } from "./actions/closeVote.js";
// import cancelStrategy from "./actions/cancelStrategy.js";
// import { checkProposalStatus } from "./actions/checkProposalStatus.js";
// import { createAndBuyToken, buyPumpToken, CreateAndBuyContent, isCreateAndBuyContent } from "./actions/pumpfun.js";
// import { strategy } from "./actions/strategy.js";

import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { dirname, resolve } from 'path';
import { PublicKey, Keypair, Connection } from "@solana/web3.js";
import { BaseAgent } from "./shared/BaseAgent.ts";
import { MessageBroker } from './shared/MessageBroker.ts';
import { PumpFunSDK } from "pumpdotfun-sdk";

const require = createRequire(import.meta.url);

// Export core functionality
export {
    TokenProvider,
    WalletProvider,
    getTokenBalance,
    getTokenBalances,
    walletProvider,
    BaseAgent
};

// Comment out action handler exports since we're using agents
// export {
//     register,
//     deposit,
//     balance,
//     verify,
//     executeSwap,
//     transfer,
//     tokeninfo,
//     propose,
//     vote,
//     closeVote,
//     startProposalMonitoring,
//     cancelStrategy,
//     checkProposalStatus,
//     createAndBuyToken,
//     buyPumpToken,
//     strategy
// };

// Export constants and utilities
export {
    MessageBroker
};

// Add function to validate Solana addresses
export function validateSolanaAddress(address: string): boolean {
    try {
        new PublicKey(address);
        return true;
    } catch (error) {
        return false;
    }
}

// Create and export the default plugin object
const solanaPlugin: Plugin = {
    name: "solana",
    description: "Solana blockchain integration plugin",
    providers: [walletProvider],
    evaluators: [],
    actions: [],
    services: []
};

export { solanaPlugin };
export default solanaPlugin;