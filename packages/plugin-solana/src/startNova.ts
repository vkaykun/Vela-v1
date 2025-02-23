// packages/plugin-solana/src/startNova.ts

import { elizaLogger, AgentRuntime, ModelProviderName, stringToUuid, IMemoryManager, Memory } from "@elizaos/core";
import { DiscordClientInterface } from '@elizaos/client-discord';
import { DirectClientInterface } from '@elizaos/client-direct';
import { DatabaseConfigValidator } from "./shared/utils/databaseConfig.ts";
import { getProcessDatabase } from "./shared/database.ts";
import { AGENT_IDS } from './shared/constants.ts';
import { MemorySyncManager } from "./shared/memory/MemorySyncManager";
import { MessageBroker } from './shared/MessageBroker.ts';
import { IAgentRuntime } from './shared/types/base.ts';
import { createSolanaRuntime, ExtendedMemoryManager } from './shared/utils/runtime.ts';
import { MemoryManager } from './shared/memory/index.ts';
import path from "path";
import fs from "fs";
import dotenv from "dotenv";
import { EventEmitter } from "events";
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { PostgresDatabaseAdapter } from '@elizaos/adapter-postgres';
import { IDatabaseAdapter } from '@elizaos/core';
import { UUID } from '@elizaos/core';
import { CacheManager } from "@elizaos/core";
import { DatabaseCacheManager } from "./shared/cache";
import { ExtendedMemoryManager as NovaExtendedMemoryManager } from "./shared/memory/ExtendedMemoryManager";
import { IExtendedMemoryManager } from "./shared/types/base";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
// First load main .env from repo root
dotenv.config({ path: path.join(__dirname, "../../../.env") });
elizaLogger.info("Loaded main .env file");

// Log state after main .env
elizaLogger.info("Environment after main .env:", {
    SOLANA_PUBLIC_KEY: process.env.SOLANA_PUBLIC_KEY ? "Present" : "Missing",
    SOLANA_RPC_URL: process.env.SOLANA_RPC_URL ? "Present" : "Missing"
});

// Then load Nova-specific environment variables
const novaEnvPath = path.join(__dirname, "..", ".env.nova");
elizaLogger.info("Loading .env.nova from:", novaEnvPath);
elizaLogger.info("File exists check:", fs.existsSync(novaEnvPath));
const novaEnvResult = dotenv.config({ path: novaEnvPath, override: true });
elizaLogger.info("Nova env loading result:", {
    error: novaEnvResult.error?.message,
    parsed: novaEnvResult.parsed ? Object.keys(novaEnvResult.parsed) : null
});

// Log final state to verify both sets loaded
elizaLogger.info("Final environment state:", {
    // Discord vars from .env.nova
    DISCORD_TOKEN: process.env.DISCORD_API_TOKEN ? "Present" : "Missing",
    DISCORD_APP_ID: process.env.DISCORD_APPLICATION_ID ? "Present" : "Missing",
    // Solana vars from main .env
    SOLANA_PUBLIC_KEY: process.env.SOLANA_PUBLIC_KEY ? "Present" : "Missing",
    SOLANA_RPC_URL: process.env.SOLANA_RPC_URL ? "Present" : "Missing"
});

if (novaEnvResult.error) {
    elizaLogger.error("Error loading .env.nova:", novaEnvResult.error);
} else {
    elizaLogger.info("Successfully loaded .env.nova");
}

// Log all environment variable keys
elizaLogger.info("All available environment variables:", {
    keys: Object.keys(process.env),
    discordRelated: Object.keys(process.env).filter(key => key.toLowerCase().includes('discord'))
});

elizaLogger.info("Environment variables after loading:", {
    SOLANA_PUBLIC_KEY: process.env.SOLANA_PUBLIC_KEY,
    SOLANA_RPC_URL: process.env.SOLANA_RPC_URL,
    SOLANA_CLUSTER: process.env.SOLANA_CLUSTER,
    BASE_MINT: process.env.BASE_MINT,
    NODE_ENV: process.env.NODE_ENV
});

// Add global unhandled rejection handler
process.on('unhandledRejection', (reason, promise) => {
    elizaLogger.error('Unhandled Rejection at:', {
        promise,
        reason: reason instanceof Error ? {
            message: reason.message,
            stack: reason.stack,
            name: reason.name
        } : reason
    });
});

async function startNova() {
    try {
        elizaLogger.info("Starting Nova initialization...");
        
        // 1. Parse and validate database config
        elizaLogger.info("Parsing database config...");
        const dbConfig = await DatabaseConfigValidator.getInstance().getDatabaseConfig();
        elizaLogger.info("Database config parsed successfully");
        
        // Initialize memory sync manager
        elizaLogger.info("Initializing memory sync manager...");
        const memorySyncManager = MemorySyncManager.getInstance();
        memorySyncManager.onMemorySynced(async (memory) => {
            elizaLogger.debug('Memory synced:', memory.id);
        });
        elizaLogger.info("Memory sync manager initialized");

        // Define ExtendedBaseMemoryManager class
        class ExtendedBaseMemoryManager extends MemoryManager implements IMemoryManager {
            private _transactionLevel: number = 0;

            async getMemoriesWithLock(query: any) {
                return this.getMemories(query);
            }

            async getMemoryWithLock(id: UUID) {
                return this.getMemory(id);
            }

            get isInTransaction(): boolean {
                return this._transactionLevel > 0;
            }

            getTransactionLevel(): number {
                return this._transactionLevel;
            }

            async beginTransaction(): Promise<void> {
                this._transactionLevel++;
            }

            async commitTransaction(): Promise<void> {
                this._transactionLevel = Math.max(0, this._transactionLevel - 1);
            }

            async rollbackTransaction(): Promise<void> {
                this._transactionLevel = Math.max(0, this._transactionLevel - 1);
            }

            async removeMemoriesWhere(condition: any) {
                elizaLogger.warn('removeMemoriesWhere not fully implemented in base manager');
                return Promise.resolve();
            }

            // Add required subscription methods
            subscribeToMemory(type: string, callback: (memory: Memory) => Promise<void>): void {
                // Delegate to on() for backward compatibility
                this.on(type, callback);
            }

            unsubscribeFromMemory(type: string, callback: (memory: Memory) => Promise<void>): void {
                // Delegate to off() for backward compatibility
                this.off(type, callback);
            }

            async updateMemory(memory: Memory): Promise<void> {
                // Basic implementation
                await this.createMemory(memory);
            }
        }

        let db;
        try {
            // Initialize the database with PostgreSQL configuration
            elizaLogger.info("Initializing PostgreSQL adapter...");
            const postgresAdapter = new PostgresDatabaseAdapter({
                connectionString: dbConfig.url,
                max: 20
            });

            // Add transaction methods
            const adapterWithTransactions = Object.assign(postgresAdapter, {
                beginTransaction: async function() {
                    return this.query('BEGIN');
                },
                commitTransaction: async function() {
                    return this.query('COMMIT');
                },
                rollbackTransaction: async function() {
                    return this.query('ROLLBACK');
                }
            });

            let adapter = adapterWithTransactions as unknown as IDatabaseAdapter;
            elizaLogger.info("PostgreSQL adapter initialized successfully");

            // Initialize cache manager
            const cacheManager = new DatabaseCacheManager(adapter);

            // Create initial runtime for memory manager
            elizaLogger.info("Creating initial runtime...");
            const initRuntime = new AgentRuntime({
                agentId: stringToUuid("nova-temp"),
                token: process.env.OPENAI_API_KEY || "",
                modelProvider: ModelProviderName.OPENAI,
                databaseAdapter: adapter,
                cacheManager: cacheManager,
                character: {
                    name: "Nova",
                    modelProvider: ModelProviderName.OPENAI,
                    bio: "A helpful AI assistant",
                    lore: ["Nova is a helpful AI assistant"],
                    messageExamples: [],
                    postExamples: [],
                    topics: ["general assistance"],
                    adjectives: ["helpful", "intelligent"],
                    clients: [],
                    plugins: [],
                    style: {
                        all: [],
                        chat: [],
                        post: []
                    }
                }
            });
            elizaLogger.info("Initial runtime created");

            // Create initial memory manager
            const initialMemoryManager = new ExtendedBaseMemoryManager({
                runtime: initRuntime,
                tableName: "messages",
                adapter: adapter
            });
            await initialMemoryManager.initialize();

            // Create extended memory manager with sync support
            const initialExtendedManager = new ExtendedMemoryManager(
                initialMemoryManager,
                new Map()
            );
            await initialExtendedManager.initialize();

            db = await getProcessDatabase({
                messageManager: initialExtendedManager,
                adapter: adapter
            } as any, "nova");
            elizaLogger.info("Database initialized successfully");
        } catch (error) {
            elizaLogger.error("Failed to initialize database:", {
                error: error instanceof Error ? error.message : error,
                stack: error instanceof Error ? error.stack : undefined
            });
            throw error;
        }

        // Initialize cache manager for Solana runtime
        const solanaCacheManager = new DatabaseCacheManager(db.adapter);

        // Create Solana runtime
        elizaLogger.info("Creating Solana runtime...");
        const solanaRuntime = new AgentRuntime({
            agentId: stringToUuid("nova"),
            token: process.env.OPENAI_API_KEY || "",
            modelProvider: ModelProviderName.OPENAI,
            databaseAdapter: db.adapter,
            cacheManager: solanaCacheManager,
            character: {
                name: "Nova",
                modelProvider: ModelProviderName.OPENAI,
                bio: "A helpful AI assistant",
                lore: ["Nova is a helpful AI assistant"],
                messageExamples: [],
                postExamples: [],
                topics: ["general assistance"],
                adjectives: ["helpful", "intelligent"],
                clients: [],
                plugins: [],
                style: {
                    all: [],
                    chat: [],
                    post: []
                }
            }
        });
        elizaLogger.info("Solana runtime created");

        // Create memory manager
        elizaLogger.info("Creating memory manager...");
        const baseMemoryManager = new ExtendedBaseMemoryManager({
            runtime: solanaRuntime,
            tableName: "messages",
            adapter: db.adapter
        });
        await baseMemoryManager.initialize();

        const memoryManager = new ExtendedMemoryManager(
            baseMemoryManager,
            new Map()
        );
        await memoryManager.initialize();

        // 2. Load the Nova character file
        elizaLogger.info("Loading Nova character file...");
        const novaCharacterPath = path.join(__dirname, "../../../characters/nova.character.json");
        
        // Check if character file exists
        if (!fs.existsSync(novaCharacterPath)) {
            throw new Error(`Character file not found at: ${novaCharacterPath}. Please ensure the file exists.`);
        }

        let novaCharacter;
        try {
            const characterContent = fs.readFileSync(novaCharacterPath, "utf-8");
            novaCharacter = JSON.parse(characterContent);
            elizaLogger.info("Nova character file loaded successfully");
        } catch (error) {
            elizaLogger.error("Failed to load character file:", error);
            throw new Error(`Failed to load character file: ${error.message}`);
        }

        if (!novaCharacter || typeof novaCharacter !== 'object') {
            throw new Error('Invalid character file format. Expected a JSON object.');
        }

        // 3. Create an AgentRuntime (single process mode)
        elizaLogger.info("Creating agent runtime...");
        const isMultiProcess = process.env.MULTI_PROCESS === "true";
        const plugins = novaCharacter.plugins || [];

        const runtimeConfig = {
            agentId: AGENT_IDS.USER,
            character: {
                ...novaCharacter,
                agentConfig: {
                    ...novaCharacter.agentConfig,
                    type: "USER"
                },
                settings: {
                    ...novaCharacter.settings,
                    SOLANA_RPC_URL: process.env.SOLANA_RPC_URL,
                    defaultVotingPower: process.env.DEFAULT_VOTING_POWER,
                    reputationDecayRate: process.env.REPUTATION_DECAY_RATE,
                    minReputation: process.env.MIN_REPUTATION,
                    maxReputation: process.env.MAX_REPUTATION
                }
            },
            token: process.env.OPENAI_API_KEY || "",
            modelProvider: ModelProviderName.OPENAI,
            databaseAdapter: db.adapter,
            cacheManager: db.adapter.getCacheManager ? db.adapter.getCacheManager() : db.adapter,
            multiProcess: isMultiProcess,
            plugins: plugins,
            messageManager: memoryManager,
            descriptionManager: memoryManager,
            documentsManager: memoryManager,
            knowledgeManager: memoryManager,
            loreManager: memoryManager
        };

        // Create and initialize the runtime
        elizaLogger.info("Creating agent runtime...");
        const runtime = new AgentRuntime(runtimeConfig);
        await runtime.initialize();
        elizaLogger.info("Runtime initialized");

        // Create Solana runtime wrapper with explicit agent type
        elizaLogger.info("Creating Solana runtime...");
        const solanaRuntimeWrapper = await createSolanaRuntime({
            ...runtimeConfig,
            character: {
                name: "Nova",
                modelProvider: ModelProviderName.OPENAI,
                bio: "A helpful AI assistant",
                lore: ["Nova is a helpful AI assistant"],
                messageExamples: [],
                postExamples: [],
                topics: ["general assistance"],
                adjectives: ["helpful", "intelligent"],
                clients: [],
                plugins: [],
                style: {
                    all: [],
                    chat: [],
                    post: []
                }
            },
            messageManager: memoryManager,
            descriptionManager: memoryManager,
            documentsManager: memoryManager,
            knowledgeManager: memoryManager,
            loreManager: memoryManager
        });
        elizaLogger.info("Solana runtime created");

        // Initialize clients object
        solanaRuntimeWrapper.clients = {};

        // 4. Set up clients
        elizaLogger.info("Setting up clients...");
        elizaLogger.info("Discord token check:", {
            tokenExists: !!process.env.DISCORD_API_TOKEN,
            tokenLength: process.env.DISCORD_API_TOKEN?.length,
            applicationId: process.env.DISCORD_APPLICATION_ID,
            envNovaPath: novaEnvPath
        });
        if (process.env.DISCORD_API_TOKEN) {
            try {
                elizaLogger.info("Starting Discord client with token:", process.env.DISCORD_API_TOKEN?.substring(0, 10) + "...");
                elizaLogger.info("Discord Application ID:", process.env.DISCORD_APPLICATION_ID);
                
                // Create a minimal runtime for Discord that doesn't include the OpenAI token
                const discordRuntime: IAgentRuntime = {
                    ...solanaRuntimeWrapper,
                    // Use OpenAI API key for model operations, Discord token for Discord operations
                    token: process.env.OPENAI_API_KEY || "", // Keep OpenAI token for model operations
                    discordToken: process.env.DISCORD_API_TOKEN, // Add Discord token separately
                    // Keep modelProvider but remove other OpenAI-specific properties
                    imageModelProvider: undefined,
                    imageVisionModelProvider: undefined,
                    // Keep necessary properties
                    agentId: solanaRuntimeWrapper.agentId,
                    agentType: solanaRuntimeWrapper.agentType,
                    modelProvider: solanaRuntimeWrapper.modelProvider, // Keep the model provider
                    databaseAdapter: solanaRuntimeWrapper.databaseAdapter,
                    messageManager: {
                        ...solanaRuntimeWrapper.messageManager,
                        subscribe: solanaRuntimeWrapper.messageManager.subscribe.bind(solanaRuntimeWrapper.messageManager),
                        unsubscribe: solanaRuntimeWrapper.messageManager.unsubscribe.bind(solanaRuntimeWrapper.messageManager),
                        subscribeToMemory: solanaRuntimeWrapper.messageManager.subscribe.bind(solanaRuntimeWrapper.messageManager),
                        unsubscribeFromMemory: solanaRuntimeWrapper.messageManager.unsubscribe.bind(solanaRuntimeWrapper.messageManager),
                        updateMemory: solanaRuntimeWrapper.messageManager.createMemory.bind(solanaRuntimeWrapper.messageManager)
                    },
                    character: solanaRuntimeWrapper.character,
                    getSetting: (key: string) => {
                        if (key === "DISCORD_API_TOKEN") return process.env.DISCORD_API_TOKEN;
                        if (key === "DISCORD_APPLICATION_ID") return process.env.DISCORD_APPLICATION_ID;
                        if (key === "OPENAI_API_KEY") return process.env.OPENAI_API_KEY;
                        return solanaRuntimeWrapper.getSetting(key);
                    }
                };
                
                const discordClient = await DiscordClientInterface.start(discordRuntime);
                solanaRuntimeWrapper.clients.discord = discordClient;
                elizaLogger.info("Discord client started successfully");
            } catch (error) {
                elizaLogger.error("Failed to start Discord client:", {
                    error: error instanceof Error ? {
                        message: error.message,
                        stack: error.stack,
                        name: error.name
                    } : error,
                    token: process.env.DISCORD_API_TOKEN ? "Present" : "Missing",
                    applicationId: process.env.DISCORD_APPLICATION_ID ? "Present" : "Missing"
                });
                throw error;
            }
        } else {
            elizaLogger.warn("No Discord token provided, skipping Discord client initialization");
        }
        const directClient = await DirectClientInterface.start(solanaRuntimeWrapper);
        solanaRuntimeWrapper.clients.direct = directClient;
        elizaLogger.info("Direct client started");

        // 5. Start the Nova agent
        elizaLogger.info("Starting Nova agent...");
        try {
            const { UserProfileAgent } = await import("./agents/user/UserProfileAgent.ts");
            const novaAgent = new UserProfileAgent(solanaRuntimeWrapper);
            await novaAgent.initialize();
            elizaLogger.info("Nova agent initialized");
        } catch (error) {
            elizaLogger.error("Error creating or initializing Nova agent:", {
                error: error instanceof Error ? {
                    message: error.message,
                    stack: error.stack,
                    name: error.name,
                    cause: error.cause
                } : error,
                details: error instanceof Error ? {
                    ...error,
                    toJSON: undefined,
                    toString: undefined
                } : {},
                fullError: JSON.stringify(error, Object.getOwnPropertyNames(error))
            });
            throw new Error(`Failed to initialize Nova agent: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }

        elizaLogger.info(`Nova agent running in ${isMultiProcess ? 'multi' : 'single'} process mode:`, {
            databaseUrl: dbConfig.url.replace(/\/\/.*@/, "//***@"),
            maxConnections: dbConfig.maxConnections || 1,
            clients: process.env.DISCORD_API_TOKEN ? ['Discord', 'Direct'] : ['Direct'],
            memorySync: 'enabled'
        });
    } catch (error) {
        elizaLogger.error("Error in startNova:", {
            error: error instanceof Error ? {
                message: error.message,
                stack: error.stack,
                name: error.name,
                cause: error.cause
            } : error,
            details: error instanceof Error ? {
                ...error,
                toJSON: undefined,
                toString: undefined
            } : {},
            fullError: JSON.stringify(error, Object.getOwnPropertyNames(error))
        });
        throw new Error(`Failed to start Nova: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}

// Run
startNova().catch((error) => {
    elizaLogger.error("Failed to start Nova:", {
        error: error instanceof Error ? {
            message: error.message,
            stack: error.stack,
            name: error.name,
            cause: error.cause
        } : error,
        details: error instanceof Error ? {
            ...error,
            toJSON: undefined,
            toString: undefined
        } : {},
        fullError: JSON.stringify(error, Object.getOwnPropertyNames(error))
    });
    process.exit(1);
}); 