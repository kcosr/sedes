import { randomUUID } from "node:crypto";
import { connect, createServer, type Socket } from "node:net";
import { LengthPrefixedSidecarFrameTransport, SidecarOperationRegistry, SidecarProtocolPeer,
  controlHelloOperation, registerControlV2Operations } from "../../src/internal/sidecar-protocol/index.js";
import { SidecarRuntimeChannel } from "../../src/server/sidecar/runtime-channel.js";
import { sidecarSocketByteStream } from "../../src/server/sidecar/sidecar-socket-byte-stream.js";

/** Both sides exchange production length-prefixed protocol bytes over a fresh
 * local socket standing in for the SSH stdio carrier. Provider-independent. */
export async function createSidecarFramedCarrier() {
  let accept!: (socket: Socket) => void;
  const accepted = new Promise<Socket>((resolve) => { accept = resolve; });
  const server = createServer(accept);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test_socket_missing");
  const clientSocket = connect(address.port, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    clientSocket.once("connect", resolve);
    clientSocket.once("error", reject);
  });
  const serverSocket = await accepted;
  clientSocket.setNoDelay(true);
  serverSocket.setNoDelay(true);
  const sessionNonce = randomUUID().replaceAll("-", "").repeat(2);
  const mainRegistry = new SidecarOperationRegistry();
  const hostRegistry = new SidecarOperationRegistry();
  const makeTransport = (socket: Socket) => new LengthPrefixedSidecarFrameTransport({
    stream: sidecarSocketByteStream(socket),
    assurance: { kind: "test-ssh-byte-carrier", carrierGeneration: 1 },
  });
  const mainPeer = new SidecarProtocolPeer({ role: "sedes", transport: makeTransport(clientSocket), sessionNonce, registry: mainRegistry });
  const hostPeer = new SidecarProtocolPeer({ role: "sidecar", transport: makeTransport(serverSocket), sessionNonce, registry: hostRegistry });
  const mainChannel = new SidecarRuntimeChannel(mainPeer, mainRegistry);
  const hostChannel = new SidecarRuntimeChannel(hostPeer, hostRegistry);
  let closePromise: Promise<void> | undefined;
  return {
    mainPeer, hostPeer, mainChannel, hostChannel, mainRegistry, hostRegistry,
    async start(options: Pick<Parameters<typeof registerControlV2Operations>[1], "prepareSedesCapabilities"> = {}) {
      const capabilities = hostRegistry.capabilities().map(({ capabilityId, majorVersion }) => ({ capabilityId, majorVersion }));
      registerControlV2Operations(hostRegistry, {
        buildId: "persistent-runtime-test", artifactSha256: "a".repeat(64),
        enabledSidecarCapabilities: capabilities, enabledSedesCapabilities: mainRegistry.capabilities(), ...options,
      });
      mainPeer.start(); hostPeer.start();
      await mainPeer.call(controlHelloOperation, {
        expectedBuildId: "persistent-runtime-test", expectedArtifactSha256: "a".repeat(64),
        authorizedSidecarCapabilities: capabilities, offeredSedesCapabilities: mainRegistry.capabilities(),
      });
    },
    close() {
      return closePromise ??= (async () => {
        mainChannel.close(); hostChannel.close();
        await Promise.all([mainPeer.close("test_carrier_replaced"), hostPeer.close("test_carrier_replaced")]);
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      })();
    },
  };
}

