import { Action, Memory } from "./types";
import { elizaLogger } from "./index";

export type AgentType = "PROPOSAL" | "TREASURY" | "STRATEGY" | "USER";

export interface ActionDefinition {
    type: string;
    category: AgentType;
    handler: (content: any, runtime: any) => Promise<boolean>;
    validate: (content: any, runtime: any) => Promise<boolean>;
    allowedStatuses: string[];
    requiredPermissions?: string[];
    sideEffects?: string[];
    metadata: {
        name: string;
        description: string;
        examples: string[];
        similes?: string[];
    };
}

class ActionRegistry {
    private static instance: ActionRegistry;
    private actions: Map<string, ActionDefinition>;
    private agentActions: Map<AgentType, Set<string>>;
    private runtimeActions: Map<string, Action>;

    private constructor() {
        this.actions = new Map();
        this.agentActions = new Map();
        this.runtimeActions = new Map();
        const agentTypes: AgentType[] = ["PROPOSAL", "TREASURY", "STRATEGY", "USER"];
        agentTypes.forEach(type => {
            this.agentActions.set(type, new Set());
        });
    }

    public static getInstance(): ActionRegistry {
        if (!ActionRegistry.instance) {
            ActionRegistry.instance = new ActionRegistry();
        }
        return ActionRegistry.instance;
    }

    public registerAction(action: ActionDefinition): void {
        if (this.actions.has(action.type)) {
            elizaLogger.warn(`Action ${action.type} already registered. Skipping.`);
            return;
        }

        this.actions.set(action.type, action);
        const agentActions = this.agentActions.get(action.category);
        if (agentActions) {
            agentActions.add(action.type);
        }

        // Convert to runtime action format and register
        const runtimeAction: Action = {
            name: action.metadata.name,
            description: action.metadata.description,
            similes: action.metadata.similes || [],
            examples: [action.metadata.examples.map(example => ({
                user: "user",
                content: { text: example }
            }))],
            handler: async (runtime: any, message: Memory) => {
                return action.handler(message.content, runtime);
            },
            validate: async (runtime: any, message: Memory) => {
                return action.validate(message.content, runtime);
            }
        };
        this.runtimeActions.set(action.type, runtimeAction);

        elizaLogger.info(`Registered action ${action.type} for ${action.category}`);
    }

    public registerRuntimeAction(action: Action, agentType?: AgentType): void {
        const actionKey = action.name.toLowerCase();
        if (this.runtimeActions.has(actionKey)) {
            elizaLogger.warn(`Runtime action ${action.name} already registered. Skipping.`);
            return;
        }

        this.runtimeActions.set(actionKey, action);
        if (agentType) {
            const agentActions = this.agentActions.get(agentType);
            if (agentActions) {
                agentActions.add(actionKey);
            }
        }

        elizaLogger.info(`Registered runtime action ${action.name}${agentType ? ` for ${agentType}` : ''}`);
    }

    public getAction(type: string): ActionDefinition | undefined {
        return this.actions.get(type);
    }

    public getRuntimeAction(name: string): Action | undefined {
        return this.runtimeActions.get(name.toLowerCase());
    }

    public getActionsForAgent(agentType: AgentType): (ActionDefinition | Action)[] {
        const actionTypes = this.agentActions.get(agentType) || new Set();
        return Array.from(actionTypes).map(type => 
            this.actions.get(type) || this.runtimeActions.get(type)
        ).filter(Boolean);
    }

    public getAllRuntimeActions(): Action[] {
        return Array.from(this.runtimeActions.values());
    }

    public async validateAction(
        actionType: string,
        content: any,
        runtime: any
    ): Promise<{
        valid: boolean;
        reason?: string;
    }> {
        const action = this.actions.get(actionType);
        if (!action) {
            return {
                valid: false,
                reason: `Action ${actionType} not found`
            };
        }

        // Check if status is allowed
        if (!action.allowedStatuses.includes(content.status)) {
            return {
                valid: false,
                reason: `Status ${content.status} not allowed for action ${actionType}`
            };
        }

        try {
            const isValid = await action.validate(content, runtime);
            return {
                valid: isValid,
                reason: isValid ? undefined : 'Validation failed'
            };
        } catch (error) {
            return {
                valid: false,
                reason: `Validation error: ${error instanceof Error ? error.message : String(error)}`
            };
        }
    }

    public async executeAction(
        actionType: string,
        content: any,
        runtime: any
    ): Promise<{
        success: boolean;
        error?: string;
    }> {
        const action = this.actions.get(actionType);
        if (!action) {
            return {
                success: false,
                error: `Action ${actionType} not found`
            };
        }

        // Validate first
        const validation = await this.validateAction(actionType, content, runtime);
        if (!validation.valid) {
            return {
                success: false,
                error: validation.reason
            };
        }

        try {
            const result = await action.handler(content, runtime);
            return {
                success: result
            };
        } catch (error) {
            return {
                success: false,
                error: `Execution error: ${error instanceof Error ? error.message : String(error)}`
            };
        }
    }

    public clearRegistry(): void {
        this.actions.clear();
        const agentTypes: AgentType[] = ["PROPOSAL", "TREASURY", "STRATEGY", "USER"];
        agentTypes.forEach(type => {
            this.agentActions.set(type, new Set());
        });
    }
}

export const actionRegistry = ActionRegistry.getInstance(); 