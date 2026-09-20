import { registerPlugin } from "@capacitor/core";

interface CredentialIdentity {
  readonly profileId: string;
  readonly serverUrl: string;
}
interface ClientCredentialsPlugin {
  getCredential(input: CredentialIdentity): Promise<{ readonly credential: string | null }>;
  setCredential(input: CredentialIdentity & { readonly credential: string }): Promise<void>;
  removeCredential(input: CredentialIdentity): Promise<void>;
  removeProfileCredentials(input: { readonly profileId: string }): Promise<void>;
}
const nativeCredentials = registerPlugin<ClientCredentialsPlugin>("ClientCredentials");
function identity(profileId: string, serverUrl: string): CredentialIdentity {
  const url = new URL(serverUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Invalid credential server origin.");
  }
  return { profileId, serverUrl: url.origin };
}
export async function getCredential(profileId: string, serverUrl: string): Promise<string | null> {
  return (await nativeCredentials.getCredential(identity(profileId, serverUrl))).credential;
}
export async function setCredential(profileId: string, serverUrl: string, credential: string): Promise<void> {
  await nativeCredentials.setCredential({ ...identity(profileId, serverUrl), credential });
}
export async function removeCredential(profileId: string, serverUrl: string): Promise<void> {
  await nativeCredentials.removeCredential(identity(profileId, serverUrl));
}

export async function removeProfileCredentials(profileId: string): Promise<void> {
  await nativeCredentials.removeProfileCredentials({ profileId });
}
