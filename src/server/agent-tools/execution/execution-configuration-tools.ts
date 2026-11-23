import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { createExecutionEnvironment, executionBackendDefaults } from "../../../shared/execution-configuration-defaults.js";
import {
  type ConfigurationBackend, type ConfigurationDocument, type ConfigurationEnvironment,
  type ConfigurationRuntimeState, type ConfigurationSnapshot, type ConfigurationTarget,
} from "../../../shared/protocol/configuration-admin.js";
import {
  environmentVariableNameSchema, environmentVariableBindingSchema, environmentVariableOverridesSchema,
  type ConfiguredEnvironmentVariables, type EnvironmentVariableOverrides,
} from "../../../shared/protocol/environment-variables.js";
import { configurationFingerprint } from "../../config/configuration-fingerprint.js";
import type { ConfigurationAdminService } from "../../configuration-admin/configuration-admin-service.js";
import type { ConfigurationCommandScopeFacts } from "../../configuration-admin/configuration-command-receipt.js";
import { deriveConnectionProfileId } from "../../db/connection-profile-id.js";
import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import type { ExecutionManagementAccess } from "../application/execution-management-access.js";
import type { TrustedToolInvocationContext } from "../contracts/agent-tool-contracts.js";
import { compileCanonicalAgentToolSchema, type CanonicalSchemaValidator } from "../schema/canonical-json-schema.js";
import {
  describeProviderFields, executionBackendKinds, executionConfigurationSchemas,
  type ExecutionConfigurationOperation,
} from "./execution-configuration-contracts.js";
import { presentExecutionRuntime } from "./execution-runtime-presentation.js";

type ObjectValue = Record<string, unknown>;
interface ConnectionMapping { readonly configurationTargetId: string; readonly targetId: string }
export interface ExecutionConfigurationMutationResult {
  readonly revision: number;
  readonly environmentId?: string;
  readonly backendId?: string;
  readonly connections?: readonly ConnectionMapping[];
  readonly changedSettings: readonly string[];
  readonly effectsScope: "current_command";
  readonly effectsOmitted: number;
  readonly runtimes: readonly ReturnType<typeof presentExecutionRuntime>[];
}
interface Change {
  readonly configuration: ConfigurationDocument;
  readonly scopeFacts: ConfigurationCommandScopeFacts;
  readonly environmentId?: string;
  readonly backendId?: string;
  readonly connectionIds?: readonly string[];
  readonly changedSettings: readonly string[];
}
const validators = new Map<ExecutionConfigurationOperation, CanonicalSchemaValidator<ObjectValue>>();

/** Delegated operations use the same desired-state service as Settings. No tool
 * performs provider I/O or writes configuration tables independently. */
export class ExecutionConfigurationTools {
  constructor(readonly options: {
    readonly configuration: () => ConfigurationAdminService;
    readonly access: ExecutionManagementAccess;
  }) {}

  async execute(context: TrustedToolInvocationContext, operation: ExecutionConfigurationOperation, value: unknown): Promise<unknown> {
    const scope = this.options.access.assertCaller(context, operation);
    let validator = validators.get(operation);
    if (!validator) {
      validator = compileCanonicalAgentToolSchema<ObjectValue>(executionConfigurationSchemas[operation].input);
      validators.set(operation, validator);
    }
    if (!validator.check(value)) throw new DomainError("bad_request", "The execution management request does not match its typed schema.");
    const input = value;
    this.options.access.revalidate(context, operation, input);
    try {
      if (operation === "backend.options") return await this.#options(context, scope, input);
      if (operation === "environment.get" || operation === "backend.get" || operation === "backend.list" || operation === "execution.defaults.get") {
        return await this.#read(context, scope, operation, input);
      }
      return await this.#mutate(context, scope, operation, input);
    } catch (error) {
      // Zod errors can contain submitted literal values. Retain a bounded
      // actionable validation category; never expose their raw issue payloads.
      if (error instanceof ZodError) throw new DomainError("bad_request", "The resulting execution settings are invalid. Check required fields, protected variable names, provider restrictions and connection defaults.");
      throw error;
    }
  }

  async #read(context: TrustedToolInvocationContext, scope: RequestScope, operation: ExecutionConfigurationOperation, input: ObjectValue): Promise<unknown> {
    if (operation === "environment.get") this.options.access.environment(context, String(input.environmentId));
    else if (operation === "backend.get") this.options.access.backend(context, String(input.backendId));
    else if (operation === "execution.defaults.get") this.options.access.principal(context);
    const snapshot = await this.options.configuration().get(scope);
    const document = snapshot.configuration;
    if (operation === "environment.get") {
      const environment = requireEnvironment(document, String(input.environmentId));
      return {revision:snapshot.revision,environment:withVariableEntries(environment),runtime:runtime(snapshot,"environment",environment.id)};
    }
    if (operation === "backend.get") {
      const backend = requireBackend(document, String(input.backendId));
      const targets = backendTargets(document,backend.id);
      return {revision:snapshot.revision,environmentId:targets[0]!.executionEnvironmentId,backend:withVariableEntries(backend),
        connections:targets.map(target=>connectionDetails(scope,target)),runtime:runtime(snapshot,"backend",backend.id)};
    }
    if (operation === "execution.defaults.get") {
      const target = document.defaultTargetId === null ? undefined : document.targets.find(item=>item.id===document.defaultTargetId);
      return {revision:snapshot.revision,connection:target ? {...connectionMapping(scope,target.id),backendId:target.backendInstanceId,environmentId:target.executionEnvironmentId} : null};
    }
    const admitted = new Set(context.environmentAuthority.targetEnvironmentIds);
    return {revision:snapshot.revision,items:document.backends.flatMap(backend=>{
      const targets=backendTargets(document,backend.id);
      const environmentId=targets[0]!.executionEnvironmentId;
      if(!admitted.has(environmentId) || input.environmentId !== undefined && input.environmentId !== environmentId) return [];
      return [{id:backend.id,label:backend.label,kind:backend.kind,enabled:backend.enabled,environmentId,
        connections:targets.map(target=>({...connectionMapping(scope,target.id),label:target.label,enabled:target.enabled}))}];
    })};
  }

  async #options(context: TrustedToolInvocationContext, scope: RequestScope, input: ObjectValue): Promise<unknown> {
    const id = input.environmentId === undefined ? context.defaults.environmentId : String(input.environmentId);
    this.options.access.environment(context,id);
    const service=this.options.configuration();
    await service.options.authorize(scope,"read");
    const environment=requireEnvironment(service.repository.get(scope).configuration,id);
    const providers=executionBackendKinds.filter(kind=>input.kind===undefined||kind===input.kind).map(kind=>{
      const {id:_id,environmentVariables:_variables,...backendDefaults}=executionBackendDefaults[kind].createBackend("defaults");
      const {id:_targetId,backendInstanceId:_backendId,executionEnvironmentId:_environmentId,...connectionDefaults}=executionBackendDefaults[kind].createTarget("defaults","defaults",id);
      const reason=!service.options.projection.protocolReleases[kind] ? "This provider is not installed in the Sedes server."
        : providerIncompatibility(kind,environment);
      return {kind,supported:reason===undefined,...(reason?{reason}:{}),backendDefaults,connectionDefaults,fields:describeProviderFields(kind),
        immutableFields:["kind","executionEnvironmentId",...nativeIdentityFields(kind)]};
    });
    return {providers};
  }

  async #mutate(context: TrustedToolInvocationContext, scope: RequestScope, operation: ExecutionConfigurationOperation, input: ObjectValue): Promise<ExecutionConfigurationMutationResult> {
    if(context.subject.kind!=="thread_agent") throw new DomainError("not_found","The source thread is unavailable.");
    return this.options.configuration().saveCommand(scope,{
      mutationId:String(input.mutationId),expectedRevision:Number(input.expectedRevision),
      identity:{toolId:operation,sourceThreadId:context.subject.sourceThreadId,inputDigest:configurationFingerprint(input)},
      authorize:facts=>{
        this.options.access.assertCaller(context,operation);
        if(facts.crossEnvironment) this.options.access.principal(context);
        this.options.access.retained(context,facts.environmentIds.map(environmentId=>({kind:"environment",id:environmentId,environmentId})));
      },
      build:snapshot=>{
        const change=this.#change(context,operation,input,snapshot.configuration);
        return {configuration:change.configuration,scopeFacts:change.scopeFacts,
          present:committed=>presentExecutionConfigurationMutation(scope,committed,change)};
      },
    });
  }

  #change(context: TrustedToolInvocationContext, operation: ExecutionConfigurationOperation, input: ObjectValue, previous: ConfigurationDocument): Change {
    const configuration=structuredClone(previous);
    const environmentFacts=(id:string):ConfigurationCommandScopeFacts=>({environmentIds:[id],crossEnvironment:false});
    if(operation==="environment.create") {
      this.options.access.principal(context);
      const request=record(input.environment);
      const kind=request.kind as "local"|"ssh";
      const environment=editVariables(createExecutionEnvironment(kind,randomUUID()),request) as ConfigurationEnvironment;
      configuration.executionEnvironments.push(environment);
      return {configuration,scopeFacts:{environmentIds:[],crossEnvironment:true},environmentId:environment.id,changedSettings:["environment"]};
    }
    if(operation.startsWith("environment.")) {
      const id=String(input.environmentId);
      this.options.access.environment(context,id);
      const before=requireEnvironment(previous,id);
      const after=operation==="environment.remove" ? undefined : editVariables(before,operation==="environment.rename"?{label:input.label}:record(input.changes)) as ConfigurationEnvironment;
      this.options.access.sourceEnvironmentChange(context,before,after);
      if(operation==="environment.remove"&&previous.targets.some(target=>target.executionEnvironmentId===id))
        throw new DomainError("conflict","Remove this environment's backends before removing the environment.");
      configuration.executionEnvironments=configuration.executionEnvironments.flatMap(item=>item.id!==id?[item]:after?[after]:[]);
      return {configuration,scopeFacts:environmentFacts(id),environmentId:id,changedSettings:operation==="environment.configure"?changedNames(record(input.changes)):operation==="environment.rename"?["label"]:["removed"]};
    }
    if(operation==="execution.defaults.update") {
      this.options.access.principal(context);
      const id=input.configurationTargetId as string|null;
      const target=id===null?undefined:configuration.targets.find(item=>item.id===id);
      if(id!==null&&!target) notFound();
      if(target) this.options.access.environment(context,target.executionEnvironmentId);
      configuration.defaultTargetId=id;
      return {configuration,scopeFacts:{environmentIds:target?[target.executionEnvironmentId]:[],crossEnvironment:true},
        ...(target?{environmentId:target.executionEnvironmentId,backendId:target.backendInstanceId,connectionIds:[target.id]}:{}),changedSettings:["defaultTargetId"]};
    }
    if(operation==="backend.create") {
      const environmentId=String(input.environmentId);
      this.options.access.environment(context,environmentId);
      requireEnvironment(configuration,environmentId);
      const request=record(input.backend);
      const kind=request.kind as ConfigurationBackend["kind"];
      const defaults=executionBackendDefaults[kind];
      const backend=editVariables(defaults.createBackend(randomUUID()),request) as ConfigurationBackend;
      const target=mergeSettings(defaults.createTarget(randomUUID(),backend.id,environmentId),record(input.connection??{})) as ConfigurationTarget;
      if(!backend.enabled&&input.connection===undefined) target.enabled=false;
      else if(!backend.enabled&&record(input.connection??{}).enabled===undefined) target.enabled=false;
      configuration.backends.push(backend);configuration.targets.push(target);
      return {configuration,scopeFacts:environmentFacts(environmentId),environmentId,backendId:backend.id,connectionIds:[target.id],changedSettings:["backend","connections"]};
    }
    const id=String(input.backendId);
    this.options.access.backend(context,id);
    const before=requireBackend(previous,id);
    const targets=backendTargets(previous,id);
    const environmentId=targets[0]!.executionEnvironmentId;
    const changes=operation==="backend.rename"?{label:input.label}:record(input.changes??{});
    const after=operation==="backend.remove"?undefined:editVariables(before,changes) as ConfigurationBackend;
    if(!after) {
      if(targets.some(target=>target.id===configuration.defaultTargetId)) throw new DomainError("conflict","Change or clear the account default connection before removing this backend.");
      configuration.targets=configuration.targets.filter(target=>target.backendInstanceId!==id);
    } else if(operation==="backend.configure"&&input.connections!==undefined) {
      configuration.targets=editConnections(configuration,id,environmentId,before.kind,record(input.connections));
    }
    this.options.access.sourceBackendChange(context,before,after,previous.targets,configuration.targets);
    configuration.backends=configuration.backends.flatMap(item=>item.id!==id?[item]:after?[after]:[]);
    return {configuration,scopeFacts:environmentFacts(environmentId),environmentId,backendId:id,
      connectionIds:(after?configuration.targets.filter(target=>target.backendInstanceId===id):targets).map(target=>target.id),
      changedSettings:operation==="backend.remove"?["removed"]:[...changedNames(changes),...(input.connections!==undefined?["connections"]:[])]};
  }
}

function providerIncompatibility(kind: ConfigurationBackend["kind"], environment:ConfigurationEnvironment):string|undefined {
  if(kind==="grok_build"&&environment.kind!=="local") return "Grok requires a local execution environment.";
  if(kind==="opencode"&&environment.kind==="outbound"&&environment.platform!=="linux") return "OpenCode requires a Linux execution host.";
  if(["pi_native","claude_agent_sdk","antigravity"].includes(kind)&&environment.kind==="outbound"&&environment.platform==="win32") return "This provider requires a Linux or macOS execution host.";
  if(kind==="pi"&&environment.kind!=="local"&&(environment.operations.kind!=="sidecar"||!environment.operations.enabledCapabilities.includes("workspace_tools"))) return "Remote Pi SDK requires workspace tools and context capabilities.";
  return undefined;
}
function nativeIdentityFields(kind:ConfigurationBackend["kind"]):string[] {
  if(kind==="codex_app_server") return ["moduleConfiguration.connection.channel.type","moduleConfiguration.connection.channel.codexHome","moduleConfiguration.connection.channel.socketPath","moduleConfiguration.connection.channel.url"];
  if(kind==="claude_agent_sdk") return ["moduleConfiguration.configDirectory"];
  if(kind==="opencode") return ["moduleConfiguration.nativeStorePath"];
  return [];
}
function record(value:unknown):ObjectValue { return value!==null&&typeof value==="object"&&!Array.isArray(value)?value as ObjectValue:{}; }
function requireEnvironment(document:ConfigurationDocument,id:string):ConfigurationEnvironment {return document.executionEnvironments.find(item=>item.id===id)??notFound();}
function requireBackend(document:ConfigurationDocument,id:string):ConfigurationBackend {return document.backends.find(item=>item.id===id)??notFound();}
function backendTargets(document:ConfigurationDocument,id:string):ConfigurationTarget[] {
  const targets=document.targets.filter(target=>target.backendInstanceId===id);
  if(targets.length===0) notFound();
  return targets;
}
function notFound():never {throw new DomainError("not_found","The requested execution resource was not found.");}
function connectionMapping(scope:RequestScope,id:string):ConnectionMapping {return {configurationTargetId:id,targetId:deriveConnectionProfileId(scope.tenantId,scope.principalId,id)};}
function connectionDetails(scope:RequestScope,target:ConfigurationTarget) {
  const {id,backendInstanceId:_backendId,executionEnvironmentId:_environmentId,...rest}=target;
  return {...rest,...connectionMapping(scope,id)};
}
function runtime(snapshot:ConfigurationSnapshot,kind:ConfigurationRuntimeState["resourceKind"],id:string) {
  const found=snapshot.runtimes.find(item=>item.resourceKind===kind&&item.resourceId===id);
  return found?presentExecutionRuntime(found):null;
}
function withVariableEntries<T extends {environmentVariables?:ConfiguredEnvironmentVariables}>(resource:T) {
  return {...resource,...(resource.environmentVariables?{environmentVariables:{
    execution:Object.entries(resource.environmentVariables.execution).map(([name,binding])=>({name,binding})),
    startup:Object.entries(resource.environmentVariables.startup).map(([name,binding])=>({name,binding})),
  }}:{})};
}
/** Closed schema admits only declared properties, and the completed document
 * goes through its existing full validator before any durable mutation. */
export function mergeSettings(current:unknown,patch:unknown):unknown {
  if(patch===null||typeof patch!=="object"||Array.isArray(patch)) return structuredClone(patch);
  const edits=record(patch),before=record(current);
  const changedVariant=["kind","type","ownership","source"].some(key=>edits[key]!==undefined&&before[key]!==undefined&&edits[key]!==before[key]);
  const result:ObjectValue=changedVariant?{}:structuredClone(before);
  for(const [key,value] of Object.entries(edits)) {
    if(value===null) delete result[key];
    else result[key]=mergeSettings(result[key],value);
  }
  return result;
}
function editVariables<T extends {environmentVariables?:ConfiguredEnvironmentVariables}>(current:T,patch:ObjectValue):T {
  const {environmentVariables,...settings}=patch;
  const result=mergeSettings(current,settings) as T;
  if(environmentVariables!==undefined) {
    const edits=record(environmentVariables);
    const before=current.environmentVariables??{execution:{},startup:{}};
    result.environmentVariables={execution:editVariableMap(before.execution,edits.execution),startup:editVariableMap(before.startup,edits.startup)};
  }
  return result;
}
function editVariableMap(current:EnvironmentVariableOverrides,changes:unknown):EnvironmentVariableOverrides {
  if(changes===undefined) return structuredClone(current);
  const edits=record(changes),set=(edits.set??[]) as ObjectValue[],remove=(edits.remove??[]) as string[];
  const touched=new Set<string>();
  for(const name of [...set.map(item=>String(item.name)),...remove]) {
    environmentVariableNameSchema.parse(name);
    if(touched.has(name.toUpperCase())) throw new DomainError("bad_request","A variable name may occur only once in a map edit, ignoring case.");
    touched.add(name.toUpperCase());
  }
  const remaining=Object.entries(current).filter(([name])=>!touched.has(name.toUpperCase()));
  const updates=set.map(item=>[String(item.name),environmentVariableBindingSchema.parse(item.binding)] as const);
  return environmentVariableOverridesSchema.parse(Object.fromEntries([...remaining,...updates]));
}
function editConnections(document:ConfigurationDocument,backendId:string,environmentId:string,kind:ConfigurationBackend["kind"],edits:ObjectValue):ConfigurationTarget[] {
  const updates=(edits.update??[]) as ObjectValue[],removals=(edits.remove??[]) as string[],creates=(edits.create??[]) as ObjectValue[];
  const touched=new Set<string>();
  for(const id of [...updates.map(item=>String(item.configurationTargetId)),...removals]) {
    if(touched.has(id)) throw new DomainError("bad_request","A connection may occur only once in an edit.");
    touched.add(id);
    const target=document.targets.find(item=>item.id===id);
    if(!target||target.backendInstanceId!==backendId) notFound();
  }
  if(document.defaultTargetId&&removals.includes(document.defaultTargetId)) throw new DomainError("conflict","Change or clear the account default connection before removing it.");
  return [...document.targets.filter(target=>!removals.includes(target.id)).map(target=>{
    const patch=updates.find(item=>item.configurationTargetId===target.id);
    return patch?mergeSettings(target,patch.changes) as ConfigurationTarget:target;
  }),...creates.map(patch=>mergeSettings(executionBackendDefaults[kind].createTarget(randomUUID(),backendId,environmentId),patch) as ConfigurationTarget)];
}
function changedNames(changes:ObjectValue):string[] {return Object.keys(changes).sort();}


/** Value-free command receipts have a smaller durable budget than detail reads.
 * Keep the saved runtime states and only effects changed by this command. Large
 * bulk edits explicitly report omitted effects, rather than fail an otherwise
 * valid configuration transaction or imply complete pending-state coverage. */
export function presentExecutionConfigurationMutation(scope: RequestScope, snapshot: ConfigurationSnapshot,
  change: Pick<Change, "environmentId" | "backendId" | "connectionIds" | "changedSettings">): ExecutionConfigurationMutationResult {
  const result = {
    revision: snapshot.revision,
    ...(change.environmentId ? { environmentId: change.environmentId } : {}),
    ...(change.backendId ? { backendId: change.backendId } : {}),
    ...(change.connectionIds ? { connections: change.connectionIds.map(id => connectionMapping(scope, id)) } : {}),
    changedSettings: change.changedSettings,
    effectsScope: "current_command" as const,
    effectsOmitted: 0,
    runtimes: snapshot.runtimes.filter(item => item.resourceKind === "backend"
      ? item.resourceId === change.backendId : item.resourceId === change.environmentId).map(item => {
      const { effects, ...state } = presentExecutionRuntime(item);
      return { ...state, effects: (effects ?? []).filter(effect => effect.desiredRevision === snapshot.revision)
        .map(({ component, subjectId, desiredRevision, effectiveRevision, state: effectState }) =>
          ({ component, subjectId, desiredRevision, effectiveRevision, state: effectState })) };
    }),
  };
  const maximumBytes = 60 * 1024; // Leave headroom within the persisted 64 KiB result limit.
  let size = Buffer.byteLength(JSON.stringify(result), "utf8");
  while (size > maximumBytes) {
    const selected = result.runtimes.reduce<typeof result.runtimes[number] | undefined>((longest, candidate) =>
      !longest || candidate.effects.length > longest.effects.length ? candidate : longest, undefined);
    if (!selected?.effects.length) throw new DomainError("bad_request", "The configuration mutation summary exceeds its receipt limit.");
    const remove = Math.min(selected.effects.length, Math.max(1, Math.ceil(selected.effects.length * (1 - maximumBytes / size))));
    selected.effects.splice(selected.effects.length - remove, remove);
    result.effectsOmitted += remove;
    size = Buffer.byteLength(JSON.stringify(result), "utf8");
  }
  return result;
}
