import { z } from "zod";
import {
  configurationBackendSchema, configurationEnvironmentSchema, configurationRuntimeStateSchema,
  configurationTargetSchema,
} from "../../../shared/protocol/configuration-admin.js";
import { environmentVariableBindingSchema } from "../../../shared/protocol/environment-variables.js";
import {
  AGENT_TOOL_JSON_SCHEMA_DIALECT, type CanonicalAgentToolRootSchema,
  type CanonicalAgentToolSchema, type CanonicalObjectSchema,
} from "../schema/canonical-json-schema.js";

export const executionBackendKinds = ["pi", "pi_native", "codex_app_server", "claude_agent_sdk", "grok_build", "opencode", "antigravity"] as const;
const string = (maxLength: number, minLength = 1): CanonicalAgentToolSchema => ({ type: "string", minLength, maxLength });
const enumeration = (values: readonly string[]): CanonicalAgentToolSchema => ({ type: "string", enum: values, maxLength: Math.max(...values.map(value => value.length)), minLength: 1 });
const boolean: CanonicalAgentToolSchema = { type: "boolean" };
const nullable = (schema: CanonicalAgentToolSchema): CanonicalAgentToolSchema => ({ anyOf: [schema, {type: "null"}] });
const array = (items: CanonicalAgentToolSchema, maxItems: number, minItems = 0): CanonicalAgentToolSchema => ({type: "array", items, minItems, maxItems});
const object = (properties: Record<string, CanonicalAgentToolSchema>, required: readonly string[] = Object.keys(properties), description?: string): CanonicalObjectSchema => ({
  type: "object", properties, required, additionalProperties: false, maxProperties: Object.keys(properties).length, ...(description ? {description} : {}),
});
const root = (schema: CanonicalObjectSchema): CanonicalAgentToolRootSchema => ({$schema: AGENT_TOOL_JSON_SCHEMA_DIALECT, ...schema});
export const executionRevisionSchema: CanonicalAgentToolSchema = {type:"integer", minimum:0, maximum:Number.MAX_SAFE_INTEGER};
const identifier = string(128);
const uuid = string(36);
const label = string(120);
const mutation = {mutationId: uuid, expectedRevision: executionRevisionSchema};

type JsonSchema = Record<string, unknown>;
/** Finite projection into the shared cross-adapter subset. Full domain parsing
 * retains refinements (paths, names, identity and provider constraints). Never
 * admits an open object/map or an opaque unvalidated JSON payload. */
export function administrationSchema(schema: z.ZodType, variables?: CanonicalAgentToolSchema): CanonicalAgentToolSchema {
  const convert = (source: JsonSchema): CanonicalAgentToolSchema => {
    const alternatives = source.anyOf ?? source.oneOf;
    if (Array.isArray(alternatives)) return {anyOf: alternatives.map(entry => convert(entry as JsonSchema))};
    if (source.type === "object") {
      if (source.additionalProperties !== false) throw new Error("execution_schema_open_object");
      const properties = Object.fromEntries(Object.entries(source.properties as Record<string, JsonSchema> ?? {}).map(([key, value]) =>
        [key, key === "environmentVariables" && variables ? variables : convert(value)]));
      return object(properties, source.required as string[] ?? []);
    }
    if (source.type === "array") {
      const prefix = source.prefixItems as JsonSchema[] | undefined;
      const items = prefix ? prefix.length === 1 ? convert(prefix[0]!) : {anyOf: prefix.map(convert)} : convert(source.items as JsonSchema);
      const maximum = source.maxItems ?? prefix?.length;
      if (typeof maximum !== "number") throw new Error("execution_schema_unbounded_array");
      return array(items, maximum, Number(source.minItems ?? prefix?.length ?? 0));
    }
    if (source.type === "string") {
      const choices = typeof source.const === "string" ? [source.const] : source.enum as string[] | undefined;
      return { type: "string", minLength: Number(source.minLength ?? (choices ? Math.min(...choices.map(value => value.length)) : 0)),
        maxLength: Number(source.maxLength ?? (choices ? Math.max(...choices.map(value => value.length)) : 4096)), ...(choices ? {enum: choices} : {}) };
    }
    if (source.type === "integer" || source.type === "number") return {type: source.type,
      minimum: Number(source.minimum ?? -Number.MAX_SAFE_INTEGER), maximum: Number(source.maximum ?? Number.MAX_SAFE_INTEGER)};
    if (source.type === "boolean" || source.type === "null") return {type: source.type};
    throw new Error("execution_schema_unsupported_node");
  };
  return convert(z.toJSONSchema(schema, {io:"input"}) as JsonSchema);
}

const variableEntry = object({name: string(128), binding: administrationSchema(environmentVariableBindingSchema)});
const variableEntries = array(variableEntry, 64);
export const configuredVariablesSchema = object({execution: variableEntries, startup: variableEntries});
const variableEdits = object({set: variableEntries, remove: array(string(128), 64)}, [],
  "Named set/remove operations preserve omitted variables. A set supplies the complete binding; remove restores inheritance; an unset binding masks inheritance.");
export const configuredVariableEditsSchema = object({execution: variableEdits, startup: variableEdits}, [],
  "Omitted maps and names are preserved. Literal values are returned only by authorized detail reads, never mutation receipts.");

/** Patches keep nested omissions. Null clears an originally optional field.
 * Runtime merge replaces a discriminated subobject when its discriminator
 * changes; the complete resulting variant must pass the existing validator. */
function partial(schema: CanonicalAgentToolSchema): CanonicalAgentToolSchema {
  if ("anyOf" in schema) return {anyOf: schema.anyOf.map(partial)};
  if (schema.type !== "object") return schema;
  const properties = Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => {
    const next = partial(value);
    return [key, schema.required.includes(key) ? next : {...nullable(next), description:"Null clears this optional setting; omission preserves it."}];
  }));
  return object(properties, [], "Partial nested settings preserve omitted fields. Supplied arrays replace only that array. Changing a discriminator requires a complete valid replacement of that subobject.");
}
function variants(schema: CanonicalAgentToolSchema): CanonicalObjectSchema[] {
  return "anyOf" in schema ? schema.anyOf as CanonicalObjectSchema[] : [schema as CanonicalObjectSchema];
}
function omit(schema: CanonicalObjectSchema, keys: readonly string[]): CanonicalObjectSchema {
  return object(Object.fromEntries(Object.entries(schema.properties).filter(([key])=>!keys.includes(key))), schema.required.filter(key=>!keys.includes(key)));
}
function union(schemas: CanonicalAgentToolSchema[]): CanonicalAgentToolSchema { const unique=[...new Map(schemas.map(schema=>[JSON.stringify(schema),schema])).values()]; return unique.length===1?unique[0]!:{anyOf:unique}; }
const backendFull = administrationSchema(configurationBackendSchema, configuredVariablesSchema);
const targetFull = administrationSchema(configurationTargetSchema);
const environmentFull = administrationSchema(configurationEnvironmentSchema, configuredVariablesSchema);
const targetVariants = variants(targetFull);
const backendVariants = variants(backendFull);
const environmentVariants = variants(environmentFull);

const backendChanges = union(backendVariants.map(variant => {
  const patch = partial(omit(variant,["id", "environmentVariables"])) as CanonicalObjectSchema;
  return object({...patch.properties, environmentVariables: configuredVariableEditsSchema}, []);
}));
const backendCreate = union(variants(backendChanges).map(variant => object(variant.properties,["kind","label"])));
const environmentChanges = union(environmentVariants.map(variant => {
  const patch = partial(omit(variant,["id", "kind", "hostAlias", "pairingId", "platform", "environmentVariables"])) as CanonicalObjectSchema;
  return object({...patch.properties, environmentVariables: configuredVariableEditsSchema}, []);
}));
const environmentCreate = union(environmentVariants.filter(variant => (variant.properties.kind as {enum?:readonly string[]}).enum?.[0] !== "outbound").map(variant => {
  const patch = partial(omit(variant,["id","environmentVariables"])) as CanonicalObjectSchema;
  const required = ["kind", "label", "workspaceRoots", ...("hostAlias" in patch.properties ? ["hostAlias"] : [])];
  return object({...patch.properties,environmentVariables: configuredVariableEditsSchema}, required);
}));
const connectionChanges = union(targetVariants.map(variant => partial(omit(variant,["id","backendInstanceId","executionEnvironmentId","kind"]))));
const connectionCreate = union(variants(connectionChanges).map(variant => object(variant.properties,["label"])));
const connectionEdits = object({
  create: array(connectionCreate,64),
  update: array(object({configurationTargetId:identifier, changes:connectionChanges}),64),
  remove: array(identifier,64),
}, [], "ID-addressed updates/removals preserve omitted connections; create supplies a label and any required provider settings. IDs are allocated by Sedes. Removing the selected account default requires clearing/changing it first.");
const connectionMapping = object({configurationTargetId:identifier,targetId:uuid});
const connections = array(connectionMapping,64);
const connectionDetails = union(targetVariants.map(variant=> {
  const selected=omit(variant,["id","backendInstanceId","executionEnvironmentId"]);
  return object({...selected.properties,configurationTargetId:identifier,targetId:uuid}, [...selected.required,"configurationTargetId","targetId"]);
}));
const runtimeObject = administrationSchema(configurationRuntimeStateSchema) as CanonicalObjectSchema;
// Native diagnostics are intentionally not a detail/receipt channel. Existing
// normalized states/effects explain pending work without echoing provider output.
export const executionRuntimeSchema = omit(runtimeObject,["lastError"]);
const runtimes = array(executionRuntimeSchema,128);
const mutationResult = root(object({revision:executionRevisionSchema,environmentId:uuid,backendId:identifier,connections,
  changedSettings:array(string(256),256),runtimes, effectsScope:enumeration(["current_command"]), effectsOmitted:executionRevisionSchema},["revision","changedSettings","runtimes","effectsScope","effectsOmitted"],
  "Saved-state receipt. Runtime effects include only this command’s changed settings and omit detailed launch evidence. effectsOmitted counts additional changed effects excluded by the bounded receipt; inspect environment.get/backend.get for complete current effects."));
const defaults = object({configurationTargetId:identifier,targetId:uuid,backendId:identifier,environmentId:uuid});
const summary = object({id:identifier,label,kind:enumeration(executionBackendKinds),enabled:boolean,environmentId:uuid,connections:array(object({configurationTargetId:identifier,targetId:uuid,label,enabled:boolean}),64)});
const optionField = object({path:string(256),type:string(32),required:boolean,choices:array(string(240,0),64),maximumLength:executionRevisionSchema,maximumItems:executionRevisionSchema,clearable:boolean},["path","type","required","clearable"]);
// Defaults intentionally retain empty required installation paths, as Settings
// does. The fields table identifies the required inputs before creation.
function relaxedDefaults(schema: CanonicalAgentToolSchema): CanonicalAgentToolSchema {
  if("anyOf" in schema) return {anyOf:schema.anyOf.map(relaxedDefaults)};
  if(schema.type==="object") return object(Object.fromEntries(Object.entries(schema.properties).map(([k,v])=>[k,relaxedDefaults(v)])),schema.required);
  if(schema.type==="array") return {...schema,items:relaxedDefaults(schema.items),minItems:0};
  return schema.type==="string" && !schema.enum ? {...schema,minLength:0} : schema;
}
const providerOption = object({kind:enumeration(executionBackendKinds),supported:boolean,reason:string(512),
  backendDefaults:relaxedDefaults(union(backendVariants.map(variant=>omit(variant,["id","environmentVariables"])))),
  connectionDefaults:relaxedDefaults(union(targetVariants.map(variant=>omit(variant,["id","backendInstanceId","executionEnvironmentId"])))),
  fields:array(optionField,256),immutableFields:array(string(256),32)},["kind","supported","backendDefaults","connectionDefaults","fields","immutableFields"]);

/** Kept as canonical objects; registry normalization validates the shared finite
 * bounds and publishes the same schemas on every transport. */
export const executionConfigurationSchemas = {
  "environment.get": {input:root(object({environmentId:uuid})),output:root(object({revision:executionRevisionSchema,environment:environmentFull,runtime:nullable(executionRuntimeSchema)}))},
  "environment.create": {input:root(object({...mutation,environment:environmentCreate})),output:mutationResult},
  "environment.rename": {input:root(object({...mutation,environmentId:uuid,label})),output:mutationResult},
  "environment.configure": {input:root(object({...mutation,environmentId:uuid,changes:environmentChanges})),output:mutationResult},
  "environment.remove": {input:root(object({...mutation,environmentId:uuid})),output:mutationResult},
  "backend.list": {input:root(object({environmentId:uuid},[])),output:root(object({revision:executionRevisionSchema,items:array(summary,64)}))},
  "backend.get": {input:root(object({backendId:identifier})),output:root(object({revision:executionRevisionSchema,environmentId:uuid,backend:backendFull,connections:array(connectionDetails,64),runtime:nullable(executionRuntimeSchema)}))},
  "backend.options": {input:root(object({environmentId:uuid,kind:enumeration(executionBackendKinds)},[])),output:root(object({providers:array(providerOption,7)}))},
  "backend.create": {input:root(object({...mutation,environmentId:uuid,backend:backendCreate,connection:connectionChanges},[...Object.keys(mutation),"environmentId","backend"])),output:mutationResult},
  "backend.rename": {input:root(object({...mutation,backendId:identifier,label})),output:mutationResult},
  "backend.configure": {input:root(object({...mutation,backendId:identifier,changes:backendChanges,connections:connectionEdits},[...Object.keys(mutation),"backendId"])),output:mutationResult},
  "backend.remove": {input:root(object({...mutation,backendId:identifier})),output:mutationResult},
  "execution.defaults.get": {input:root(object({})),output:root(object({revision:executionRevisionSchema,connection:nullable(defaults)}))},
  "execution.defaults.update": {input:root(object({...mutation,configurationTargetId:nullable(identifier)})),output:mutationResult},
} as const;
export type ExecutionConfigurationOperation = keyof typeof executionConfigurationSchemas;

export function describeProviderFields(kind: typeof executionBackendKinds[number]) {
  const schema = backendVariants.find(item=>(item.properties.kind as {enum?:readonly string[]}).enum?.[0]===kind)!;
  const fields: {path:string;type:string;required:boolean;clearable:boolean;choices?:readonly string[];maximumLength?:number;maximumItems?:number}[]=[];
  const visit=(node:CanonicalAgentToolSchema,path:string,required:boolean)=>{
    if("anyOf" in node){ for(const alternative of node.anyOf) visit(alternative,path,required); return; }
    fields.push({path,type:node.type,required,clearable:!required,...(node.type==="string"?{maximumLength:node.maxLength,...(node.enum?{choices:node.enum}: {})}: {}),...(node.type==="array"?{maximumItems:node.maxItems}: {})});
    if(node.type==="object") for(const [key,value] of Object.entries(node.properties)) visit(value,path?`${path}.${key}`:key,node.required.includes(key));
  };
  for(const [key,value] of Object.entries(schema.properties)) if(!["id","environmentVariables"].includes(key)) visit(value,key,schema.required.includes(key));
  return fields;
}
