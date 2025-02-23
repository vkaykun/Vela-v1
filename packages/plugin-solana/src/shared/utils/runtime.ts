//packages/plugin-solana/src/shared/utils/runtime.ts

import {
    elizaLogger,
    Action,
    Evaluator,
    Plugin,
    AgentRuntime,
    Memory,
    State,
    HandlerCallback,
    Service,
    ServiceType,
    Validator,
    UUID,
    IAgentRuntime as CoreAgentRuntime,
    ModelProviderName,
    Character,
    Provider,
    IMemoryManager as CoreMemoryManager,
    IRAGKnowledgeManager
} from "@elizaos/core";
import { BaseContent, AgentAction } from "../types/base.ts";
import { IAgentRuntime } from "../types/base.ts";

interface CharacterConfig {
    actions?: string[];
    evaluators?: string[];
    plugins?: string[];
    providers?: string[];
    settings?: Record<string, unknown>;
}

/**
 * Load actions from a plugin
 */
async function loadActionsFromPlugin(pluginName: string): Promise<Action[]> {
    try {
        const plugin = await import(pluginName) as Plugin;
        return plugin.actions || [];
    } catch (error) {
        elizaLogger.error(`Failed to load actions from plugin ${pluginName}:`, error);
        return [];
    }
}

/**
 * Load evaluators from a plugin
 */
async function loadEvaluatorsFromPlugin(pluginName: string): Promise<Evaluator[]> {
    try {
        const plugin = await import(pluginName) as Plugin;
        return plugin.evaluators || [];
    } catch (error) {
        elizaLogger.error(`Failed to load evaluators from plugin ${pluginName}:`, error);
        return [];
    }
}

/**
 * Load actions from character configuration
 */
function loadActionsFromCharacter(character: CharacterConfig): string[] {
    return character.actions || [];
}

/**
 * Load plugins from character configuration
 */
async function loadPlugins(pluginNames: string[]): Promise<Plugin[]> {
    const plugins = await Promise.all(
        pluginNames.map(async (name) => {
            try {
                return await import(name) as Plugin;
            } catch (error) {
                elizaLogger.error(`Failed to load plugin ${name}:`, error);
                return null;
            }
        })
    );
    return plugins.filter((p): p is Plugin => p !== null);
}

/**
 * Load all runtime components from character configuration and plugins
 */
export async function loadRuntimeComponents(character: CharacterConfig) {
    // Load plugins first
    const plugins = await loadPlugins(character.plugins || []);

    // Load evaluators from plugins
    const pluginEvaluators = await Promise.all(
        plugins.map(plugin => plugin.evaluators || [])
    );

    // Load providers from plugins
    const providers = plugins.flatMap(plugin => plugin.providers || []);

    return {
        actions: [], // No longer loading action handlers
        evaluators: pluginEvaluators.flat(),
        providers
    };
}

export interface IExtendedMemoryManager extends CoreMemoryManager {
    // Event methods
    subscribe(type: string, callback: (memory: any) => Promise<void>): void;
    unsubscribe(type: string, callback: (memory: any) => Promise<void>): void;
    
    // Transaction methods
    isInTransaction(): boolean;
    getTransactionLevel(): number;
    beginTransaction(): Promise<void>;
    commitTransaction(): Promise<void>;
    rollbackTransaction(): Promise<void>;
    
    // Lock-based operations
    getMemoriesWithLock(options: { roomId: UUID; count: number; filter?: Record<string, any>; }): Promise<Memory[]>;
    getMemoryWithLock(id: UUID): Promise<Memory | null>;
    removeMemoriesWhere(filter: { type: string; filter: Record<string, any>; }): Promise<void>;

    // Backward compatibility aliases
    on(type: string, callback: (memory: any) => Promise<void>): void;
    off(type: string, callback: (memory: any) => Promise<void>): void;
}

export interface ExtendedAgentRuntime extends Omit<CoreAgentRuntime, 'messageManager' | 'descriptionManager' | 'documentsManager' | 'knowledgeManager' | 'loreManager'> {
    messageManager: IExtendedMemoryManager;
    descriptionManager: IExtendedMemoryManager;
    documentsManager: IExtendedMemoryManager;
    knowledgeManager: IExtendedMemoryManager;
    loreManager: IExtendedMemoryManager;
    imageModelProvider: ModelProviderName;
    imageVisionModelProvider: ModelProviderName;
    character: Character;
    providers: Provider[];
    memoryManagers: Map<string, CoreMemoryManager>;
    ragKnowledgeManager: IRAGKnowledgeManager;
    cacheManager: any;
}

export class ExtendedMemoryManager implements IExtendedMemoryManager {
    private baseManager: CoreMemoryManager;
    private memorySubscriptions: Map<string, Set<(memory: any) => Promise<void>>>;
    private _transactionLevel: number = 0;

    constructor(baseManager: CoreMemoryManager, memorySubscriptions: Map<string, Set<(memory: any) => Promise<void>>>) {
        this.baseManager = baseManager;
        this.memorySubscriptions = memorySubscriptions;
    }

    // Single unified subscription API
    subscribe(type: string, callback: (memory: any) => Promise<void>): void {
        if (!this.memorySubscriptions.has(type)) {
            this.memorySubscriptions.set(type, new Set());
        }
        const callbacks = this.memorySubscriptions.get(type)!;

        // Check for duplicate callback by reference and stringified comparison
        const isDuplicate = [...callbacks].some(existingCallback => {
            return (
                existingCallback === callback || 
                existingCallback.toString() === callback.toString()
            );
        });

        if (!isDuplicate) {
            callbacks.add(callback);
            elizaLogger.debug(`Added subscription for type ${type}, total subscribers: ${callbacks.size}`);
        }
    }

    unsubscribe(type: string, callback: (memory: any) => Promise<void>): void {
        const callbacks = this.memorySubscriptions.get(type);
        if (callbacks) {
            // Find and remove the exact callback
            const existingCallback = [...callbacks].find(existing => 
                existing === callback || existing.toString() === callback.toString()
            );
            
            if (existingCallback) {
                callbacks.delete(existingCallback);
                elizaLogger.debug(`Removed subscription for type ${type}, remaining subscribers: ${callbacks.size}`);
            }

            // Clean up empty subscription sets
            if (callbacks.size === 0) {
                this.memorySubscriptions.delete(type);
                elizaLogger.debug(`Removed empty subscription set for type ${type}`);
            }
        }
    }

    // Internal method to notify subscribers
    private async notifySubscribers(type: string, memory: any): Promise<void> {
        const callbacks = this.memorySubscriptions.get(type);
        if (!callbacks) return;

        const errors: Error[] = [];
        for (const callback of callbacks) {
            try {
                await callback(memory);
            } catch (error) {
                errors.push(error as Error);
                elizaLogger.error(`Error in memory subscriber callback for type ${type}:`, error);
            }
        }

        if (errors.length > 0) {
            elizaLogger.error(`${errors.length} errors occurred while notifying subscribers for type ${type}`);
        }
    }

    // Memory operations
    async createMemory(memory: Memory): Promise<void> {
        await this.baseManager.createMemory(memory);
        
        // Notify subscribers of both the generic "memory_created" event and the specific type
        await this.notifySubscribers("memory_created", memory);
        if (memory.content && typeof memory.content.type === 'string') {
            await this.notifySubscribers(memory.content.type, memory);
        }
    }

    // Remove deprecated methods
    on = this.subscribe;  // Keep as alias for backward compatibility
    off = this.unsubscribe;  // Keep as alias for backward compatibility

    // Required properties from IMemoryManager
    get runtime() { return this.baseManager.runtime; }
    get tableName() { return (this.baseManager as any).tableName; }

    // Lifecycle methods
    async initialize(): Promise<void> {
        return this.baseManager.initialize?.();
    }

    async shutdown(): Promise<void> {
        return this.baseManager.shutdown?.();
    }

    // Memory operations
    async getMemories(options: any): Promise<Memory[]> {
        return this.baseManager.getMemories(options);
    }

    async getMemoryById(id: UUID): Promise<Memory | null> {
        return this.baseManager.getMemoryById(id);
    }

    async getMemory(id: UUID): Promise<Memory | null> {
        return this.baseManager.getMemory(id);
    }

    async getMemoriesByRoomIds(params: { roomIds: UUID[]; limit?: number; }): Promise<Memory[]> {
        return this.baseManager.getMemoriesByRoomIds(params);
    }

    async countMemories(roomId: UUID, unique?: boolean): Promise<number> {
        return this.baseManager.countMemories(roomId, unique);
    }

    async removeMemory(memoryId: UUID): Promise<void> {
        return this.baseManager.removeMemory(memoryId);
    }

    async removeAllMemories(roomId: UUID): Promise<void> {
        return this.baseManager.removeAllMemories(roomId);
    }

    async resyncDomainMemory(): Promise<void> {
        return this.baseManager.resyncDomainMemory();
    }

    // Additional required methods
    async addEmbeddingToMemory(memory: Memory): Promise<Memory> {
        return this.baseManager.addEmbeddingToMemory(memory);
    }

    async getMemoriesWithPagination(options: any): Promise<{ items: Memory[]; hasMore: boolean; nextCursor?: UUID; }> {
        return this.baseManager.getMemoriesWithPagination(options);
    }

    async getCachedEmbeddings(content: string): Promise<{ embedding: number[]; levenshtein_score: number; }[]> {
        return this.baseManager.getCachedEmbeddings(content);
    }

    async searchMemoriesByEmbedding(embedding: number[], options: any): Promise<Memory[]> {
        return this.baseManager.searchMemoriesByEmbedding(embedding, options);
    }

    // Transaction methods
    isInTransaction(): boolean {
        return this._transactionLevel > 0;
    }

    getTransactionLevel(): number {
        return this._transactionLevel;
    }

    async beginTransaction(): Promise<void> {
        this._transactionLevel++;
        if (this._transactionLevel === 1) {
            await this.baseManager.beginTransaction();
        }
    }

    async commitTransaction(): Promise<void> {
        if (this._transactionLevel === 1) {
            await this.baseManager.commitTransaction();
        }
        this._transactionLevel = Math.max(0, this._transactionLevel - 1);
    }

    async rollbackTransaction(): Promise<void> {
        if (this._transactionLevel === 1) {
            await this.baseManager.rollbackTransaction();
        }
        this._transactionLevel = Math.max(0, this._transactionLevel - 1);
    }

    // Lock-based operations
    async getMemoriesWithLock(options: { roomId: UUID; count: number; filter?: Record<string, any>; }): Promise<Memory[]> {
        return this.baseManager.getMemories({
            roomId: options.roomId,
            count: options.count,
            ...options.filter && { filter: options.filter }
        });
    }

    async getMemoryWithLock(id: UUID): Promise<Memory | null> {
        return this.baseManager.getMemory(id);
    }

    async removeMemoriesWhere(filter: { type: string; filter: Record<string, any>; }): Promise<void> {
        // Since removeAllMemories expects a UUID (roomId), we can't directly use it for filtering by type
        // For now, just log a warning and resolve
        elizaLogger.warn('removeMemoriesWhere not fully implemented - would need custom implementation for type filtering');
        return Promise.resolve();
    }

    // Add required methods
    subscribeToMemory(type: string, callback: (memory: Memory) => Promise<void>): void {
        this.subscribe(type, callback);
    }

    unsubscribeFromMemory(type: string, callback: (memory: Memory) => Promise<void>): void {
        this.unsubscribe(type, callback);
    }
}

export class SolanaAgentRuntime implements ExtendedAgentRuntime {
    private baseRuntime: AgentRuntime;
    private _agentType: "PROPOSAL" | "TREASURY" | "STRATEGY" | "USER";
    private memorySubscriptions = new Map<string, Set<(memory: any) => Promise<void>>>();
    private extendedMessageManager: ExtendedMemoryManager;
    private extendedDescriptionManager: ExtendedMemoryManager;
    private extendedDocumentsManager: ExtendedMemoryManager;
    private extendedKnowledgeManager: ExtendedMemoryManager;
    private extendedLoreManager: ExtendedMemoryManager;

    constructor(baseRuntime: AgentRuntime) {
        this.baseRuntime = baseRuntime;
        this._agentType = baseRuntime.agentType;
        
        // Create extended memory managers for each type
        this.extendedMessageManager = new ExtendedMemoryManager(
            baseRuntime.messageManager,
            this.memorySubscriptions
        );
        this.extendedDescriptionManager = new ExtendedMemoryManager(
            baseRuntime.descriptionManager || baseRuntime.messageManager,
            this.memorySubscriptions
        );
        this.extendedDocumentsManager = new ExtendedMemoryManager(
            baseRuntime.documentsManager || baseRuntime.messageManager,
            this.memorySubscriptions
        );
        this.extendedKnowledgeManager = new ExtendedMemoryManager(
            baseRuntime.knowledgeManager || baseRuntime.messageManager,
            this.memorySubscriptions
        );
        this.extendedLoreManager = new ExtendedMemoryManager(
            baseRuntime.loreManager || baseRuntime.messageManager,
            this.memorySubscriptions
        );
    }

    // Required properties from ExtendedAgentRuntime
    get agentId() { return this.baseRuntime.agentId; }
    get agentType(): "PROPOSAL" | "TREASURY" | "STRATEGY" | "USER" { return this._agentType; }
    set agentType(type: "PROPOSAL" | "TREASURY" | "STRATEGY" | "USER") { this._agentType = type; }
    get messageManager() { return this.extendedMessageManager; }
    get descriptionManager() { return this.extendedDescriptionManager; }
    get documentsManager() { return this.extendedDocumentsManager; }
    get knowledgeManager() { return this.extendedKnowledgeManager; }
    get ragKnowledgeManager() { return this.baseRuntime.ragKnowledgeManager; }
    get loreManager() { return this.extendedLoreManager; }
    get cacheManager() { return this.baseRuntime.cacheManager; }
    get serverUrl() { return this.baseRuntime.serverUrl; }
    get token() { return this.baseRuntime.token; }
    get modelProvider() { return this.baseRuntime.modelProvider; }
    get imageModelProvider() { return this.baseRuntime.imageModelProvider; }
    get imageVisionModelProvider() { return this.baseRuntime.imageVisionModelProvider; }
    get services() { return this.baseRuntime.services; }
    get memoryManagers() { return this.baseRuntime.memoryManagers; }
    get clients() { return this.baseRuntime.clients; }
    get character() { return this.baseRuntime.character; }
    get providers() { return this.baseRuntime.providers; }
    get actions() { return this.baseRuntime.actions; }
    get evaluators() { return this.baseRuntime.evaluators; }
    get plugins() { return this.baseRuntime.plugins; }
    get fetch() { return this.baseRuntime.fetch; }
    get verifiableInferenceAdapter() { return this.baseRuntime.verifiableInferenceAdapter; }
    get databaseAdapter() { return this.baseRuntime.databaseAdapter; }

    // Required methods
    async initialize() { return this.baseRuntime.initialize(); }
    registerMemoryManager(manager: any) { return this.baseRuntime.registerMemoryManager(manager); }
    getMemoryManager(name: string) { return this.baseRuntime.getMemoryManager(name); }
    getService<T extends Service>(service: ServiceType) { return this.baseRuntime.getService<T>(service); }
    registerService(service: any) { return this.baseRuntime.registerService(service); }
    getSetting(key: string) { return this.baseRuntime.getSetting(key); }
    getConversationLength() { return this.baseRuntime.getConversationLength(); }
    processActions(message: Memory, responses: Memory[], state?: State, callback?: HandlerCallback) { return this.baseRuntime.processActions(message, responses, state, callback); }
    evaluate(message: Memory, state?: State, didRespond?: boolean, callback?: HandlerCallback) { return this.baseRuntime.evaluate(message, state, didRespond, callback); }
    ensureParticipantExists(userId: UUID, roomId: UUID) { return this.baseRuntime.ensureParticipantExists(userId, roomId); }
    ensureUserExists(userId: UUID, userName: string | null, name: string | null, source: string | null) { return this.baseRuntime.ensureUserExists(userId, userName, name, source); }
    registerAction(action: any) { return this.baseRuntime.registerAction(action); }
    ensureConnection(userId: UUID, roomId: UUID, userName?: string, userScreenName?: string, source?: string) { return this.baseRuntime.ensureConnection(userId, roomId, userName, userScreenName, source); }
    ensureParticipantInRoom(userId: UUID, roomId: UUID) { return this.baseRuntime.ensureParticipantInRoom(userId, roomId); }
    ensureRoomExists(roomId: UUID) { return this.baseRuntime.ensureRoomExists(roomId); }
    composeState(message: Memory, additionalKeys?: any) { return this.baseRuntime.composeState(message, additionalKeys); }
    updateRecentMessageState(state: State) { return this.baseRuntime.updateRecentMessageState(state); }
}

// Helper function to create a Solana runtime
export async function createSolanaRuntime(config: any): Promise<ExtendedAgentRuntime> {
    try {
        // Create memory subscriptions map
        const memorySubscriptions = new Map<string, Set<(memory: any) => Promise<void>>>();

        // Create base runtime with extended memory managers
        elizaLogger.info("Creating base runtime...");
        const baseRuntime = new AgentRuntime({
            ...config,
            agentType: config.agentType || "TREASURY" as const
        });

        // Initialize base runtime first
        elizaLogger.info("Initializing base runtime...");
        await baseRuntime.initialize();
        elizaLogger.info("Base runtime initialized");

        // Create extended memory managers
        elizaLogger.info("Creating extended memory managers...");
        const extendedMessageManager = new ExtendedMemoryManager(
            baseRuntime.messageManager,
            memorySubscriptions
        );
        const extendedDescriptionManager = new ExtendedMemoryManager(
            baseRuntime.descriptionManager || baseRuntime.messageManager,
            memorySubscriptions
        );
        const extendedDocumentsManager = new ExtendedMemoryManager(
            baseRuntime.documentsManager || baseRuntime.messageManager,
            memorySubscriptions
        );
        const extendedKnowledgeManager = new ExtendedMemoryManager(
            baseRuntime.knowledgeManager || baseRuntime.messageManager,
            memorySubscriptions
        );
        const extendedLoreManager = new ExtendedMemoryManager(
            baseRuntime.loreManager || baseRuntime.messageManager,
            memorySubscriptions
        );

        // Initialize all extended memory managers
        elizaLogger.info("Initializing extended memory managers...");
        await extendedMessageManager.initialize();
        await extendedDescriptionManager.initialize();
        await extendedDocumentsManager.initialize();
        await extendedKnowledgeManager.initialize();
        await extendedLoreManager.initialize();
        elizaLogger.info("Extended memory managers initialized");

        // Create Solana runtime with initialized managers
        elizaLogger.info("Creating Solana runtime instance...");
        const solanaRuntime = new SolanaAgentRuntime(baseRuntime);
        solanaRuntime.agentType = config.agentType || "TREASURY";

        // Register the extended memory managers
        elizaLogger.info("Registering extended memory managers...");
        solanaRuntime.registerMemoryManager(extendedMessageManager);
        solanaRuntime.registerMemoryManager(extendedDescriptionManager);
        solanaRuntime.registerMemoryManager(extendedDocumentsManager);
        solanaRuntime.registerMemoryManager(extendedKnowledgeManager);
        solanaRuntime.registerMemoryManager(extendedLoreManager);

        // Initialize the Solana runtime
        elizaLogger.info("Initializing Solana runtime...");
        await solanaRuntime.initialize();
        elizaLogger.info("Solana runtime initialized");
        
        // Cast to ExtendedAgentRuntime with the correct memory manager types
        const extendedRuntime: ExtendedAgentRuntime = {
            ...solanaRuntime,
            agentId: solanaRuntime.agentId,
            agentType: solanaRuntime.agentType,
            messageManager: extendedMessageManager,
            descriptionManager: extendedDescriptionManager,
            documentsManager: extendedDocumentsManager,
            knowledgeManager: extendedKnowledgeManager,
            loreManager: extendedLoreManager,
            imageModelProvider: solanaRuntime.imageModelProvider,
            imageVisionModelProvider: solanaRuntime.imageVisionModelProvider,
            character: solanaRuntime.character,
            providers: solanaRuntime.providers,
            serverUrl: solanaRuntime.serverUrl,
            token: solanaRuntime.token,
            modelProvider: solanaRuntime.modelProvider,
            services: solanaRuntime.services,
            memoryManagers: solanaRuntime.memoryManagers,
            clients: solanaRuntime.clients,
            actions: solanaRuntime.actions,
            evaluators: solanaRuntime.evaluators,
            plugins: solanaRuntime.plugins,
            fetch: solanaRuntime.fetch,
            verifiableInferenceAdapter: solanaRuntime.verifiableInferenceAdapter,
            databaseAdapter: solanaRuntime.databaseAdapter,
            initialize: solanaRuntime.initialize.bind(solanaRuntime),
            registerMemoryManager: solanaRuntime.registerMemoryManager.bind(solanaRuntime),
            getMemoryManager: solanaRuntime.getMemoryManager.bind(solanaRuntime),
            getService: solanaRuntime.getService.bind(solanaRuntime),
            registerService: solanaRuntime.registerService.bind(solanaRuntime),
            getSetting: solanaRuntime.getSetting.bind(solanaRuntime),
            getConversationLength: solanaRuntime.getConversationLength.bind(solanaRuntime),
            processActions: solanaRuntime.processActions.bind(solanaRuntime),
            evaluate: solanaRuntime.evaluate.bind(solanaRuntime),
            ensureParticipantExists: solanaRuntime.ensureParticipantExists.bind(solanaRuntime),
            ensureUserExists: solanaRuntime.ensureUserExists.bind(solanaRuntime),
            registerAction: solanaRuntime.registerAction.bind(solanaRuntime),
            ensureConnection: solanaRuntime.ensureConnection.bind(solanaRuntime),
            ensureParticipantInRoom: solanaRuntime.ensureParticipantInRoom.bind(solanaRuntime),
            ensureRoomExists: solanaRuntime.ensureRoomExists.bind(solanaRuntime),
            composeState: solanaRuntime.composeState.bind(solanaRuntime),
            updateRecentMessageState: solanaRuntime.updateRecentMessageState.bind(solanaRuntime),
            ragKnowledgeManager: solanaRuntime.ragKnowledgeManager,
            cacheManager: solanaRuntime.cacheManager
        };

        return extendedRuntime;

    } catch (error) {
        elizaLogger.error("Error in createSolanaRuntime:", {
            error: error instanceof Error ? {
                message: error.message,
                stack: error.stack,
                name: error.name
            } : error,
            details: error instanceof Error ? error : {},
            fullError: error
        });
        throw error;
    }
} 