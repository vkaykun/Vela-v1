import {
    Memory,
    State,
    elizaLogger,
    stringToUuid,
    UUID,
    Content,
    AgentRuntime,
    ModelClass,
    composeContext,
    generateObject
} from "@elizaos/core";
import {
    AgentType,
    AgentState,
    AgentCapability,
    AgentMessage,
    BaseContent,
    CharacterName,
    DAOEventType,
    DAOEvent,
    IAgentRuntime,
    REQUIRED_MEMORY_TYPES,
    withTransaction,
    ExtendedMemoryOptions,
    ContentStatus,
    isValidContentStatus,
    ContentStatusIndex,
    getContentStatus,
    isValidStatusTransition,
    MemoryMetadata,
    TransactionManager,
    DistributedLock,
    IMemoryManager
} from "./types/base.ts";
import { MemoryQueryOptions } from "./types/memory.ts";
import { 
    AGENT_IDS, 
    GLOBAL_MEMORY_TYPES, 
    ROOM_IDS, 
    getMemoryRoom,
    AGENT_SPECIFIC_MEMORY_TYPES,
    AgentSpecificMemoryType 
} from "./constants.ts";
import { CacheService } from "./services/CacheService.ts";
import { getPaginatedMemories, getAllMemories, processMemoriesInChunks } from './utils/memory.ts';
import { getMemoryManager } from "./memory/MemoryManagerFactory.ts";
import { MEMORY_SUBSCRIPTIONS, MemorySubscriptionConfig } from "./types/memory-subscriptions.ts";
import { MessageBroker } from './MessageBroker.ts';
import { MemoryEvent, MemorySubscription } from './types/memory-events.ts';
import * as path from "path";
import * as fs from "fs";
import { exponentialBackoff } from './utils/backoff.ts';
import { getMemoryDomain, shouldArchiveMemory, isDescriptiveMemory } from './utils/memory-utils.ts';
import { Connection, PublicKey } from "@solana/web3.js";
import { ExtendedAgentRuntime } from "./utils/runtime.ts";

// Add transaction interfaces
interface ITransactionManager {
    beginTransaction(options?: TransactionOptions): Promise<void>;
    commitTransaction(): Promise<void>;
    rollbackTransaction(): Promise<void>;
}

interface TransactionOptions {
    maxRetries?: number;
    timeoutMs?: number;
    isolationLevel?: 'READ_COMMITTED' | 'REPEATABLE_READ' | 'SERIALIZABLE';
    backoff?: {
        initialDelayMs: number;
        maxDelayMs: number;
        factor: number;
    };
    lockKeys?: string[];
}

// Local interface definitions
interface DistributedLockContent extends BaseContent {
    type: "distributed_lock";
    key: string;
    holder: UUID;
    expiresAt: number;
    lockId: UUID;
    version: number;
    lastRenewalAt: number;
    renewalCount: number;
    lockState: 'acquiring' | 'active' | 'releasing' | 'released';
    previousLockId?: UUID;  // For tracking lock history
    acquiredAt: number;
}

interface RoomState {
    lastCreatedAt: number;
    lastUpdatedAt: number;
    lastId?: UUID;
    processedIds: Set<string>;
}

// Add validation result interface
interface ValidationResult {
    isValid: boolean;
    error?: string;
    details?: Record<string, any>;
}

// Add validation context interface
interface ValidationContext {
    agentType: AgentType;
    userId: UUID;
    timestamp: number;
    previousState?: any;
    metadata?: Record<string, any>;
}

// Add error types for better error handling
enum AgentErrorType {
    VALIDATION_ERROR = 'VALIDATION_ERROR',
    OPERATION_ERROR = 'OPERATION_ERROR',
    PERMISSION_ERROR = 'PERMISSION_ERROR',
    STATE_ERROR = 'STATE_ERROR',
    RESOURCE_ERROR = 'RESOURCE_ERROR'
}

class AgentError extends Error {
    constructor(
        public type: AgentErrorType,
        message: string,
        public details?: Record<string, any>
    ) {
        super(message);
        this.name = 'AgentError';
    }
}

// Add transaction state tracking
interface TransactionState {
    isActive: boolean;
    startTime: number;
    operationName: string;
    level: number;
    parentOperation?: string;
}

// Add LLM validation interfaces
interface LLMValidationResult<T> {
    isValid: boolean;
    data?: T;
    error?: string;
    rawResponse?: unknown;
    validationErrors?: Array<{
        field: string;
        error: string;
        value?: unknown;
    }>;
}

interface LLMValidationOptions {
    maxRetries?: number;
    requireAllFields?: boolean;
    allowExtraFields?: boolean;
    fieldValidators?: Record<string, (value: unknown) => boolean>;
    customValidator?: (data: unknown) => boolean;
}

// Add LLM error type
enum LLMErrorType {
    VALIDATION_ERROR = 'LLM_VALIDATION_ERROR',
    PARSING_ERROR = 'LLM_PARSING_ERROR',
    TIMEOUT_ERROR = 'LLM_TIMEOUT_ERROR',
    RETRY_EXHAUSTED = 'LLM_RETRY_EXHAUSTED'
}

class LLMError extends Error {
    constructor(
        public type: LLMErrorType,
        message: string,
        public response?: unknown,
        public validationErrors?: Array<{
            field: string;
            error: string;
            value?: unknown;
        }>
    ) {
        super(message);
        this.name = 'LLMError';
    }
}

// Add lock acquisition states
enum LockAcquisitionState {
    ACQUIRED = 'ACQUIRED',
    FAILED_EXISTS = 'FAILED_EXISTS',
    FAILED_TIMEOUT = 'FAILED_TIMEOUT',
    FAILED_ERROR = 'FAILED_ERROR'
}

interface LockAcquisitionResult {
    state: LockAcquisitionState;
    lock?: DistributedLock;
    error?: string;
    existingHolder?: UUID;
}

// Add validation interfaces
interface ValidationRule<T> {
    validate: (value: T, context: ValidationContext) => Promise<ValidationResult>;
    description: string;
    errorMessage: string;
    severity: 'error' | 'warning';
    type: 'format' | 'semantic' | 'security' | 'business';
}

interface ValidationSchema<T> {
    rules: ValidationRule<T>[];
    requiredFields: (keyof T)[];
    allowedFields?: (keyof T)[];
    customValidators?: Array<(value: T, context: ValidationContext) => Promise<ValidationResult>>;
    dependencies?: Partial<Record<keyof T, (keyof T)[]>>;
    constraints?: {
        minValue?: number;
        maxValue?: number;
        minLength?: number;
        maxLength?: number;
        pattern?: RegExp;
        allowedValues?: unknown[];
        [key: string]: unknown;
    };
}

interface ValidationPipeline<T> {
    preValidation?: (value: T) => Promise<T>;
    mainValidation: ValidationSchema<T>;
    postValidation?: (value: T) => Promise<ValidationResult>;
    securityChecks?: ValidationRule<T>[];
    businessRules?: ValidationRule<T>[];
}

// Add request tracking interface
interface RequestTracking extends Omit<BaseContent, 'status'> {
    type: "request_tracking";
    id: UUID;
    requestId: UUID;
    sourceType: string;  // e.g. "swap_request", "strategy_triggered"
    targetAgent: AgentType;
    requestStatus: "pending" | "processing" | "completed" | "failed";  // Renamed from status to avoid conflict
    status: ContentStatus;  // Use standard ContentStatus for BaseContent compatibility
    processedAt?: number;
    retryCount?: number;
    error?: string;
    metadata?: Record<string, unknown>;
    text: string;  // Required by BaseContent
    agentId: UUID;
    createdAt: number;
    updatedAt: number;
}

export abstract class BaseAgent {
    protected id: UUID;
    protected runtime: ExtendedAgentRuntime;
    protected messageBroker: MessageBroker;
    protected state: AgentState;
    protected capabilities: Map<string, AgentCapability>;
    protected messageQueue: AgentMessage[];
    protected watchedRooms: Set<UUID>;
    protected eventSubscriptions: Map<string, Set<(event: DAOEvent) => Promise<void>>>;
    protected characterName?: string;
    protected sharedDatabase?: any;
    protected settings: Map<string, any>;
    protected cacheService: CacheService;
    private _isInTransaction: boolean = false;
    private readonly LOCK_TIMEOUT = 30000;
    private readonly LOCK_RETRY_DELAY = 1000;
    private readonly MAX_LOCK_RETRIES = 5;
    private readonly LOCK_RENEWAL_INTERVAL = 10000; // Renew every 10 seconds
    private readonly LOCK_CLEANUP_INTERVAL = 60000; // Cleanup every minute
    private cleanupInterval: NodeJS.Timeout | null = null;
    private transactionState: TransactionState | null = null;
    private processedRequests: Set<UUID> = new Set();
    private readonly REQUEST_CLEANUP_INTERVAL = 3600000; // 1 hour
    private requestCleanupInterval: NodeJS.Timeout | null = null;

    // Remove memory monitoring config and state variables
    protected memoryMonitoringConfig = {
        minInterval: 1000,
        maxInterval: 30000,
        batchSize: 100,
        errorThreshold: 3,
        successThreshold: 5,
        backoffFactor: 2
    };

    private currentInterval: number;
    private consecutiveErrors: number = 0;
    private successfulFetches: number = 0;
    private lastProcessedTime: number = Date.now();
    private isProcessing: boolean = false;
    private monitoringTimeout: NodeJS.Timeout | null = null;
    // Track both creation and update times per room
    private roomProcessingState: Map<UUID, RoomState> = new Map();
    protected memorySubscriptions: Map<string, Set<(memory: Memory) => Promise<void>>> = new Map();

    // Track subscribed callbacks with unique IDs
    private readonly subscribedCallbacks: Map<string, Map<string, {
        callback: (memory: Memory) => Promise<void>;
        localHandler?: (memory: Memory) => Promise<void>;
        crossProcessHandler?: (event: MemoryEvent) => Promise<void>;
    }>> = new Map();

    // Counter for generating unique callback IDs
    private callbackCounter: number = 0;

    // Generate truly unique callback ID
    private generateCallbackId(): string {
        return `${this.runtime.agentId}_${Date.now()}_${this.callbackCounter++}`;
    }

    constructor(runtime: ExtendedAgentRuntime) {
        this.runtime = runtime;
        this.id = runtime.agentId;
        this.state = {
            id: runtime.agentId,
            type: runtime.agentType,
            status: "initializing",
            capabilities: [],
            lastActive: Date.now()
        };
        this.capabilities = new Map();
        this.messageQueue = [];
        this.watchedRooms = new Set([
            ROOM_IDS.DAO, // Always watch global room
            ROOM_IDS[runtime.agentType] // Watch agent's domain room
        ]);
        this.eventSubscriptions = new Map();
        this.settings = new Map();

        // Initialize cache service
        this.cacheService = new CacheService(runtime);

        // Remove setupRequiredMemorySubscriptions call from constructor
        this.messageBroker = MessageBroker.getInstance();

        // Start lock cleanup process
        this.startLockCleanup();

        // Start request tracking cleanup
        this.startRequestTracking();
    }

    public getId(): UUID {
        return this.id;
    }

    public getType(): AgentType {
        return this.runtime.agentType;
    }

    public getState(): AgentState {
        return { ...this.state };
    }

    protected async updateState(partial: Partial<AgentState>): Promise<void> {
        this.state = {
            ...this.state,
            ...partial,
            lastActive: Date.now()
        };
        await this.persistState();
    }

    protected async persistState(): Promise<void> {
        await this.runtime.messageManager.createMemory({
            id: stringToUuid(`${this.id}_state`),
            roomId: this.id,
            userId: this.id,
            agentId: this.id,
            content: {
                ...this.state,
                text: `Agent state update: ${this.state.status}`
            }
        });
    }

    public setCharacterName(name: string): void {
        this.characterName = name;
    }

    public async sendMessage(message: AgentMessage): Promise<void> {
        try {
            const memoryId = stringToUuid(`message-${Date.now()}`);
            const roomId = message.global ? ROOM_IDS.DAO : this.runtime.agentId;
            
            await this.runtime.messageManager.createMemory({
                id: memoryId,
                content: {
                    type: "agent_message",
                    text: message.content.text || `Message from ${this.runtime.agentType}`,
                    ...message
                },
                roomId,
                userId: this.id,
                agentId: this.runtime.agentId
            });

            if (this.characterName) {
                message.characterName = this.characterName as CharacterName;
            }
        } catch (error) {
            elizaLogger.error(`Error sending agent message:`, error);
            throw error;
        }
    }

    protected async receiveMessage(message: AgentMessage): Promise<void> {
        if (message.to === this.runtime.agentType || message.to === "ALL") {
            this.messageQueue.push(message);
            await this.processMessageQueue();
        }
    }

    protected async processMessageQueue(): Promise<void> {
        while (this.messageQueue.length > 0) {
            const message = this.messageQueue.shift();
            if (message) {
                await this.handleMessage(message);
            }
        }
    }

    protected async handleMessage(message: AgentMessage): Promise<void> {
        try {
            // Determine the appropriate room based on whether the message is global
            const roomId = message.global ? ROOM_IDS.DAO : this.runtime.agentId;

            // Create memory for the message
            const memory: Memory = {
                id: stringToUuid(`mem-${Date.now()}`),
                content: {
                    ...message,
                    text: typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
                    from: message.from,
                    to: message.to
                },
                roomId,
                userId: this.id,
                agentId: this.runtime.agentId
            };

            // First store the memory
            await this.runtime.messageManager.createMemory(memory);

            // Compose state for message processing
            const state = await this.runtime.composeState(memory, {
                agentId: this.runtime.agentId,
                roomId: roomId
            });

            // Process through evaluators and actions pipeline
            let wasHandled = false;
            try {
                const result = await this.runtime.processActions(
                    memory,
                    [memory], // Include original memory in context
                    state,
                    async (response: Content) => {
                        // Create response memory
                        const responseMemory: Memory = {
                            id: stringToUuid(`response-${Date.now()}`),
                            content: response,
                            roomId,
                            userId: this.runtime.agentId,
                            agentId: this.runtime.agentId
                        };
                        await this.runtime.messageManager.createMemory(responseMemory);
                        return [responseMemory];
                    }
                );
                wasHandled = result !== undefined;
            } catch (error) {
                elizaLogger.error(`Error processing actions:`, error);
                wasHandled = false;
            }

            // Run evaluations regardless of whether actions were triggered
            try {
                await this.runtime.evaluate(memory, state, wasHandled);
            } catch (error) {
                elizaLogger.error(`Error in evaluation:`, error);
                // Continue execution even if evaluation fails
            }

        } catch (error) {
            elizaLogger.error(`Error in BaseAgent.handleMessage:`, error);
            throw error;
        }
    }

    protected abstract validateAction(content: BaseContent): Promise<boolean>;

    public abstract executeAction(content: BaseContent): Promise<boolean>;

    protected async logAction(
        action: string,
        content: BaseContent,
        success: boolean,
        error?: string
    ): Promise<void> {
        try {
            const memoryId = stringToUuid(`action-${Date.now()}`);
            await this.runtime.messageManager.createMemory({
                id: memoryId,
                content: {
                    type: "agent_action",
                    text: `${this.runtime.agentType} executed ${action}`,
                    action,
                    content,
                    success,
                    error,
                    timestamp: Date.now()
                },
                roomId: this.runtime.agentId,
                userId: this.id,
                agentId: this.runtime.agentId
            });
        } catch (error) {
            elizaLogger.error(`Error logging agent action:`, error);
        }
    }

    public hasCapability(name: string): boolean {
        return this.capabilities.has(name);
    }

    public registerCapability(capability: AgentCapability): void {
        this.capabilities.set(capability.name, capability);
        this.state.capabilities = Array.from(this.capabilities.values());
        elizaLogger.debug(`Registered capability for ${this.runtime.agentType} agent: ${capability.name}`);
    }

    public getCapabilities(): AgentCapability[] {
        return Array.from(this.capabilities.values());
    }

    public async initialize(): Promise<void> {
        elizaLogger.info(`Initializing agent ${this.id}`);
        
        // Load and register actions
        this.loadActions();
        
        // Setup memory subscriptions - now handles both required and agent-specific subscriptions
        await this.setupMemorySubscriptions();
        
        // Initialize message broker
        this.messageBroker = MessageBroker.getInstance();
        
        // Setup cross-process event handling
        await this.setupCrossProcessEvents();

        // Load previous state if exists
        const previousStates = await this.runtime.messageManager.getMemories({
            roomId: this.id,
            count: 1
        });

        const lastState = previousStates.find(memory => 
            memory.content.type === "agent_state" &&
            memory.userId === this.id
        );

        if (lastState) {
            const previousState = lastState.content as unknown as AgentState;
            this.state = {
                ...previousState,
                status: "active",
                lastActive: Date.now()
            };
        }

        await this.persistState();
    }

    public async shutdown(): Promise<void> {
        elizaLogger.info(`Shutting down agent ${this.id}`);

        try {
            // Clean up memory subscriptions
            for (const [type, callbacks] of this.memorySubscriptions.entries()) {
                for (const callback of callbacks) {
                    // Unsubscribe from local memory manager
                    if (this.runtime.messageManager) {
                        this.runtime.messageManager.unsubscribeFromMemory(type, callback);
                    }
                }
            }
            this.memorySubscriptions.clear();

            // Clean up tracked callbacks and their handlers
            for (const [type, typeCallbacks] of this.subscribedCallbacks.entries()) {
                for (const handlers of typeCallbacks.values()) {
                    // Unsubscribe local handler
                    if (this.runtime.messageManager && handlers.localHandler) {
                        this.runtime.messageManager.unsubscribeFromMemory(type, handlers.localHandler);
                    }
                    // Unsubscribe cross-process handler
                    if (handlers.crossProcessHandler) {
                        this.messageBroker.unsubscribe(type, handlers.crossProcessHandler);
                    }
                }
            }
            this.subscribedCallbacks.clear();

            // Clean up event subscriptions
            for (const [type, callbacks] of this.eventSubscriptions.entries()) {
                callbacks.clear();
            }
            this.eventSubscriptions.clear();

            // Clear message queue
            this.messageQueue = [];

            // Clear any active intervals
            if (this.cleanupInterval) {
                clearInterval(this.cleanupInterval);
                this.cleanupInterval = null;
            }

            if (this.requestCleanupInterval) {
                clearInterval(this.requestCleanupInterval);
                this.requestCleanupInterval = null;
            }

            // Clear any active timeouts
            if (this.monitoringTimeout) {
                clearTimeout(this.monitoringTimeout);
                this.monitoringTimeout = null;
            }

            // Update agent state
            await this.updateState({
                status: "inactive",
                lastActive: Date.now()
            });

            elizaLogger.info(`Agent ${this.id} shutdown complete`);
        } catch (error) {
            elizaLogger.error(`Error during agent shutdown:`, error);
            throw error;
        }
    }

    protected async withTransaction<T>(
        operation: string,
        executor: () => Promise<T>,
        options: TransactionOptions = { timeoutMs: 30000 }
    ): Promise<T> {
        const { timeoutMs = 30000, maxRetries = 3 } = options;
        let attempt = 0;

        while (attempt < maxRetries) {
            try {
                // Create timeout promise
                const timeoutPromise = new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error(`Transaction '${operation}' timed out after ${timeoutMs}ms`)), timeoutMs)
                );

                // Start transaction
                if (!this._isInTransaction) {
                    await this.runtime.messageManager.beginTransaction();
                    this._isInTransaction = true;
                    this.transactionState = {
                        isActive: true,
                        startTime: Date.now(),
                        operationName: operation,
                        level: 1,
                        parentOperation: undefined
                    };
                }

                try {
                    // Race between transaction execution and timeout
                    const result = await Promise.race([
                        executor(),
                        timeoutPromise
                    ]);

                    // If we get here, transaction succeeded
                    await this.runtime.messageManager.commitTransaction();
                    this._isInTransaction = false;
                    this.transactionState = null;
                    return result;
                } catch (error) {
                    // Handle timeout or other errors
                    if (error.message.includes('timed out')) {
                        elizaLogger.error(`Transaction '${operation}' timed out:`, {
                            timeoutMs,
                            attempt: attempt + 1,
                            maxRetries,
                            error
                        });
                    } else {
                        elizaLogger.error(`Error in transaction '${operation}':`, {
                            attempt: attempt + 1,
                            maxRetries,
                            error
                        });
                    }

                    // Always try to rollback on error
                    try {
                        if (this._isInTransaction) {
                            await this.runtime.messageManager.rollbackTransaction();
                        }
                    } catch (rollbackError) {
                        elizaLogger.error(`Failed to rollback transaction '${operation}':`, rollbackError);
                    } finally {
                        this._isInTransaction = false;
                        this.transactionState = null;
                    }

                    throw error;
                }
            } catch (error) {
                attempt++;
                
                // If we've exhausted retries or it's not a timeout error, rethrow
                if (attempt >= maxRetries || !error.message.includes('timed out')) {
                    throw error;
                }

                // Calculate backoff delay for next retry
                const backoffDelay = options.backoff?.initialDelayMs || 1000 * Math.pow(2, attempt);
                elizaLogger.warn(`Retrying transaction '${operation}' after ${backoffDelay}ms delay`, {
                    attempt,
                    maxRetries,
                    backoffDelay
                });
                
                await new Promise(resolve => setTimeout(resolve, backoffDelay));
            }
        }

        throw new Error(`Transaction '${operation}' failed after ${maxRetries} attempts`);
    }

    protected async createMemory(content: BaseContent): Promise<void> {
        return this.executeWithValidation(
            'createMemory',
            content,
            async (memoryContent) => {
                const domain = getMemoryDomain(memoryContent.type);
                const isArchived = shouldArchiveMemory(memoryContent.type, memoryContent.status);
                const isDescriptive = isDescriptiveMemory(memoryContent.type);

                const manager = isDescriptive ? this.runtime.descriptionManager :
                               isArchived ? this.runtime.loreManager :
                               this.runtime.messageManager;

                const memory: Memory = {
                    id: memoryContent.id || stringToUuid(`mem-${Date.now()}`),
                    content: {
                        ...memoryContent,
                        agentId: this.runtime.agentId,
                        createdAt: memoryContent.createdAt || Date.now(),
                        updatedAt: memoryContent.updatedAt || Date.now()
                    },
                    roomId: getMemoryRoom(memoryContent.type, this.runtime.agentId),
                    userId: this.runtime.agentId,
                    agentId: this.runtime.agentId
                };

                await this.withTransaction('createMemory', async () => {
                    // Let the memory manager handle event emission
                    await manager.createMemory(memory);
                });
            }
        );
    }

    protected async queryMemories<T extends BaseContent>(options: {
        type: string;
        filter?: (item: T) => boolean;
        sort?: (a: T, b: T) => number;
        limit?: number;
    }): Promise<T[]> {
        const domain = getMemoryDomain(options.type);
        const isArchived = shouldArchiveMemory(options.type);
        const isDescriptive = isDescriptiveMemory(options.type);

        const manager = isDescriptive ? this.runtime.descriptionManager :
                       isArchived ? this.runtime.loreManager :
                       this.runtime.messageManager;

        const memories = await manager.getMemories({
            roomId: getMemoryRoom(options.type, this.runtime.agentId),
            count: options.limit || 100
        });

        let items = memories
            .filter(m => m.content.type === options.type)
            .map(m => m.content as T);

        if (options.filter) {
            items = items.filter(options.filter);
        }

        if (options.sort) {
            items = items.sort(options.sort);
        }

        return items;
    }

    protected setupMemorySubscriptions(): void {
        const agentType = this.runtime.agentType;
        
        // Get all required types for this agent
        const requiredTypes = REQUIRED_MEMORY_TYPES[agentType];
        if (!requiredTypes) {
            throw new Error(`No required memory types defined for agent type: ${agentType}`);
        }

        // First validate all required types have subscription configs
        const missingConfigs = requiredTypes.filter(type => !MEMORY_SUBSCRIPTIONS[type]);
        if (missingConfigs.length > 0) {
            throw new Error(
                `Missing subscription configs for required types: ${missingConfigs.join(", ")} ` +
                `in agent type: ${agentType}. Either add configs to MEMORY_SUBSCRIPTIONS or ` +
                `remove from REQUIRED_MEMORY_TYPES.`
            );
        }

        // Set up subscriptions for all required types
        requiredTypes.forEach(type => {
            const config = MEMORY_SUBSCRIPTIONS[type];
            if (!config.requiredBy.includes(agentType)) {
                throw new Error(
                    `Memory type "${type}" is required by ${agentType} but not listed in ` +
                    `MEMORY_SUBSCRIPTIONS[${type}].requiredBy`
                );
            }

            // Subscribe with both the base handler and any type-specific handler
            this.subscribeToMemory(type, async (memory: Memory) => {
                // Base handling for all memories
                await this.handleMemory(memory);
                
                // Type-specific handling if defined
                if (config.handler) {
                    try {
                        await config.handler(memory);
                    } catch (error) {
                        elizaLogger.error(`Error in type-specific handler for ${type}:`, error);
                    }
                }
            });
        });

        // Log subscription setup
        elizaLogger.info(`Set up memory subscriptions for ${agentType}:`, {
            required: requiredTypes,
            subscribed: Array.from(this.memorySubscriptions.keys())
        });
    }

    protected subscribeToMemory(type: string, callback: (memory: Memory) => Promise<void>): void {
        // Validate memory type registration
        if (!MEMORY_SUBSCRIPTIONS[type]) {
            elizaLogger.warn(`Attempting to subscribe to unregistered memory type: ${type}`);
            return;
        }
        
        // Validate agent type handling
        if (!MEMORY_SUBSCRIPTIONS[type].requiredBy.includes(this.runtime.agentType)) {
            elizaLogger.warn(
                `Agent ${this.runtime.agentType} is not configured to handle memory type: ${type}`
            );
            return;
        }

        // Initialize type tracking if needed
        if (!this.subscribedCallbacks.has(type)) {
            this.subscribedCallbacks.set(type, new Map());
        }

        // Generate unique ID for this callback
        const callbackId = this.generateCallbackId();
        const typeCallbacks = this.subscribedCallbacks.get(type)!;

        // Create handlers for both local and cross-process events
        const localHandler = async (memory: Memory) => {
            // Skip self-generated memories
            if (memory.agentId === this.runtime.agentId) {
                return;
            }
            await callback(memory);
        };

        const crossProcessHandler = async (event: MemoryEvent) => {
            if (event.memory && event.agentId !== this.runtime.agentId) {
                await callback(event.memory);
            }
        };

        // Store all handlers for cleanup
        typeCallbacks.set(callbackId, {
            callback,
            localHandler,
            crossProcessHandler
        });

        // Set up subscriptions if first callback for this type
        if (typeCallbacks.size === 1) {
            if (this.runtime.messageManager) {
                // Subscribe to local memory manager
                this.runtime.messageManager.subscribeToMemory(type, localHandler);

                // Subscribe to cross-process events
                this.messageBroker.subscribe(type, crossProcessHandler);
            } else {
                elizaLogger.error(`MessageManager not available in runtime for agent type ${this.runtime.agentType}`);
            }
        }

        elizaLogger.debug(`Added subscription for type ${type}, callback ${callbackId}, total subscribers: ${typeCallbacks.size}`);
    }

    protected unsubscribeFromMemory(type: string, callback: (memory: Memory) => Promise<void>): void {
        const typeCallbacks = this.subscribedCallbacks.get(type);
        if (!typeCallbacks) return;

        // Find and remove the callback entry
        for (const [callbackId, handlers] of typeCallbacks.entries()) {
            if (handlers.callback === callback) {
                // Clean up local subscription if last callback
                if (typeCallbacks.size === 1) {
                    if (this.runtime.messageManager && handlers.localHandler) {
                        this.runtime.messageManager.unsubscribeFromMemory(type, handlers.localHandler);
                    }
                    if (handlers.crossProcessHandler) {
                        this.messageBroker.unsubscribe(type, handlers.crossProcessHandler);
                    }
                }

                typeCallbacks.delete(callbackId);
                elizaLogger.debug(`Removed subscription for type ${type}, callback ${callbackId}`);
                break;
            }
        }

        // Clean up type tracking if no more callbacks
        if (typeCallbacks.size === 0) {
            this.subscribedCallbacks.delete(type);
        }
    }

    public async setDatabase(database: any): Promise<void> {
        this.sharedDatabase = database;
        elizaLogger.info(`Set shared database for agent ${this.runtime.agentType}`);
    }

    protected async broadcastEvent(event: DAOEvent): Promise<void> {
        try {
            // Store in memory
            await this.runtime.messageManager.createMemory({
                id: stringToUuid(`event-${event.eventId}`),
                content: event,
                roomId: this.runtime.agentId,
                userId: this.id,
                agentId: this.runtime.agentId
            });

            // Notify subscribers
            const subscribers = this.eventSubscriptions.get(event.type) || new Set();
            await Promise.all(Array.from(subscribers).map(callback => callback(event)));

            elizaLogger.info(`Broadcasted event ${event.type} from ${this.runtime.agentType}`);
        } catch (error) {
            elizaLogger.error(`Error broadcasting event:`, error);
            throw error;
        }
    }

    public async subscribeToEvent(type: DAOEventType, callback: (event: DAOEvent) => Promise<void>): Promise<void> {
        if (!this.eventSubscriptions.has(type)) {
            this.eventSubscriptions.set(type, new Set());
        }
        this.eventSubscriptions.get(type)?.add(callback);
    }

    public async unsubscribeFromEvent(type: DAOEventType, callback: (event: DAOEvent) => Promise<void>): Promise<void> {
        const callbacks = this.eventSubscriptions.get(type);
        if (callbacks) {
            callbacks.delete(callback);
            if (callbacks.size === 0) {
                this.eventSubscriptions.delete(type);
            }
        }
    }

    protected async notifyEventSubscribers(event: DAOEvent): Promise<void> {
        const callbacks = this.eventSubscriptions.get(event.type);
        if (!callbacks) return;

        const errors: Error[] = [];
        const promises: Promise<void>[] = [];

        for (const callback of callbacks) {
            promises.push((async () => {
                try {
                    await callback(event);
                } catch (error) {
                    errors.push(error as Error);
                    elizaLogger.error(`Error in event subscriber for ${event.type}:`, error);
                }
            })());
        }

        await Promise.all(promises);

        if (errors.length > 0) {
            elizaLogger.error(`${errors.length} errors occurred while notifying event subscribers`);
        }
    }

    // Add settings management methods
    public setSetting(key: string, value: unknown): void {
        this.settings.set(key, value);
        elizaLogger.debug(`Set ${this.runtime.agentType} agent setting: ${key}=${value}`);
    }

    public getSetting(key: string): unknown | undefined {
        return this.settings.get(key);
    }

    public getSettings(): Map<string, unknown> {
        return new Map(this.settings);
    }

    protected async invokeSubscriptionHandler(memory: Memory): Promise<void> {
        const content = memory.content as BaseContent;
        const memType = content.type;
        
        // Invoke the specialized handler from MEMORY_SUBSCRIPTIONS if it exists
        const config = MEMORY_SUBSCRIPTIONS[memType];
        if (config && typeof config.handler === 'function' && 
            config.requiredBy.includes(this.runtime.agentType)) {
            try {
                await config.handler(memory);
            } catch (error) {
                elizaLogger.error(`Error in ${memType} subscription handler:`, error);
            }
        }
    }

    // Change from abstract to concrete implementation that derived classes can extend
    protected async handleMemory(memory: Memory): Promise<void> {
        // Skip processing if memory is from this agent
        if (memory.agentId === this.runtime.agentId) {
            return;
        }

        // Always invoke subscription handlers first
        await this.invokeSubscriptionHandler(memory);

        // Allow derived classes to extend behavior by implementing handleMemoryExtended
        await this.handleMemoryExtended(memory);
    }

    // New protected method for derived classes to implement additional memory handling
    protected async handleMemoryExtended(memory: Memory): Promise<void> {
        // Default implementation does nothing
        // Derived classes can override this to add custom memory handling logic
    }

    protected abstract loadActions(): void;
    protected abstract setupCrossProcessEvents(): Promise<void>;

    private startLockCleanup(): void {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
        }

        this.cleanupInterval = setInterval(async () => {
            await this.cleanupExpiredLocks();
        }, this.LOCK_CLEANUP_INTERVAL);
    }

    private async cleanupExpiredLocks(): Promise<void> {
        await this.withTransaction('cleanupExpiredLocks', async () => {
            try {
                // Get all locks with row-level locking
                const locks = await this.runtime.messageManager.getMemoriesWithLock({
                    roomId: this.id,
                    count: 1000,
                    filter: {
                        type: "distributed_lock"
                    }
                });

                const now = Date.now();
                const locksToClean = locks.filter(lockMemory => {
                    const content = lockMemory.content as DistributedLockContent;
                    return content.expiresAt <= now || 
                           content.lastRenewalAt + this.LOCK_RENEWAL_INTERVAL * 2 <= now ||
                           content.lockState === 'releasing';
                });

                // Process each lock in its own nested transaction to maintain isolation
                for (const lockMemory of locksToClean) {
                    const content = lockMemory.content as DistributedLockContent;
                    
                    // Start a nested transaction for this specific lock
                    await this.withTransaction(`cleanupLock-${content.key}`, async () => {
                        // Re-check the lock state with row-level locking
                        const currentLock = await this.runtime.messageManager.getMemoryWithLock(lockMemory.id);
                        
                        // Only remove if the lock is still in the same state
                        if (currentLock && 
                            (currentLock.content as DistributedLockContent).version === content.version) {
                            await this.runtime.messageManager.removeMemory(lockMemory.id);
                            elizaLogger.debug(`Cleaned up lock for ${content.key} (v${content.version})`);
                        }
                    }, {
                        isolationLevel: 'SERIALIZABLE',
                        lockKeys: [`lock-${content.key}`]
                    });
                }
            } catch (error) {
                elizaLogger.error("Error cleaning up locks:", error);
                throw error;
            }
        });
    }

    protected async acquireDistributedLock(key: string, timeoutMs: number = 30000): Promise<DistributedLock | null> {
        return await this.withTransaction('acquireLock', async () => {
            const now = Date.now();
            const expiresAt = now + timeoutMs;
            const lockId = stringToUuid(`lock-${key}-${now}`);

            try {
                // First, get and remove any expired locks for this key
                const expiredLocks = await this.runtime.messageManager.getMemories({
                    roomId: ROOM_IDS.DAO,
                    count: 100
                });

                // Filter and remove expired locks within the same transaction
                for (const lock of expiredLocks) {
                    const content = lock.content as any;
                    if (content.type === "distributed_lock" && 
                        content.key === key && 
                        (content.expiresAt <= now || content.lockState !== 'active')) {
                        await this.runtime.messageManager.removeMemory(lock.id);
                    }
                }

                // Try to insert the lock directly as active
                await this.runtime.messageManager.createMemory({
                    id: lockId,
                    content: {
                        type: "distributed_lock",
                        key,
                        holder: this.runtime.agentId,
                        expiresAt,
                        lockId,
                        version: 1,
                        lastRenewalAt: now,
                        renewalCount: 0,
                        lockState: 'active',
                        acquiredAt: now,
                        text: `Lock ${key} acquired by ${this.runtime.agentId}`,
                        agentId: this.runtime.agentId,
                        createdAt: now,
                        updatedAt: now,
                        status: "executed"
                    },
                    roomId: ROOM_IDS.DAO,
                    userId: this.runtime.agentId,
                    agentId: this.runtime.agentId,
                    unique: true
                });

                // If we get here, we successfully acquired the lock
                return {
                    key,
                    holder: this.runtime.agentId,
                    expiresAt,
                    lockId,
                    version: 1
                };

            } catch (error) {
                if (error.message?.includes('unique constraint')) {
                    // Lock already exists and is active
                    return null;
                }
                throw error;
            }
        });
    }

    private async processMemory(memory: Memory): Promise<void> {
        try {
            // Skip own memories
            if (memory.agentId === this.runtime.agentId) return;

            // Process memory through handleMemory
            await this.handleMemory(memory);
        } catch (error) {
            elizaLogger.error("Error processing memory:", error);
        }
    }

    protected async validateWithSchema<T extends Record<string, unknown>>(
        value: T,
        schema: ValidationSchema<T>,
        context: ValidationContext
    ): Promise<ValidationResult> {
        const errors: Array<{field?: string; error: string; type: string}> = [];

        // 1. Check required fields
        for (const field of schema.requiredFields) {
            if (!(field in value) || value[field] === undefined || value[field] === null) {
                errors.push({
                    field: String(field),
                    error: `Missing required field: ${String(field)}`,
                    type: 'format'
                });
            }
        }

        // 2. Check allowed fields if specified
        if (schema.allowedFields) {
            const extraFields = Object.keys(value).filter(
                key => !schema.allowedFields!.includes(key as keyof T)
            );
            if (extraFields.length > 0) {
                errors.push({
                    error: `Unexpected fields: ${extraFields.join(', ')}`,
                    type: 'format'
                });
            }
        }

        // 3. Check field dependencies
        if (schema.dependencies) {
            for (const [field, deps] of Object.entries(schema.dependencies)) {
                if (field in value && value[field] !== undefined) {
                    for (const dep of deps) {
                        if (!(dep in value) || value[dep] === undefined) {
                            errors.push({
                                field: String(field),
                                error: `Field ${field} requires ${String(dep)}`,
                                type: 'semantic'
                            });
                        }
                    }
                }
            }
        }

        // 4. Apply validation rules
        for (const rule of schema.rules) {
            const result = await rule.validate(value, context);
            if (!result.isValid) {
                errors.push({
                    error: result.error || rule.errorMessage,
                    type: rule.type
                });
            }
        }

        // 5. Apply custom validators
        if (schema.customValidators) {
            for (const validator of schema.customValidators) {
                const result = await validator(value, context);
                if (!result.isValid) {
                    errors.push({
                        error: result.error || 'Custom validation failed',
                        type: 'semantic'
                    });
                }
            }
        }

        // 6. Check constraints
        if (schema.constraints) {
            for (const [field, fieldValue] of Object.entries(value)) {
                const constraints = schema.constraints;
                
                // Type guard for number values
                if (typeof fieldValue === 'number') {
                    const minValue = constraints.minValue;
                    const maxValue = constraints.maxValue;
                    
                    if (typeof minValue === 'number') {
                        const numValue = fieldValue as number;
                        if (numValue < minValue) {
                            errors.push({
                                field,
                                error: `Value must be >= ${minValue}`,
                                type: 'semantic'
                            });
                        }
                    }
                    if (typeof maxValue === 'number') {
                        const numValue = fieldValue as number;
                        if (numValue > maxValue) {
                            errors.push({
                                field,
                                error: `Value must be <= ${maxValue}`,
                                type: 'semantic'
                            });
                        }
                    }
                }

                // Type guard for string values
                if (typeof fieldValue === 'string') {
                    const minLength = constraints.minLength;
                    const maxLength = constraints.maxLength;
                    const pattern = constraints.pattern;
                    
                    if (typeof minLength === 'number') {
                        const strValue = fieldValue as string;
                        if (strValue.length < minLength) {
                            errors.push({
                                field,
                                error: `Length must be >= ${minLength}`,
                                type: 'format'
                            });
                        }
                    }
                    if (typeof maxLength === 'number') {
                        const strValue = fieldValue as string;
                        if (strValue.length > maxLength) {
                            errors.push({
                                field,
                                error: `Length must be <= ${maxLength}`,
                                type: 'format'
                            });
                        }
                    }
                    if (pattern instanceof RegExp) {
                        const strValue = fieldValue as string;
                        if (!pattern.test(strValue)) {
                            errors.push({
                                field,
                                error: `Invalid format`,
                                type: 'format'
                            });
                        }
                    }
                }
                
                // Type guard for allowed values
                const allowedValues = constraints.allowedValues;
                if (Array.isArray(allowedValues) && !allowedValues.includes(fieldValue)) {
                    errors.push({
                        field,
                        error: `Value must be one of: ${allowedValues.join(', ')}`,
                        type: 'semantic'
                    });
                }
            }
        }

        return {
            isValid: errors.length === 0,
            error: errors.length > 0 ? errors[0].error : undefined,
            details: errors.length > 0 ? { errors } : undefined
        };
    }

    protected async executeValidationPipeline<T extends Record<string, unknown>>(
        value: T,
        pipeline: ValidationPipeline<T>,
        context: ValidationContext
    ): Promise<ValidationResult> {
        try {
            // 1. Pre-validation transformation
            let transformedValue = value;
            if (pipeline.preValidation) {
                transformedValue = await pipeline.preValidation(value);
            }

            // 2. Main schema validation
            const mainResult = await this.validateWithSchema(
                transformedValue,
                pipeline.mainValidation,
                context
            );
            if (!mainResult.isValid) {
                return mainResult;
            }

            // 3. Security checks
            if (pipeline.securityChecks) {
                for (const check of pipeline.securityChecks) {
                    const securityResult = await check.validate(transformedValue, context);
                    if (!securityResult.isValid) {
                        return {
                            isValid: false,
                            error: `Security check failed: ${securityResult.error}`,
                            details: {
                                type: 'security',
                                ...securityResult.details
                            }
                        };
                    }
                }
            }

            // 4. Business rules
            if (pipeline.businessRules) {
                for (const rule of pipeline.businessRules) {
                    const ruleResult = await rule.validate(transformedValue, context);
                    if (!ruleResult.isValid) {
                        return {
                            isValid: false,
                            error: `Business rule failed: ${ruleResult.error}`,
                            details: {
                                type: 'business',
                                ...ruleResult.details
                            }
                        };
                    }
                }
            }

            // 5. Post-validation
            if (pipeline.postValidation) {
                const postResult = await pipeline.postValidation(transformedValue);
                if (!postResult.isValid) {
                    return postResult;
                }
            }

            return { isValid: true };

        } catch (error) {
            return {
                isValid: false,
                error: `Validation pipeline error: ${error instanceof Error ? error.message : String(error)}`,
                details: { error }
            };
        }
    }

    // Common security validation rules
    protected getSecurityValidationRules<T>(): ValidationRule<T>[] {
        return [
            {
                validate: async (value: T) => {
                    // Check for common injection patterns
                    const stringified = JSON.stringify(value);
                    const injectionPatterns = [
                        /\b(exec|eval|function|setTimeout|setInterval)\s*\(/i,
                        /<script\b[^>]*>/i,
                        /javascript:/i,
                        /data:/i,
                        /vbscript:/i,
                        /onload\s*=/i,
                        /onclick\s*=/i
                    ];

                    for (const pattern of injectionPatterns) {
                        if (pattern.test(stringified)) {
                            return {
                                isValid: false,
                                error: 'Potential injection attack detected',
                                details: { pattern: pattern.source }
                            };
                        }
                    }
                    return { isValid: true };
                },
                description: 'Check for common injection patterns',
                errorMessage: 'Security validation failed',
                severity: 'error',
                type: 'security'
            },
            {
                validate: async (value: T) => {
                    // Check for oversized inputs
                    const size = new TextEncoder().encode(JSON.stringify(value)).length;
                    const MAX_SIZE = 1024 * 1024; // 1MB
                    if (size > MAX_SIZE) {
                        return {
                            isValid: false,
                            error: 'Input size exceeds maximum allowed',
                            details: { size, maxSize: MAX_SIZE }
                        };
                    }
                    return { isValid: true };
                },
                description: 'Check input size limits',
                errorMessage: 'Input size validation failed',
                severity: 'error',
                type: 'security'
            }
        ];
    }

    // Common business validation rules
    protected getBusinessValidationRules<T extends BaseContent>(): ValidationRule<T>[] {
        return [
            {
                validate: async (value: T, context: ValidationContext) => {
                    // Check if user has required permissions
                    const userProfile = await this.getUserProfile(context.userId);
                    if (!userProfile) {
                        return {
                            isValid: false,
                            error: 'User profile not found',
                            details: { userId: context.userId }
                        };
                    }

                    // Check if user has required reputation/role
                    const minReputation = value.metadata?.minReputation;
                    if (typeof minReputation === 'number' && 
                        (!userProfile.reputation || 
                         userProfile.reputation < minReputation)) {
                        return {
                            isValid: false,
                            error: 'Insufficient reputation for this operation',
                            details: {
                                required: minReputation,
                                current: userProfile.reputation
                            }
                        };
                    }

                    return { isValid: true };
                },
                description: 'Check user permissions and requirements',
                errorMessage: 'Permission validation failed',
                severity: 'error',
                type: 'business'
            },
            {
                validate: async (value: T) => {
                    // Check rate limits
                    const now = Date.now();
                    const recentMemories = await this.getMemoriesWithFilter({
                        roomId: this.runtime.agentId,
                        count: 100,
                        filter: {
                            type: value.type,
                            agentId: value.agentId,
                            createdAt: { $gt: now - 3600000 } // Last hour
                        }
                    });

                    const MAX_OPERATIONS_PER_HOUR = 100;
                    if (recentMemories.length >= MAX_OPERATIONS_PER_HOUR) {
                        return {
                            isValid: false,
                            error: 'Rate limit exceeded',
                            details: {
                                current: recentMemories.length,
                                max: MAX_OPERATIONS_PER_HOUR,
                                resetAt: now + 3600000
                            }
                        };
                    }

                    return { isValid: true };
                },
                description: 'Check rate limits',
                errorMessage: 'Rate limit validation failed',
                severity: 'error',
                type: 'business'
            }
        ];
    }

    /**
     * Validates LLM output against a schema with proper error handling
     */
    protected async validateLLMOutput<T>(
        llmOutput: unknown,
        schema: {
            type: string;
            required: string[];
            properties: Record<string, {
                type: string;
                enum?: unknown[];
                minimum?: number;
                maximum?: number;
                pattern?: string;
            }>;
        },
        options: LLMValidationOptions = {}
    ): Promise<LLMValidationResult<T>> {
        try {
            // 1. Parse JSON if string
            let parsed: unknown;
            if (typeof llmOutput === 'string') {
                try {
                    parsed = JSON.parse(llmOutput);
                } catch (error) {
                    return {
                        isValid: false,
                        error: 'Invalid JSON format',
                        rawResponse: llmOutput,
                        validationErrors: [{
                            field: 'json',
                            error: 'Failed to parse JSON',
                            value: llmOutput
                        }]
                    };
                }
            } else {
                parsed = llmOutput;
            }

            // 2. Basic type check
            if (!parsed || typeof parsed !== 'object') {
                return {
                    isValid: false,
                    error: 'Response must be an object',
                    rawResponse: parsed,
                    validationErrors: [{
                        field: 'root',
                        error: 'Not an object',
                        value: parsed
                    }]
                };
            }

            // 3. Check required fields
            const validationErrors: Array<{field: string; error: string; value?: unknown}> = [];
            for (const field of schema.required) {
                if (!(field in parsed)) {
                    validationErrors.push({
                        field,
                        error: 'Required field missing'
                    });
                }
            }

            // 4. Validate field types and constraints
            for (const [field, value] of Object.entries(parsed)) {
                const fieldSchema = schema.properties[field];
                if (!fieldSchema) {
                    if (!options.allowExtraFields) {
                        validationErrors.push({
                            field,
                            error: 'Unknown field',
                            value
                        });
                    }
                    continue;
                }

                // Type validation
                if (fieldSchema.type === 'string' && typeof value !== 'string') {
                    validationErrors.push({
                        field,
                        error: 'Must be a string',
                        value
                    });
                } else if (fieldSchema.type === 'number' && typeof value !== 'number') {
                    validationErrors.push({
                        field,
                        error: 'Must be a number',
                        value
                    });
                } else if (fieldSchema.type === 'boolean' && typeof value !== 'boolean') {
                    validationErrors.push({
                        field,
                        error: 'Must be a boolean',
                        value
                    });
                } else if (fieldSchema.type === 'array' && !Array.isArray(value)) {
                    validationErrors.push({
                        field,
                        error: 'Must be an array',
                        value
                    });
                }

                // Enum validation
                if (fieldSchema.enum && !fieldSchema.enum.includes(value)) {
                    validationErrors.push({
                        field,
                        error: `Must be one of: ${fieldSchema.enum.join(', ')}`,
                        value
                    });
                }

                // Number constraints
                if (typeof value === 'number') {
                    if (fieldSchema.minimum !== undefined && value < fieldSchema.minimum) {
                        validationErrors.push({
                            field,
                            error: `Must be >= ${fieldSchema.minimum}`,
                            value
                        });
                    }
                    if (fieldSchema.maximum !== undefined && value > fieldSchema.maximum) {
                        validationErrors.push({
                            field,
                            error: `Must be <= ${fieldSchema.maximum}`,
                            value
                        });
                    }
                }

                // String pattern
                if (typeof value === 'string' && fieldSchema.pattern) {
                    const regex = new RegExp(fieldSchema.pattern);
                    if (!regex.test(value)) {
                        validationErrors.push({
                            field,
                            error: 'Invalid format',
                            value
                        });
                    }
                }

                // Custom field validator
                if (options.fieldValidators?.[field]) {
                    if (!options.fieldValidators[field](value)) {
                        validationErrors.push({
                            field,
                            error: 'Failed custom validation',
                            value
                        });
                    }
                }
            }

            // 5. Custom validator
            if (options.customValidator && !options.customValidator(parsed)) {
                validationErrors.push({
                    field: 'custom',
                    error: 'Failed custom validation',
                    value: parsed
                });
            }

            // 6. Return result
            if (validationErrors.length > 0) {
                return {
                    isValid: false,
                    error: 'Validation failed',
                    rawResponse: parsed,
                    validationErrors
                };
            }

            return {
                isValid: true,
                data: parsed as T,
                rawResponse: parsed
            };

        } catch (error) {
            return {
                isValid: false,
                error: error instanceof Error ? error.message : 'Unknown validation error',
                rawResponse: llmOutput
            };
        }
    }

    /**
     * Retries LLM validation with exponential backoff
     */
    protected async retryLLMValidation<T>(
        generator: () => Promise<unknown>,
        schema: {
            type: string;
            required: string[];
            properties: Record<string, {
                type: string;
                enum?: unknown[];
                minimum?: number;
                maximum?: number;
                pattern?: string;
            }>;
        },
        options: LLMValidationOptions & {
            maxRetries?: number;
            initialDelayMs?: number;
            maxDelayMs?: number;
            backoffFactor?: number;
        } = {}
    ): Promise<LLMValidationResult<T>> {
        const {
            maxRetries = 3,
            initialDelayMs = 1000,
            maxDelayMs = 10000,
            backoffFactor = 2,
            ...validationOptions
        } = options;

        let lastError: LLMValidationResult<T> | null = null;
        let delay = initialDelayMs;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const llmOutput = await generator();
                const result = await this.validateLLMOutput<T>(llmOutput, schema, validationOptions);

                if (result.isValid) {
                    return result;
                }

                lastError = result;
                elizaLogger.warn(`LLM validation failed (attempt ${attempt}/${maxRetries}):`, result.validationErrors);

                if (attempt < maxRetries) {
                    await new Promise(resolve => setTimeout(resolve, delay));
                    delay = Math.min(delay * backoffFactor, maxDelayMs);
                }

            } catch (error) {
                lastError = {
                    isValid: false,
                    error: error instanceof Error ? error.message : 'Unknown error during retry',
                    validationErrors: [{
                        field: 'retry',
                        error: 'Failed to generate or validate output',
                        value: error
                    }]
                };
                elizaLogger.error(`LLM retry error (attempt ${attempt}/${maxRetries}):`, error);

                if (attempt < maxRetries) {
                    await new Promise(resolve => setTimeout(resolve, delay));
                    delay = Math.min(delay * backoffFactor, maxDelayMs);
                }
            }
        }

        throw new LLMError(
            LLMErrorType.RETRY_EXHAUSTED,
            `Failed to validate LLM output after ${maxRetries} attempts`,
            lastError?.rawResponse,
            lastError?.validationErrors
        );
    }

    protected abstract getUserProfile(userId: UUID): Promise<{ reputation?: number; role?: string } | null>;
    
    protected abstract executeWithValidation<T extends Record<string, unknown>, R>(
        operation: string,
        params: T,
        executor: (params: T) => Promise<R>
    ): Promise<R>;

    protected async getMemoriesWithFilter<T extends BaseContent>(
        options: {
            roomId: UUID;
            count?: number;
            unique?: boolean;
            start?: number;
            end?: number;
            filter?: Record<string, unknown>;
            lastId?: UUID;
            createdAfter?: number;
            createdBefore?: number;
            updatedAfter?: number;
            updatedBefore?: number;
        }
    ): Promise<Memory[]> {
        return await this.runtime.messageManager.getMemories(options);
    }

    private startRequestTracking(): void {
        // Load recently processed requests
        this.loadProcessedRequests();

        // Start cleanup interval
        this.requestCleanupInterval = setInterval(() => {
            this.cleanupProcessedRequests();
        }, this.REQUEST_CLEANUP_INTERVAL);
    }

    private async loadProcessedRequests(): Promise<void> {
        try {
            const recentRequests = await this.getMemoriesWithFilter({
                roomId: stringToUuid(this.id),
                count: 1000,
                filter: {
                    type: "request_tracking",
                    targetAgent: this.runtime.agentType
                }
            });

            // Load into local cache
            for (const req of recentRequests) {
                const tracking = req.content as RequestTracking;
                if (tracking.requestStatus === "completed" || tracking.requestStatus === "failed") {
                    this.processedRequests.add(tracking.requestId);
                }
            }
        } catch (error) {
            elizaLogger.error("Error loading processed requests:", error);
        }
    }

    private async cleanupProcessedRequests(): Promise<void> {
        const now = Date.now();
        const cutoff = now - (24 * 60 * 60 * 1000); // 24 hours

        try {
            const oldRequests = await this.getMemoriesWithFilter({
                roomId: this.id,
                filter: {
                    type: "request_tracking",
                    targetAgent: this.runtime.agentType,
                    processedAt: { $lt: cutoff }
                }
            });

            // Remove old requests from tracking
            for (const req of oldRequests) {
                const tracking = req.content as RequestTracking;
                this.processedRequests.delete(tracking.requestId);
            }
        } catch (error) {
            elizaLogger.error("Error cleaning up processed requests:", error);
        }
    }

    protected async trackRequest(
        requestId: UUID,
        sourceType: string,
        metadata?: Record<string, unknown>
    ): Promise<void> {
        const tracking: RequestTracking = {
            type: "request_tracking",
            id: stringToUuid(`tracking-${requestId}`),
            requestId,
            sourceType,
            targetAgent: this.runtime.agentType,
            requestStatus: "pending",
            status: "pending_execution",  // Use standard ContentStatus
            createdAt: Date.now(),
            updatedAt: Date.now(),
            metadata,
            text: `Request tracking for ${sourceType}`,
            agentId: this.runtime.agentId
        };

        await this.runtime.messageManager.createMemory({
            id: tracking.id,
            content: tracking,
            roomId: this.id,
            userId: this.runtime.agentId,
            agentId: this.runtime.agentId
        });
    }

    protected async markRequestProcessing(requestId: UUID): Promise<void> {
        await this.updateRequestStatus(requestId, "processing");
    }

    protected async markRequestComplete(
        requestId: UUID,
        metadata?: Record<string, unknown>
    ): Promise<void> {
        await this.updateRequestStatus(requestId, "completed", metadata);
        this.processedRequests.add(requestId);
    }

    protected async markRequestFailed(
        requestId: UUID,
        error: string,
        metadata?: Record<string, unknown>
    ): Promise<void> {
        await this.updateRequestStatus(requestId, "failed", { ...metadata, error });
        this.processedRequests.add(requestId);
    }

    private async updateRequestStatus(
        requestId: UUID,
        requestStatus: RequestTracking["requestStatus"],
        metadata?: Record<string, unknown>
    ): Promise<void> {
        const tracking = await this.getRequestTracking(requestId);
        if (!tracking) return;

        const updatedTracking: RequestTracking = {
            ...tracking,
            requestStatus,
            status: requestStatus === "failed" ? "failed" : 
                   requestStatus === "completed" ? "executed" :
                   requestStatus === "processing" ? "executing" : "pending_execution",
            processedAt: Date.now(),
            updatedAt: Date.now(),
            metadata: {
                ...tracking.metadata,
                ...metadata
            }
        };

        await this.runtime.messageManager.createMemory({
            id: tracking.id,
            content: updatedTracking,
            roomId: this.id,
            userId: this.runtime.agentId,
            agentId: this.runtime.agentId
        });
    }

    private async getRequestTracking(requestId: UUID): Promise<RequestTracking | null> {
        const memories = await this.getMemoriesWithFilter({
            roomId: stringToUuid(this.id),
            count: 1,
            filter: {
                type: "request_tracking",
                requestId,
                targetAgent: this.runtime.agentType
            }
        });

        if (memories.length === 0) return null;
        return memories[0].content as RequestTracking;
    }

    protected async hasProcessedRequest(requestId: UUID): Promise<boolean> {
        // First check local cache
        if (this.processedRequests.has(requestId)) {
            return true;
        }

        // Then check database
        const tracking = await this.getRequestTracking(requestId);
        if (tracking && (tracking.requestStatus === "completed" || tracking.requestStatus === "failed")) {
            this.processedRequests.add(requestId);
            return true;
        }

        return false;
    }
}